import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { evaluateExpansionGate, loadGateEvidence, loadExpansionGateMetricsFromRun, loadExpansionSignOffFromRun, recordExpansionSignOff } from "../src/gate.ts";

function buildRunRecord(metrics: {
  processed_count: number;
  archive_precision_estimate: number;
  no_touch_miss_count: number;
}): Record<string, unknown> {
  return {
    run_id: "live-1",
    mode: "live-apply",
    metrics: {
      ...metrics,
      category_totals: {
        "Action Needed": {
          classify: { planned: 1, success: 1, failed: 0, skipped: 0, blocked: 0 },
          archive: { planned: 0, success: 0, failed: 0, skipped: 0, blocked: 0 }
        },
        "Waiting/Follow-up": {
          classify: { planned: 0, success: 0, failed: 0, skipped: 0, blocked: 0 },
          archive: { planned: 0, success: 0, failed: 0, skipped: 0, blocked: 0 }
        },
        "FYI/Reference": {
          classify: { planned: 0, success: 0, failed: 0, skipped: 0, blocked: 0 },
          archive: { planned: 0, success: 0, failed: 0, skipped: 0, blocked: 0 }
        },
        "Bulk/Archive": {
          classify: { planned: 0, success: 0, failed: 0, skipped: 0, blocked: 0 },
          archive: { planned: 0, success: 0, failed: 0, skipped: 0, blocked: 0 }
        }
      }
    }
  };
}

test("evaluateExpansionGate blocks when processed count, precision, or sign-off are below gate requirements", () => {
  const result = evaluateExpansionGate({
    processed_count: 499,
    archive_precision_estimate: 0.9799,
    no_touch_miss_count: 0
  });

  assert.equal(result.allowed, false);
  assert.equal(result.conditions.processed_count_met, false);
  assert.equal(result.conditions.archive_precision_met, false);
  assert.equal(result.conditions.no_touch_misses_met, true);
  assert.equal(result.conditions.sign_off_met, false);
});

