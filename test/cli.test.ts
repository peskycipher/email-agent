import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

import type { MailboxAdapter } from "../src/adapter.ts";
import { runCli } from "../src/cli.ts";

function runCliProcess(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = childProcess.spawnSync("node", ["src/cli.ts", ...args], {
    cwd,
    encoding: "utf8"
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

test("cli supports --help and --version without mailbox config", async () => {
  const cwd = path.resolve(".");

  const help = runCliProcess(["--help"], cwd);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);

  const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));

  const version = runCliProcess(["--version"], cwd);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), pkg.version);
});

test("cli demo command writes one verifiable audit record", async () => {
  const cwd = path.resolve(".");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-demo-"));
  const auditPath = path.join(dir, "audit.jsonl");
  const configPath = path.join(dir, "config.json");

  await fs.writeFile(
    configPath,
    JSON.stringify({
      account: "pilot@example.com",
      audit_log_path: auditPath
    }),
    "utf8"
  );

  const result = runCliProcess(["demo", "--config", configPath, "--message-id", "msg-42"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /demo complete/);

  const content = await fs.readFile(auditPath, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 1);

  const record = JSON.parse(lines[0]);
  assert.equal(record.account, "pilot@example.com");
  assert.equal(record.message_id, "msg-42");
  assert.equal(record.action, "classify");
  assert.equal(record.outcome, "success");
  assert.equal(record.rationale, "demo-run");
});

test("cli dry-run writes persisted plan artifacts and performs zero mailbox mutations", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-dry-run-"));
  const configPath = path.join(dir, "config.json");

  await fs.writeFile(
    configPath,
    JSON.stringify({
      account: "pilot@example.com",
      data_dir: dir
    }),
    "utf8"
  );

  let applyCalls = 0;
  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [
        {
          id: "msg-7",
          from: "sender@example.com",
          subject: "Hello",
          date: "2025-12-01T00:00:00.000Z",
          unread: true,
          flagged: false,
          categories: []
        }
      ];
    },
    async apply() {
      applyCalls += 1;
      return { ok: true };
    }
  };

  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runCli(
    ["dry-run", "--config", configPath, "--limit", "1"],
    {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text)
    },
    {
      createAdapter: () => adapter,
      now: () => new Date("2026-01-03T00:00:00.000Z")
    }
  );

  assert.equal(code, 0, stderr.join("\n"));
  assert.equal(applyCalls, 0);

  const planDir = path.join(dir, "plans");
  const plans = await fs.readdir(planDir);
  assert.equal(plans.length, 1);

  const plan = JSON.parse(await fs.readFile(path.join(planDir, plans[0]), "utf8"));
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.actions[0].message_id, "msg-7");
  assert.equal(plan.actions[0].action, "classify");
  assert.equal(plan.actions[0].category, "FYI/Reference");
  assert.ok(Array.isArray(plan.actions[0].rationale.policy));
  assert.ok(Array.isArray(plan.actions[0].rationale.rule));
  assert.ok(Array.isArray(plan.actions[0].rationale.model));
  assert.deepEqual(plan.actions[1], { message_id: "msg-7", action: "archive" });
  assert.deepEqual(plan.exception_queue, []);
  assert.ok(stdout.some((line) => line.includes("dry-run complete")));
});

test("cli live-apply applies only approved categories", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-live-apply-"));
  const configPath = path.join(dir, "config.json");
  const planPath = path.join(dir, "plan.json");

  await fs.writeFile(
    configPath,
    JSON.stringify({
      account: "pilot@example.com",
      data_dir: dir,
      audit_log_path: path.join(dir, "audit.jsonl")
    }),
    "utf8"
  );

  await fs.writeFile(
    planPath,
    `${JSON.stringify(
      {
        plan_id: "plan-run-9",
        run_id: "run-9",
        actions: [
          {
            message_id: "msg-1",
            action: "classify",
            category: "Action Needed",
            rationale: {
              policy: [],
              rule: ["manual"],
              model: []
            }
          },
          {
            message_id: "msg-2",
            action: "classify",
            category: "Bulk/Archive",
            rationale: {
              policy: [],
              rule: ["bulk"],
              model: []
            }
          },
          { message_id: "msg-2", action: "archive" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const applyCalls: Array<{ messageId: string; action: "classify" | "archive"; category?: string }> = [];
  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async apply(messageId, action, category) {
      applyCalls.push({ messageId, action, category });
      return { ok: true };
    }
  };

  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runCli(
    [
      "live-apply",
      "--config",
      configPath,
      "--plan",
      planPath,
      "--approve-category",
      "Bulk/Archive",
      "--reject-category",
      "Action Needed"
    ],
    {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text)
    },
    {
      createAdapter: () => adapter,
      now: () => new Date("2026-01-06T00:00:00.000Z")
    }
  );

  assert.equal(code, 0, stderr.join("\n"));
  assert.deepEqual(applyCalls, [
    { messageId: "msg-2", action: "classify", category: "Bulk/Archive" },
    { messageId: "msg-2", action: "archive", category: undefined }
  ]);
  assert.ok(stdout.some((line) => line.includes("live-apply complete")));
});
