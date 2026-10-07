import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MailboxAdapter, MailboxMessage } from "../src/adapter.ts";
import { runDryRun } from "../src/dry_run.ts";

test("runDryRun persists ingest, plan, and run records without mailbox mutations", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dry-run-"));

  const messages: MailboxMessage[] = [
    {
      id: "msg-1",
      from: "alice@example.com",
      subject: "Status",
      date: "2026-01-02T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    },
    {
      id: "msg-2",
      from: "bob@example.com",
      subject: "Invoice",
      date: "2026-01-01T00:00:00.000Z",
      unread: false,
      flagged: true,
      categories: ["Red"]
    }
  ];

  let listCalls = 0;
  let applyCalls = 0;

  const adapter: MailboxAdapter = {
    async listRecentInbox(limit: number) {
      listCalls += 1;
      assert.equal(limit, 5);
      return messages;
    },
    async apply() {
      applyCalls += 1;
      return { ok: true };
    }
  };

  const result = await runDryRun({
    adapter,
    account: "pilot@example.com",
    dataDir,
    limit: 5,
    now: () => new Date("2026-01-03T00:00:00.000Z")
  });

  assert.equal(listCalls, 1);
  assert.equal(applyCalls, 0);

  const ingestRecord = JSON.parse(await fs.readFile(result.ingestPath, "utf8"));
  assert.equal(ingestRecord.account, "pilot@example.com");
  assert.deepEqual(
    ingestRecord.messages.map((message: MailboxMessage) => message.id),
    ["msg-1", "msg-2"]
  );

  const planRecord = JSON.parse(await fs.readFile(result.planPath, "utf8"));
  assert.equal(planRecord.account, "pilot@example.com");
  assert.deepEqual(planRecord.actions, [
    { message_id: "msg-1", action: "classify", category: "FYI/Reference" },
    { message_id: "msg-2", action: "classify", category: "FYI/Reference" }
  ]);

  const runRecord = JSON.parse(await fs.readFile(result.runPath, "utf8"));
  assert.equal(runRecord.plan_id, planRecord.plan_id);
  assert.deepEqual(runRecord.planned_actions, planRecord.actions);
});
