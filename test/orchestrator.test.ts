import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MailboxAdapter, MailboxMessage, MailboxMessageState } from "../src/adapter.ts";
import { buildConfigSnapshot } from "../src/config.ts";
import { runDryRun, runLiveApply } from "../src/orchestrator.ts";

test("orchestrator end-to-end archives only non-important categories and blocks flagged-since-ingest archives", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-"));
  const auditLogPath = path.join(dataDir, "audit.jsonl");

  const messages: MailboxMessage[] = [
    {
      id: "msg-important",
      from: "owner@example.com",
      subject: "Need approval",
      date: "2025-12-01T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    },
    {
      id: "msg-fyi",
      from: "sender@example.com",
      subject: "Reference notes",
      date: "2025-12-01T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    },
    {
      id: "msg-bulk",
      from: "news@example.com",
      subject: "Newsletter",
      date: "2025-12-01T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    }
  ];

  const liveState = new Map<string, MailboxMessageState>(
    messages.map((message) => [
      message.id,
      {
        id: message.id,
        from: message.from,
        subject: message.subject,
        flagged: message.flagged,
        unread: message.unread
      }
    ])
  );

  const applyCalls: Array<{ messageId: string; action: string; category?: string }> = [];

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return messages;
    },
    async getMessage(messageId) {
      const message = liveState.get(messageId);
      if (!message) {
        throw new Error(`missing ${messageId}`);
      }
      return message;
    },
    async apply(messageId, action, category) {
      applyCalls.push({ messageId, action, category });
      return { ok: true };
    }
  };

  const config = buildConfigSnapshot({
    account: "pilot@example.com",
    auditLogPath
  });

  const dryRun = await runDryRun({
    adapter,
    config,
    dataDir,
    limit: 10,
    now: () => new Date("2026-01-10T00:00:00.000Z"),
    system1Classifier: {
      async classify(message) {
        if (message.id === "msg-important") {
          return { category: "Action Needed", confidence: 0.95, rationale: "manual-action" };
        }

        if (message.id === "msg-fyi") {
          return { category: "FYI/Reference", confidence: 0.95, rationale: "reference" };
        }

        return { category: "Bulk/Archive", confidence: 0.95, rationale: "bulk" };
      }
    },
    secondPassClassifier: {
      async classify() {
        throw new Error("should-not-run");
      }
    }
  });

  const planRecord = JSON.parse(await fs.readFile(dryRun.planPath, "utf8"));
  const archiveTargets = planRecord.actions
    .filter((action: { action: string }) => action.action === "archive")
    .map((action: { message_id: string }) => action.message_id)
    .sort();
  assert.deepEqual(archiveTargets, ["msg-bulk", "msg-fyi"]);

  liveState.set("msg-bulk", {
    ...liveState.get("msg-bulk")!,
    flagged: true
  });

  const liveRun = await runLiveApply({
    adapter,
    account: "pilot@example.com",
    dataDir,
    planPath: dryRun.planPath,
    auditLogPath,
    approvals: {
      "Action Needed": true,
      "FYI/Reference": true,
      "Bulk/Archive": true
    },
    config,
    now: () => new Date("2026-01-11T00:00:00.000Z")
  });

  assert.ok(applyCalls.every((call) => call.action === "classify" || call.action === "archive"));
  assert.ok(planRecord.actions.every((action: { action: string }) => action.action === "classify" || action.action === "archive"));

  const appliedArchives = applyCalls.filter((call) => call.action === "archive").map((call) => call.messageId);
  assert.deepEqual(appliedArchives, ["msg-fyi"]);

  const runRecord = JSON.parse(await fs.readFile(liveRun.runPath, "utf8"));
  assert.equal(runRecord.metrics.category_totals["Bulk/Archive"].archive.blocked, 1);
  assert.equal(runRecord.metrics.no_touch_miss_count, 1);
});
