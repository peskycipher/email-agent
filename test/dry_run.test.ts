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
            labels: ["Newsletters"],
            confidence: 0.9,
            rationale: "newsletter"
          };
        }

        return {
          labels: ["Business"],
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
  assert.equal(planRecord.config.confidenceThreshold, 0.7);
  assert.deepEqual(planRecord.config.vipSenders, []);
  assert.deepEqual(planRecord.config.financeLegalKeywords, []);
  // The load-bearing behaviour: which actions are planned, with which labels.
  // Rationale prose is checked structurally below, not pinned word-for-word.
  assert.deepEqual(
    planRecord.actions.map((action: { message_id: string; action: string }) => [action.message_id, action.action]),
    [
      ["msg-1", "classify"],
      ["msg-2", "classify"],
      ["msg-3", "classify"],
      ["msg-3", "archive"],
      ["msg-4", "classify"]
    ]
  );

  const classifyByMessageId = new Map<string, { labels: string[]; rationale: { policy: string[]; rule: string[]; model: string[] } }>(
    planRecord.actions
      .filter((action: { action: string }) => action.action === "classify")
      .map((action: { message_id: string; labels: string[]; rationale: never }) => [action.message_id, action])
  );

  assert.deepEqual(classifyByMessageId.get("msg-1")?.labels, ["Business"]);
  assert.deepEqual(classifyByMessageId.get("msg-2")?.labels, ["Action Needed"]);
  assert.deepEqual(classifyByMessageId.get("msg-3")?.labels, ["Newsletters"]);
  assert.deepEqual(classifyByMessageId.get("msg-4")?.labels, ["Invoices", "Action Needed"]);

  // Every classification carries a well-formed trace, and protected mail says so.
  for (const [, classification] of classifyByMessageId) {
    assert.ok(Array.isArray(classification.rationale.policy));
    assert.ok(Array.isArray(classification.rationale.rule));
    assert.ok(Array.isArray(classification.rationale.model));
  }
  assert.ok(classifyByMessageId.get("msg-2")?.rationale.policy.includes("no-touch:flagged"));
  assert.deepEqual(planRecord.exception_queue, [
    { message_id: "msg-2", reasons: ["flagged"], unread: false }
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
  const summary = result.summary as Record<string, unknown> & { labels: Record<string, number> };
  assert.equal(summary.ingested, 4);
  assert.equal(summary.archivesPlanned, 1);
  assert.equal(summary.protectedItems, 1);
  assert.deepEqual(summary.noTouchReasons, { flagged: 1 });
  assert.equal(summary.durationMs, 0); // fixed injected clock in this test
  assert.equal(summary.labels.Newsletters, 1);
  assert.equal(summary.labels.Invoices, 1);
  assert.equal(summary.labels["Action Needed"], 2);
  assert.equal(summary.labels.Business, 1);
});
