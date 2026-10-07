import test from "node:test";
import assert from "node:assert/strict";

import { buildRunMetrics } from "../src/metrics.ts";
import type { EvaluatedAction } from "../src/metrics.ts";

test("buildRunMetrics computes precision from clean archive attempts and counts protected attempts as misses", () => {
  const evaluatedActions: EvaluatedAction[] = [
    { message_id: "clean-1", action: "classify", category: "Bulk/Archive", status: "success" },
    { message_id: "clean-1", action: "archive", category: "Bulk/Archive", status: "success" },
    { message_id: "clean-2", action: "classify", category: "Bulk/Archive", status: "success" },
    { message_id: "clean-2", action: "archive", category: "Bulk/Archive", status: "failed" },
    { message_id: "protected-1", action: "classify", category: "Bulk/Archive", status: "success" },
    { message_id: "protected-1", action: "archive", category: "Bulk/Archive", status: "success" },
    { message_id: "protected-2", action: "classify", category: "Bulk/Archive", status: "success" },
    { message_id: "protected-2", action: "archive", category: "Bulk/Archive", status: "blocked" },
    { message_id: "clean-3", action: "classify", category: "Bulk/Archive", status: "success" },
    { message_id: "clean-3", action: "archive", category: "Bulk/Archive", status: "skipped" }
  ];

  const metrics = buildRunMetrics({
    evaluatedActions,
    exceptionQueue: [
      { message_id: "protected-1", reasons: ["vip-sender"] },
      { message_id: "protected-2", reasons: ["flagged"] }
    ]
  });

  // Clean archive attempts: clean-1 success + clean-2 failed = 1 success / 2 attempts.
  assert.equal(metrics.archive_precision_estimate, 0.5);
  // Only protected-1 reached the adapter as a success archive attempt.
  assert.equal(metrics.no_touch_miss_count, 1);
  assert.equal(metrics.category_totals["Bulk/Archive"].archive.blocked, 1);
  assert.equal(metrics.category_totals["Bulk/Archive"].archive.skipped, 1);
});

test("buildRunMetrics treats zero archive attempts as perfect precision", () => {
  const metrics = buildRunMetrics({
    evaluatedActions: [
      { message_id: "clean-1", action: "classify", category: "Bulk/Archive", status: "success" }
    ],
    exceptionQueue: []
  });

  assert.equal(metrics.archive_precision_estimate, 1);
  assert.equal(metrics.no_touch_miss_count, 0);
});
