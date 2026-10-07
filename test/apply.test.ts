import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MailboxAdapter, MailboxMessage } from "../src/adapter.ts";
import { buildConfigSnapshot } from "../src/config.ts";
import { loadGateEvidence } from "../src/gate.ts";
import type { PlannedAction } from "../src/store.ts";
import { runLiveApply } from "../src/apply.ts";

type PlanFileOptions = {
  actions?: PlannedAction[];
  exceptionQueue?: Array<{ message_id: string; reasons: string[]; unread: boolean }>;
};

async function writePlanFile(dir: string, options: PlanFileOptions = {}): Promise<string> {
  const plansDir = path.join(dir, "plans");
  await fs.mkdir(plansDir, { recursive: true });
  const planPath = path.join(plansDir, "plan-run-1.json");

  const actions =
    options.actions ??
    [
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
    ];

  await fs.writeFile(
    planPath,
    `${JSON.stringify(
      {
        plan_id: "plan-run-1",
        run_id: "run-1",
        account: "pilot@example.com",
        created_at: "2026-01-03T00:00:00.000Z",
        dry_run: true,
        actions,
        exception_queue: options.exceptionQueue ?? [{ message_id: "msg-a", reasons: ["flagged"], unread: true }]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return planPath;
}

async function writeSourceRunArtifacts(dir: string, messages: MailboxMessage[]): Promise<void> {
  const runsDir = path.join(dir, "runs");
  await fs.mkdir(runsDir, { recursive: true });
  const ingestPath = path.join(runsDir, "run-1-ingest.json");

  await fs.writeFile(
    ingestPath,
    `${JSON.stringify(
      {
        run_id: "run-1",
        account: "pilot@example.com",
        ingested_at: "2026-01-03T00:00:00.000Z",
        messages
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await fs.writeFile(
    path.join(runsDir, "run-1.json"),
    `${JSON.stringify(
      {
        run_id: "run-1",
        account: "pilot@example.com",
        created_at: "2026-01-03T00:00:00.000Z",
        mode: "dry-run",
        plan_id: "plan-run-1",
        ingest_path: ingestPath
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function toMessageState(message: MailboxMessage) {
  return {
    id: message.id,
    from: message.from,
    subject: message.subject,
    flagged: message.flagged,
    unread: message.unread
  };
}

test("runLiveApply requires explicit approval decisions for every planned category", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir);

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async getMessage() {
      return { id: "x", from: "", subject: "", flagged: false, unread: false };
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

test("runLiveApply persists per-run gate evidence and the gate unions it across runs", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir);

  await writeSourceRunArtifacts(dataDir, [
    { id: "msg-a", from: "boss@example.com", subject: "Meeting", date: "2025-12-20T00:00:00.000Z", unread: false, flagged: false, categories: [] },
    { id: "msg-b", from: "news@example.com", subject: "Digest", date: "2025-12-20T00:00:00.000Z", unread: true, flagged: false, categories: [] },
    { id: "msg-c", from: "news2@example.com", subject: "Receipt", date: "2025-12-20T00:00:00.000Z", unread: true, flagged: false, categories: [] }
  ]);

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async getMessage() {
      return { id: "x", from: "news@example.com", subject: "Digest", flagged: false, unread: true };
    },
    async apply() {
      return { ok: true };
    }
  };

  // Message dates are 2025-12-20 (just outside the 7-day recent window from 2026-01-01).
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const options = {
    adapter,
    account: "pilot@example.com",
    dataDir,
    planPath,
    auditLogPath: path.join(dataDir, "audit.jsonl"),
    approvals: {
      "Bulk/Archive": true,
      "Action Needed": false,
      "FYI/Reference": true
    },
    config: buildConfigSnapshot({ account: "pilot@example.com", auditLogPath: path.join(dataDir, "audit.jsonl") }),
    now: () => new Date((nowMs += 1))
  };

  const result = await runLiveApply(options);

  const runRecord = JSON.parse(await fs.readFile(result.runPath, "utf8"));
  assert.equal(runRecord.account, "pilot@example.com");
  // every message with an evaluated action, exactly once
  assert.deepEqual([...runRecord.message_ids].sort(), ["msg-a", "msg-b", "msg-c"]);
  assert.deepEqual(runRecord.archive_attempt_tallies, { clean_attempts: 2, clean_successes: 2 }); // msg-b + msg-c

  // Gate unions across immutable run records — no mutable ledger, no lost-update race.
  await runLiveApply(options);

  const evidence = await loadGateEvidence(result.runPath);
  assert.equal(evidence.source, "cumulative across 2 run(s)");
  assert.equal(evidence.metrics.processed_count, 3);
  assert.equal(evidence.metrics.archive_precision_estimate, 1);
  assert.equal(evidence.metrics.no_touch_miss_count, 0);
});

test("runLiveApply applies approved categories and persists run report + metrics", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir);

  const sourceMessages: MailboxMessage[] = [
    {
      id: "msg-a",
      from: "vip@example.com",
      subject: "Status",
      date: "2026-01-01T00:00:00.000Z",
      unread: true,
      flagged: true,
      categories: []
    },
    {
      id: "msg-b",
      from: "news@example.com",
      subject: "Digest",
      date: "2025-12-20T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    },
    {
      id: "msg-c",
      from: "sender@example.com",
      subject: "Info",
      date: "2025-12-10T00:00:00.000Z",
      unread: false,
      flagged: false,
      categories: []
    }
  ];
  await writeSourceRunArtifacts(dataDir, sourceMessages);

  const applyCalls: Array<{ messageId: string; action: "classify" | "archive"; category?: string }> = [];

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async getMessage(messageId) {
      const message = sourceMessages.find((item) => item.id === messageId);
      if (!message) {
        throw new Error(`missing message ${messageId}`);
      }
      return toMessageState(message);
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
  assert.equal(runRecord.config.account, "pilot@example.com");
  assert.equal(runRecord.config.recentDays, 7);
  assert.equal(runRecord.config.confidenceThreshold, 0.7);

  assert.equal(runRecord.report.summary.unread_delta, 1);
  assert.equal(runRecord.report.summary.category_action_totals["Action Needed"].classify.skipped, 1);
  assert.equal(runRecord.report.summary.category_action_totals["FYI/Reference"].archive.failed, 1);
  assert.deepEqual(runRecord.report.exception_queue_snapshot, [{ message_id: "msg-a", reasons: ["flagged"], unread: true }]);
  assert.equal(runRecord.report.trace_samples.length, 3);

  assert.equal(runRecord.metrics.processed_count, 3);
  assert.equal(runRecord.metrics.archive_precision_estimate, 0.5);
  assert.equal(runRecord.metrics.no_touch_miss_count, 0);
  assert.equal(runRecord.metrics.category_totals["Action Needed"].classify.skipped, 1);
  assert.equal(runRecord.metrics.category_totals["Bulk/Archive"].archive.success, 1);
  assert.equal(runRecord.metrics.category_totals["FYI/Reference"].archive.failed, 1);

  assert.equal(result.appliedActions, 4);
  assert.equal(result.skippedActions, 1);
});

test("runLiveApply blocks protected archive actions and never calls the adapter for them", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir, {
    actions: [
      {
        message_id: "msg-protected",
        action: "classify",
        category: "Bulk/Archive",
        rationale: {
          policy: [],
          rule: ["bulk-rule"],
          model: []
        }
      },
      {
        message_id: "msg-protected",
        action: "archive"
      }
    ],
    exceptionQueue: [{ message_id: "msg-protected", reasons: ["vip-sender"], unread: true }]
  });

  const applyCalls: Array<{ messageId: string; action: "classify" | "archive" }> = [];
  let getMessageCalls = 0;

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async getMessage() {
      getMessageCalls += 1;
      return { id: "msg-protected", from: "vip@example.com", subject: "hello", flagged: false, unread: true };
    },
    async apply(messageId, action) {
      applyCalls.push({ messageId, action });
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
      "Bulk/Archive": true
    },
    now: () => new Date("2026-01-05T00:00:00.000Z")
  });

  assert.equal(getMessageCalls, 0);
  assert.deepEqual(applyCalls, [{ messageId: "msg-protected", action: "classify" }]);

  const runRecord = JSON.parse(await fs.readFile(result.runPath, "utf8"));
  assert.equal(runRecord.metrics.no_touch_miss_count, 1);
  assert.equal(runRecord.metrics.category_totals["Bulk/Archive"].archive.blocked, 1);
  assert.equal(runRecord.metrics.category_totals["Bulk/Archive"].archive.success, 0);

  const auditLines = (await fs.readFile(auditLogPath, "utf8")).trim().split("\n");
  assert.equal(auditLines.length, 2);

  const auditRecords = auditLines.map((line: string) => JSON.parse(line));
  const blockedArchive = auditRecords.find((record: { action: string }) => record.action === "archive");
  assert.ok(blockedArchive);
  assert.equal(blockedArchive.outcome, "blocked:no-touch");
  assert.equal(blockedArchive.category, "Bulk/Archive");
});

test("runLiveApply re-checks no-touch at apply-time and blocks flagged-since-dry-run archives", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir, {
    actions: [
      {
        message_id: "msg-1",
        action: "classify",
        category: "Bulk/Archive",
        rationale: {
          policy: [],
          rule: ["bulk-rule"],
          model: []
        }
      },
      { message_id: "msg-1", action: "archive" }
    ],
    exceptionQueue: []
  });

  await writeSourceRunArtifacts(dataDir, [
    {
      id: "msg-1",
      from: "news@example.com",
      subject: "Digest",
      date: "2025-12-20T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    }
  ]);

  const applyCalls: Array<{ messageId: string; action: "classify" | "archive" }> = [];

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async getMessage() {
      return {
        id: "msg-1",
        from: "news@example.com",
        subject: "Digest",
        flagged: true,
        unread: true
      };
    },
    async apply(messageId, action) {
      applyCalls.push({ messageId, action });
      return { ok: true };
    }
  };

  const result = await runLiveApply({
    adapter,
    account: "pilot@example.com",
    dataDir,
    planPath,
    auditLogPath: path.join(dataDir, "audit.jsonl"),
    approvals: {
      "Bulk/Archive": true
    },
    now: () => new Date("2026-01-05T00:00:00.000Z")
  });

  assert.deepEqual(applyCalls, [{ messageId: "msg-1", action: "classify" }]);

  const runRecord = JSON.parse(await fs.readFile(result.runPath, "utf8"));
  assert.equal(runRecord.metrics.category_totals["Bulk/Archive"].archive.blocked, 1);
  assert.equal(runRecord.metrics.no_touch_miss_count, 1);
});

test("runLiveApply still guards archives when the plan exception queue is edited empty", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir, {
    actions: [
      {
        message_id: "msg-1",
        action: "classify",
        category: "Bulk/Archive",
        rationale: {
          policy: [],
          rule: ["bulk-rule"],
          model: []
        }
      },
      { message_id: "msg-1", action: "archive" }
    ],
    exceptionQueue: []
  });

  await writeSourceRunArtifacts(dataDir, [
    {
      id: "msg-1",
      from: "vip@example.com",
      subject: "Digest",
      date: "2025-12-20T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    }
  ]);

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async getMessage() {
      return {
        id: "msg-1",
        from: "vip@example.com",
        subject: "Digest",
        flagged: false,
        unread: true
      };
    },
    async apply() {
      return { ok: true };
    }
  };

  const result = await runLiveApply({
    adapter,
    account: "pilot@example.com",
    dataDir,
    planPath,
    auditLogPath: path.join(dataDir, "audit.jsonl"),
    approvals: {
      "Bulk/Archive": true
    },
    config: buildConfigSnapshot({
      account: "pilot@example.com",
      auditLogPath: path.join(dataDir, "audit.jsonl"),
      vipSenders: ["vip@example.com"]
    }),
    now: () => new Date("2026-01-05T00:00:00.000Z")
  });

  const runRecord = JSON.parse(await fs.readFile(result.runPath, "utf8"));
  assert.equal(runRecord.metrics.category_totals["Bulk/Archive"].archive.blocked, 1);
  assert.equal(runRecord.metrics.no_touch_miss_count, 1);
});

test("runLiveApply blocks archive when getMessage fails", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir, {
    actions: [
      {
        message_id: "msg-1",
        action: "classify",
        category: "Bulk/Archive",
        rationale: {
          policy: [],
          rule: ["bulk-rule"],
          model: []
        }
      },
      { message_id: "msg-1", action: "archive" }
    ],
    exceptionQueue: []
  });

  await writeSourceRunArtifacts(dataDir, [
    {
      id: "msg-1",
      from: "news@example.com",
      subject: "Digest",
      date: "2025-12-20T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: []
    }
  ]);

  const applyCalls: Array<{ messageId: string; action: "classify" | "archive" }> = [];

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async getMessage() {
      throw new Error("read-failed");
    },
    async apply(messageId, action) {
      applyCalls.push({ messageId, action });
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
      "Bulk/Archive": true
    },
    now: () => new Date("2026-01-05T00:00:00.000Z")
  });

  assert.deepEqual(applyCalls, [{ messageId: "msg-1", action: "classify" }]);

  const auditLines = (await fs.readFile(auditLogPath, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line));
  const archiveRecord = auditLines.find((record: { action: string }) => record.action === "archive");
  assert.ok(archiveRecord);
  // A transient fetch failure is an operational failure, not a no-touch policy miss (P6).
  assert.equal(archiveRecord.outcome, "failed:mailbox-fetch");

  const runRecord = JSON.parse(await fs.readFile(result.runPath, "utf8"));
  assert.equal(runRecord.metrics.no_touch_miss_count, 0);
  assert.equal(runRecord.metrics.category_totals["Bulk/Archive"].archive.failed, 1);
});

test("runLiveApply checks category approval before any no-touch re-check or mailbox access", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir, {
    actions: [
      { message_id: "msg-protected", action: "classify", category: "Bulk/Archive", rationale: { policy: [], rule: ["bulk-rule"], model: [] } },
      { message_id: "msg-protected", action: "archive" }
    ],
    exceptionQueue: [{ message_id: "msg-protected", reasons: ["vip-sender"], unread: true }]
  });

  let getMessageCalls = 0;
  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async getMessage() {
      getMessageCalls += 1;
      return { id: "msg-protected", from: "vip@example.com", subject: "hello", flagged: true, unread: true };
    },
    async apply() {
      throw new Error("adapter.apply must not run for rejected categories");
    }
  };

  const result = await runLiveApply({
    adapter,
    account: "pilot@example.com",
    dataDir,
    planPath,
    auditLogPath: path.join(dataDir, "audit.jsonl"),
    approvals: {
      "Bulk/Archive": false // rejected category
    },
    now: () => new Date("2026-01-05T00:00:00.000Z")
  });

  // Rejected category: no mailbox reads, no apply, no misses attributed (P4).
  assert.equal(getMessageCalls, 0);
  const runRecord = JSON.parse(await fs.readFile(result.runPath, "utf8"));
  assert.equal(runRecord.metrics.no_touch_miss_count, 0);
  assert.equal(runRecord.metrics.category_totals["Bulk/Archive"].archive.skipped, 1);
  // classify and archive both belong to the rejected category
  assert.equal(runRecord.skipped_actions, 2);
});

test("runLiveApply passes existing message categories to the adapter for classify actions", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir, {
    actions: [
      {
        message_id: "msg-1",
        action: "classify",
        category: "Bulk/Archive",
        rationale: {
          policy: [],
          rule: ["bulk-rule"],
          model: []
        }
      }
    ]
  });

  await writeSourceRunArtifacts(dataDir, [
    {
      id: "msg-1",
      from: "news@example.com",
      subject: "Digest",
      date: "2025-12-20T00:00:00.000Z",
      unread: true,
      flagged: false,
      categories: ["Existing", "Bulk/Archive"]
    }
  ]);

  const classifyCalls: Array<{ messageId: string; category?: string; existingCategories?: string[] }> = [];

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async getMessage() {
      return { id: "msg-1", from: "news@example.com", subject: "Digest", flagged: false, unread: true };
    },
    async apply(messageId, action, category, existingCategories) {
      if (action === "classify") {
        classifyCalls.push({ messageId, category, existingCategories });
      }
      return { ok: true };
    }
  };

  await runLiveApply({
    adapter,
    account: "pilot@example.com",
    dataDir,
    planPath,
    auditLogPath: path.join(dataDir, "audit.jsonl"),
    approvals: {
      "Bulk/Archive": true
    },
    now: () => new Date("2026-01-05T00:00:00.000Z")
  });

  assert.deepEqual(classifyCalls, [
    { messageId: "msg-1", category: "Bulk/Archive", existingCategories: ["Existing", "Bulk/Archive"] }
  ]);
});

test("runLiveApply passes undefined categories when source ingest snapshot is missing", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-apply-"));
  const planPath = await writePlanFile(dataDir, {
    actions: [
      {
        message_id: "msg-1",
        action: "classify",
        category: "Bulk/Archive",
        rationale: {
          policy: [],
          rule: ["bulk-rule"],
          model: []
        }
      }
    ]
  });

  const classifyCalls: Array<{ messageId: string; category?: string; existingCategories?: string[] }> = [];

  const adapter: MailboxAdapter = {
    async listRecentInbox() {
      return [];
    },
    async getMessage() {
      return { id: "msg-1", from: "news@example.com", subject: "Digest", flagged: false, unread: true };
    },
    async apply(messageId, action, category, existingCategories) {
      if (action === "classify") {
        classifyCalls.push({ messageId, category, existingCategories });
      }
      return { ok: true };
    }
  };

  const result = await runLiveApply({
    adapter,
    account: "pilot@example.com",
    dataDir,
    planPath,
    auditLogPath: path.join(dataDir, "audit.jsonl"),
    approvals: {
      "Bulk/Archive": true
    },
    now: () => new Date("2026-01-05T00:00:00.000Z")
  });

  assert.deepEqual(classifyCalls, [{ messageId: "msg-1", category: "Bulk/Archive", existingCategories: undefined }]);

  const runRecord = JSON.parse(await fs.readFile(result.runPath, "utf8"));
  assert.equal(runRecord.report.summary.unread_before, null);
  assert.equal(runRecord.report.summary.unread_after, null);
  assert.equal(runRecord.report.summary.unread_delta, null);
  assert.equal(runRecord.report.summary.ingest_unavailable, true);
});
