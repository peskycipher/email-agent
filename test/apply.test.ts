import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MailboxAdapter } from "../src/adapter.ts";
import { runLiveApply } from "../src/apply.ts";

async function writePlanFile(dir: string): Promise<string> {
  const plansDir = path.join(dir, "plans");
  await fs.mkdir(plansDir, { recursive: true });
  const planPath = path.join(plansDir, "plan-run-1.json");

  await fs.writeFile(
    planPath,
    `${JSON.stringify(
      {
        plan_id: "plan-run-1",
        run_id: "run-1",
        account: "pilot@example.com",
        created_at: "2026-01-03T00:00:00.000Z",
        dry_run: true,
        actions: [
          {
            message_id: "msg-a",
            action: "classify",
            category: "Action Needed",
            rationale: {
              policy: [],
              rule: ["needs-manual"],
              model: []
            }
          },
          {
            message_id: "msg-b",
            action: "classify",
            category: "Bulk/Archive",
            rationale: {
              policy: [],
              rule: ["bulk-rule"],
              model: []
            }
          },
          {
            message_id: "msg-b",
            action: "archive"
          },
          {
            message_id: "msg-c",
            action: "classify",
            category: "FYI/Reference",
            rationale: {
              policy: [],
              rule: ["fyi-rule"],
              model: []
            }
          },
          {
            message_id: "msg-c",
            action: "archive"
          }
        ],
        exception_queue: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return planPath;
}

test("runLiveApply requires explicit approval decisions for every planned category", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir);

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async apply() {
      return { ok: true };
    }
  };

  await assert.rejects(
    runLiveApply({
      adapter,
      account: "pilot@example.com",
      dataDir,
      planPath,
      auditLogPath: path.join(dataDir, "audit.jsonl"),
      approvals: {
        "Bulk/Archive": true,
        "Action Needed": false
      }
    }),
    /Missing explicit approval decision for category: FYI\/Reference/
  );
});

test("runLiveApply applies only approved categories, audits each applied action, and links live run to dry-run plan", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir);

  const applyCalls: Array<{ messageId: string; action: "classify" | "archive"; category?: string }> = [];

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async apply(messageId, action, category) {
      applyCalls.push({ messageId, action, category });

      if (messageId === "msg-c" && action === "archive") {
        return { ok: false, error: "archive-failed" };
      }

      return { ok: true };
    }
  };

  const auditLogPath = path.join(dataDir, "audit.jsonl");

  const result = await runLiveApply({
    adapter,
    account: "pilot@example.com",
    dataDir,
    planPath,
    auditLogPath,
    approvals: {
      "Action Needed": false,
      "Bulk/Archive": true,
      "FYI/Reference": true
    },
    now: () => new Date("2026-01-04T10:00:00.000Z")
  });

  assert.deepEqual(applyCalls, [
    { messageId: "msg-b", action: "classify", category: "Bulk/Archive" },
    { messageId: "msg-b", action: "archive", category: undefined },
    { messageId: "msg-c", action: "classify", category: "FYI/Reference" },
    { messageId: "msg-c", action: "archive", category: undefined }
  ]);

  const auditLines = (await fs.readFile(auditLogPath, "utf8")).trim().split("\n");
  assert.equal(auditLines.length, 4);

  const auditRecords = auditLines.map((line: string) => JSON.parse(line));
  for (const record of auditRecords) {
    assert.equal(record.account, "pilot@example.com");
    assert.equal(record.run_id, result.runId);
    assert.ok(record.action === "classify" || record.action === "archive");
    assert.equal(typeof record.outcome, "string");
    assert.ok(record.outcome.length > 0);
    assert.equal(typeof record.rationale, "string");
    assert.ok(record.rationale.length > 0);
  }

  assert.equal(auditRecords[3].outcome, "failed:archive-failed");

  const runRecord = JSON.parse(await fs.readFile(result.runPath, "utf8"));
  assert.equal(runRecord.mode, "live-apply");
  assert.equal(runRecord.source_plan_id, "plan-run-1");
  assert.equal(runRecord.source_plan_path, planPath);

  assert.equal(result.appliedActions, 4);
  assert.equal(result.skippedActions, 1);
});
