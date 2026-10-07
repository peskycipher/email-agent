import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MailboxAdapter, MailboxMessage } from "../src/adapter.ts";
import { buildConfigSnapshot } from "../src/config.ts";
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
    },
    {
      id: "msg-3",
      from: "news@example.com",
      subject: "Newsletter",
      date: "2025-12-20T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    },
    {
      id: "msg-4",
      from: "owner@example.com",
      subject: "Urgent approval",
      date: "2025-12-10T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
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
    async getMessage(messageId) {
      const message = messages.find((entry) => entry.id === messageId);
      if (!message) {
        throw new Error(`missing ${messageId}`);
      }

      return {
        id: message.id,
        from: message.from,
        subject: message.subject,
        flagged: message.flagged,
        unread: message.unread
      };
    },
    async apply() {
      applyCalls += 1;
      return { ok: true };
    }
  };

  const result = await runDryRun({
    adapter,
    config: buildConfigSnapshot({
      account: "pilot@example.com",
      auditLogPath: path.join(dataDir, "audit.jsonl")
    }),
    dataDir,
    limit: 5,
    now: () => new Date("2026-01-03T00:00:00.000Z"),
    system1Classifier: {
      async classify(message) {
        if (message.id === "msg-3") {
          return {
            category: "Bulk/Archive",
            confidence: 0.9,
            rationale: "newsletter"
          };
        }

        return {
          category: "FYI/Reference",
          confidence: 0.9,
          rationale: "default"
        };
      }
    },
    secondPassClassifier: {
      async classify() {
        throw new Error("should-not-run");
      }
    }
  });

  assert.equal(listCalls, 1);
  assert.equal(applyCalls, 0);

  const ingestRecord = JSON.parse(await fs.readFile(result.ingestPath, "utf8"));
  assert.equal(ingestRecord.account, "pilot@example.com");
  assert.deepEqual(
    ingestRecord.messages.map((message: MailboxMessage) => message.id),
    ["msg-1", "msg-2", "msg-3", "msg-4"]
  );

  const planRecord = JSON.parse(await fs.readFile(result.planPath, "utf8"));
  assert.equal(planRecord.account, "pilot@example.com");
  assert.equal(planRecord.config.account, "pilot@example.com");
  assert.equal(planRecord.config.recentDays, 7);
  assert.equal(planRecord.config.confidenceThreshold, 0.7);
  assert.deepEqual(planRecord.config.vipSenders, []);
  assert.deepEqual(planRecord.config.financeLegalKeywords, []);
  assert.deepEqual(planRecord.actions, [
    {
      message_id: "msg-1",
      action: "classify",
      category: "Action Needed",
      rationale: {
        policy: ["no-touch:recent-thread"],
        rule: ["protected-message-routed-to-manual-category"],
        model: []
      }
    },
    {
      message_id: "msg-2",
      action: "classify",
      category: "Action Needed",
      rationale: {
        policy: ["no-touch:flagged", "no-touch:recent-thread"],
        rule: ["protected-message-routed-to-manual-category"],
        model: []
      }
    },
    {
      message_id: "msg-3",
      action: "classify",
      category: "Bulk/Archive",
      rationale: {
        policy: [],
        rule: ["keyword rule: newsletter/unsubscribe/digest (subject)"],
        model: []
      }
    },
    { message_id: "msg-3", action: "archive" },
    {
      message_id: "msg-4",
      action: "classify",
      category: "Action Needed",
      rationale: {
        policy: [],
        rule: ["keyword rule: invoice/approval/urgent (subject)"],
        model: []
      }
    }
  ]);
  assert.deepEqual(planRecord.exception_queue, [
    { message_id: "msg-1", reasons: ["recent-thread"], unread: true },
    { message_id: "msg-2", reasons: ["flagged", "recent-thread"], unread: false }
  ]);

  const runRecord = JSON.parse(await fs.readFile(result.runPath, "utf8"));
  assert.equal(runRecord.plan_id, planRecord.plan_id);
  assert.equal(runRecord.config.account, "pilot@example.com");
  assert.deepEqual(runRecord.planned_actions, planRecord.actions);
  assert.deepEqual(runRecord.exception_queue, planRecord.exception_queue);

  const archives = planRecord.actions.filter((action: { action: string }) => action.action === "archive");
  assert.deepEqual(
    archives.map((action: { message_id: string }) => action.message_id),
    ["msg-3"]
  );

  // Summary counts what the run just did, derived from the plan it wrote.
  assert.deepEqual(result.summary, {
    ingested: 4,
    categories: {
      "Action Needed": 3,
      "Waiting/Follow-up": 0,
      "FYI/Reference": 0,
      "Bulk/Archive": 1
    },
    archivesPlanned: 1,
    protectedItems: 2,
    noTouchReasons: { "recent-thread": 2, flagged: 1 },
    durationMs: 0 // fixed injected clock in this test
  });
});
