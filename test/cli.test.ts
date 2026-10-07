import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
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

  const help = runCli(["--help"], cwd);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);

  const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));

  const version = runCli(["--version"], cwd);
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

  const result = runCli(["demo", "--config", configPath, "--message-id", "msg-42"], cwd);
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
