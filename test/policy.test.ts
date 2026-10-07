import test from "node:test";
import assert from "node:assert/strict";

import type { MailboxMessage } from "../src/adapter.ts";
import { buildNoTouchDryRunPlan, shouldArchiveLabels } from "../src/policy.ts";

test("buildNoTouchDryRunPlan excludes protected messages from archive and routes them to exception queue", () => {
  const messages: MailboxMessage[] = [
    {
      id: "msg-vip",
      from: "vip@example.com",
      subject: "Weekly update",
      date: "2025-12-01T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    },
    {
      id: "msg-flagged",
      from: "owner@example.com",
      subject: "Follow-up",
      date: "2025-12-01T00:00:00.000Z",
      unread: true,
      flagged: true,
      categories: []
    },
    {
      id: "msg-finance",
      from: "billing@example.com",
      subject: "Invoice legal review",
      date: "2025-12-01T00:00:00.000Z",
      unread: false,
      flagged: false,
      categories: []
    },
    {
      id: "msg-safe",
      from: "news@example.com",
      subject: "Newsletter",
      date: "2025-12-01T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    }
  ];

  const result = buildNoTouchDryRunPlan(messages, {
    vipSenders: ["vip@example.com"],
    financeLegalKeywords: ["invoice", "legal"]
  });

  assert.deepEqual(result.exceptionQueue, [
    { message_id: "msg-vip", reasons: ["vip-sender"], unread: true },
    { message_id: "msg-flagged", reasons: ["flagged"], unread: true },
    { message_id: "msg-finance", reasons: ["finance-legal-keyword"], unread: false }
  ]);
});

test("shouldArchiveLabels archives on any safe label but a veto label blocks it", () => {
  // One archive-safe label is enough.
  assert.equal(shouldArchiveLabels(["Newsletters"]), true);
  assert.equal(shouldArchiveLabels(["Promos", "Business"]), true);
  // A veto label anywhere wins.
  assert.equal(shouldArchiveLabels(["Promos", "Action Needed"]), false);
  assert.equal(shouldArchiveLabels(["Family", "Notifications"]), false);
  assert.equal(shouldArchiveLabels(["Newsletters", "Important"]), false);
  // Every veto label also blocks on its own — a veto label is never archive-safe.
  assert.equal(shouldArchiveLabels(["Action Needed"]), false);
  assert.equal(shouldArchiveLabels(["Important"]), false);
  assert.equal(shouldArchiveLabels(["Family"]), false);
  assert.equal(shouldArchiveLabels(["Friends"]), false);
  // No labels at all is not archive-eligible.
  assert.equal(shouldArchiveLabels([]), false);
});
