import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appendAuditRecord } from "../src/audit.ts";

test("appendAuditRecord appends one JSON line with required fields", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
  const logPath = path.join(dir, "audit.jsonl");

  await appendAuditRecord(logPath, {
    timestamp: "2026-01-01T00:00:00.000Z",
    account: "pilot@example.com",
    message_id: "message-1",
    action: "classify",
    category: "FYI/Reference",
    outcome: "success",
    rationale: "rule:demo",
    run_id: "run-1"
  });

  const content = await fs.readFile(logPath, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 1);

  const record = JSON.parse(lines[0]);
  assert.equal(record.account, "pilot@example.com");
  assert.equal(record.action, "classify");
  assert.equal(record.run_id, "run-1");
});

test("appendAuditRecord rejects missing required fields", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
  const logPath = path.join(dir, "audit.jsonl");

  await assert.rejects(
    appendAuditRecord(logPath, {
      timestamp: "2026-01-01T00:00:00.000Z",
      account: "pilot@example.com",
      message_id: "",
      action: "archive",
      category: "Bulk/Archive",
      outcome: "success",
      rationale: "rule:demo",
      run_id: "run-1"
    }),
    /Missing required audit field: message_id/
  );
});

test("appendAuditRecord rejects a record without a category", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
  const logPath = path.join(dir, "audit.jsonl");

  await assert.rejects(
    appendAuditRecord(logPath, {
      timestamp: "2026-01-01T00:00:00.000Z",
      account: "pilot@example.com",
      message_id: "message-1",
      action: "archive",
      outcome: "success",
      rationale: "rule:demo",
      run_id: "run-1"
    } as unknown as Parameters<typeof appendAuditRecord>[1]),
    /Missing required audit field: category/
  );
});