test("gate evidence unions and sums across live run records for the account", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-test-"));
  const runsDir = path.join(dir, "runs");
  await fs.mkdir(runsDir, { recursive: true });

  const writeRun = async (runId: string, ids: string[], attempts: number, successes: number, misses: number) => {
    await fs.writeFile(
      path.join(runsDir, `${runId}.json`),
      `${JSON.stringify(
        {
          run_id: runId,
          mode: "live-apply",
          account: "pilot@example.com",
          message_ids: ids,
          archive_attempt_tallies: { clean_attempts: attempts, clean_successes: successes },
          metrics: { no_touch_miss_count: misses }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  };

  await writeRun("live-1", ["msg-1", "msg-2"], 2, 1, 1);
  await writeRun("live-2", ["msg-2", "msg-3"], 2, 2, 0);
  // Noise that must be ignored: an ingest file and another account's record.
  await fs.writeFile(path.join(runsDir, "live-1-ingest.json"), "{\n", "utf8");
  await writeRun("live-3", ["other-account"], 5, 5, 0);
  const other = JSON.parse(await fs.readFile(path.join(runsDir, "live-3.json"), "utf8"));
  other.account = "elsewhere@example.com";
  await fs.writeFile(path.join(runsDir, "live-3.json"), `${JSON.stringify(other, null, 2)}\n`, "utf8");

  const runPath = path.join(runsDir, "live-2.json");
  const evidence = await loadGateEvidence(runPath);

  assert.equal(evidence.source, "cumulative across 2 run(s)");
  assert.equal(evidence.metrics.processed_count, 3); // union across runs
  assert.equal(evidence.metrics.archive_precision_estimate, 0.75); // 3/4
  assert.equal(evidence.metrics.no_touch_miss_count, 1);
  assert.equal(evaluateExpansionGate(evidence.metrics).allowed, false); // no sign-off
});

test("gate evidence falls back to the run record without a ledger", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-test-"));
  const runsDir = path.join(dir, "runs");
  await fs.mkdir(runsDir, { recursive: true });

  const runPath = path.join(runsDir, "live-2.json");
  await fs.writeFile(
    runPath,
    `${JSON.stringify({ run_id: "live-2", mode: "live-apply", account: "pilot@example.com", metrics: { processed_count: 10, archive_precision_estimate: 0.5, no_touch_miss_count: 1 } }, null, 2)}\n`,
    "utf8"
  );

  const evidence = await loadGateEvidence(runPath);
  assert.equal(evidence.source, "run record");
  assert.equal(evidence.metrics.processed_count, 10);
  assert.equal(evidence.metrics.no_touch_miss_count, 1);
});

test("evaluateExpansionGate blocks outright on any no-touch miss", () => {
  const result = evaluateExpansionGate(
    {
      processed_count: 900,
      archive_precision_estimate: 1,
      no_touch_miss_count: 1
    },
    {
      recorded: true,
      decision: "go",
      recorded_at: "2026-01-10T00:00:00.000Z"
    }
  );

  assert.equal(result.allowed, false);
  assert.equal(result.conditions.no_touch_misses_met, false);
});

test("recordExpansionSignOff writes a separate immutable sign-off file and keeps the run record unchanged", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-"));
  const runsDir = path.join(dataDir, "runs");
  await fs.mkdir(runsDir, { recursive: true });
  const runPath = path.join(runsDir, "live-1.json");

  const runRecord = buildRunRecord({
    processed_count: 750,
    archive_precision_estimate: 0.991,
    no_touch_miss_count: 0
  });

  await fs.writeFile(runPath, `${JSON.stringify(runRecord, null, 2)}\n`, "utf8");

  const signOff = await recordExpansionSignOff(runPath, {
    decision: "go",
    actor: "pilot-owner",
    recordedAt: "2026-01-12T09:30:00.000Z"
  });

  assert.deepEqual(signOff, {
    recorded: true,
    decision: "go",
    recorded_at: "2026-01-12T09:30:00.000Z",
    actor: "pilot-owner"
  });

  const signOffPath = path.join(dataDir, "signoffs", "live-1.json");
  const signOffRecord = JSON.parse(await fs.readFile(signOffPath, "utf8"));
  assert.equal(signOffRecord.run_id, "live-1");
  assert.equal(signOffRecord.decision, "go");
  assert.equal(signOffRecord.recorded_at, "2026-01-12T09:30:00.000Z");
  assert.equal(signOffRecord.actor, "pilot-owner");

  assert.deepEqual(JSON.parse(await fs.readFile(runPath, "utf8")), runRecord);

  const metrics = await loadExpansionGateMetricsFromRun(runPath);
  assert.equal(metrics.processed_count, 750);
  assert.equal(metrics.archive_precision_estimate, 0.991);
  assert.equal(metrics.no_touch_miss_count, 0);

  const loadedSignOff = await loadExpansionSignOffFromRun(runPath);
  assert.deepEqual(loadedSignOff, signOff);

  const evaluation = evaluateExpansionGate(metrics, loadedSignOff);
  assert.equal(evaluation.allowed, true);
  assert.deepEqual(evaluation.conditions, {
    processed_count_met: true,
    archive_precision_met: true,
    no_touch_misses_met: true,
    sign_off_met: true
  });
});

test("loadExpansionSignOffFromRun returns undefined when no sign-off has been recorded", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-"));
  const runsDir = path.join(dataDir, "runs");
  await fs.mkdir(runsDir, { recursive: true });
  const runPath = path.join(runsDir, "live-1.json");

  await fs.writeFile(
    runPath,
    `${JSON.stringify(
      buildRunRecord({
        processed_count: 900,
        archive_precision_estimate: 1,
        no_touch_miss_count: 0
      }),
      null,
      2
    )}\n`,
    "utf8"
  );

  assert.equal(await loadExpansionSignOffFromRun(runPath), undefined);
});
