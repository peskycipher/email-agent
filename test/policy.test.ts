import test from "node:test";
import assert from "node:assert/strict";

import type { MailboxMessage } from "../src/adapter.ts";
import { buildNoTouchDryRunPlan } from "../src/policy.ts";

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
      id: "msg-recent",
      from: "new@example.com",
      subject: "Recent thread",
      date: "2026-01-08T00:00:00.000Z",
      unread: true,
      flagged: false,
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
    financeLegalKeywords: ["invoice", "legal"],
    now: () => new Date("2026-01-10T00:00:00.000Z")
  });

  assert.deepEqual(result.exceptionQueue, [
    { message_id: "msg-vip", reasons: ["vip-sender"], unread: true },
    { message_id: "msg-flagged", reasons: ["flagged"], unread: true },
    { message_id: "msg-recent", reasons: ["recent-thread"], unread: true },
    { message_id: "msg-finance", reasons: ["finance-legal-keyword"], unread: false }
  ]);
});

test("buildNoTouchDryRunPlan treats unparseable and exact-boundary dates as protected", () => {
  const messages: MailboxMessage[] = [
    {
      id: "msg-unparseable",
      from: "owner@example.com",
      subject: "Subject",
      date: "not-a-date",
      unread: true,
      flagged: false,
      categories: []
    },
    {
      id: "msg-boundary",
      from: "owner@example.com",
      subject: "Subject",
      date: "2026-01-03T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    }
  ];

  const result = buildNoTouchDryRunPlan(messages, {
    now: () => new Date("2026-01-10T00:00:00.000Z")
  });

  assert.deepEqual(result.exceptionQueue, [
    { message_id: "msg-unparseable", reasons: ["recent-thread"], unread: true },
    { message_id: "msg-boundary", reasons: ["recent-thread"], unread: true }
  ]);
});
