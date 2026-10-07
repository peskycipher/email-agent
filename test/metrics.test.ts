import test from "node:test";
import assert from "node:assert/strict";

import { buildRunMetrics } from "../src/metrics.ts";
import type { EvaluatedAction } from "../src/metrics.ts";

test("buildRunMetrics computes precision from clean archive attempts and counts protected attempts as misses", () => {
  const evaluatedActions: EvaluatedAction[] = [
    { message_id: "clean-1", action: "classify", labels: ["Newsletters"], status: "success" },
    { message_id: "clean-1", action: "archive", labels: ["Newsletters"], status: "success" },
    { message_id: "clean-2", action: "classify", labels: ["Newsletters"], status: "success" },
    { message_id: "clean-2", action: "archive", labels: ["Newsletters"], status: "failed" },
    { message_id: "protected-1", action: "classify", labels: ["Newsletters"], status: "success" },
    { message_id: "protected-1", action: "archive", labels: ["Newsletters"], status: "success" },
    { message_id: "protected-2", action: "classify", labels: ["Newsletters"], status: "success" },
    { message_id: "protected-2", action: "archive", labels: ["Newsletters"], status: "blocked" },
    { message_id: "clean-3", action: "classify", labels: ["Newsletters"], status: "success" },
    { message_id: "clean-3", action: "archive", labels: ["Newsletters"], status: "skipped" }
  ];

  const metrics = buildRunMetrics({
    evaluatedActions,
    exceptionQueue: [
      { message_id: "protected-1", reasons: ["vip-sender"], unread: true },
      { message_id: "protected-2", reasons: ["flagged"], unread: true }
    ]
  });

  // Clean archive attempts: clean-1 success + clean-2 failed = 1 success / 2 attempts.
  assert.equal(metrics.archive_precision_estimate, 0.5);
  // Misses now include blocked archives plus protected archive attempts.
  assert.equal(metrics.no_touch_miss_count, 2);
  assert.equal(metrics.label_totals["Newsletters"].archive.blocked, 1);
  assert.equal(metrics.label_totals["Newsletters"].archive.skipped, 1);
});

test("buildRunMetrics fails precision closed when there are zero archive attempts", () => {
  const metrics = buildRunMetrics({
    evaluatedActions: [
      { message_id: "clean-1", action: "classify", labels: ["Newsletters"], status: "success" }
    ],
    exceptionQueue: []
  });

  assert.equal(metrics.archive_precision_estimate, 0);
  assert.equal(metrics.no_touch_miss_count, 0);
});
