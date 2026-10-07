import fs from "node:fs/promises";
import path from "node:path";

import { isMissingFileError } from "./http.ts";
import type { RunMetrics } from "./metrics.ts";
import { precisionFromTallies } from "./metrics.ts";
import { signOffPathForRun } from "./store.ts";

export const EXPANSION_GATE_MIN_PROCESSED_COUNT = 500;
export const EXPANSION_GATE_MIN_ARCHIVE_PRECISION = 0.98;

export type GateMetrics = Pick<RunMetrics, "processed_count" | "archive_precision_estimate" | "no_touch_miss_count">;

export type ExpansionSignOffDecision = "go" | "no-go";

export type ExpansionSignOff = {
  recorded: true;
  decision: ExpansionSignOffDecision;
  recorded_at?: string;
  actor?: string;
  note?: string;
};

export type ExpansionGateEvaluation = {
  allowed: boolean;
  conditions: {
    processed_count_met: boolean;
    archive_precision_met: boolean;
    no_touch_misses_met: boolean;
    sign_off_met: boolean;
  };
};

export type RecordExpansionSignOffInput = {
  decision: ExpansionSignOffDecision;
  actor?: string;
  note?: string;
  recordedAt?: string;
};

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(message);
  }
}

function parseGateMetrics(value: unknown): GateMetrics {
  assertObject(value, "Invalid run record: missing metrics object");

  if (typeof value.processed_count !== "number" || !Number.isFinite(value.processed_count)) {
    throw new Error("Invalid run metrics: processed_count must be a finite number");
  }

  if (typeof value.archive_precision_estimate !== "number" || !Number.isFinite(value.archive_precision_estimate)) {
    throw new Error("Invalid run metrics: archive_precision_estimate must be a finite number");
  }

  if (typeof value.no_touch_miss_count !== "number" || !Number.isFinite(value.no_touch_miss_count)) {
    throw new Error("Invalid run metrics: no_touch_miss_count must be a finite number");
  }

  return {
    processed_count: value.processed_count,
    archive_precision_estimate: value.archive_precision_estimate,
    no_touch_miss_count: value.no_touch_miss_count
  };
}

function parseExpansionSignOff(value: unknown): ExpansionSignOff {
  assertObject(value, "Invalid expansion sign-off: expected an object");

  if (value.recorded !== true) {
    throw new Error("Invalid expansion sign-off: recorded must be true");
  }

  const decision = value.decision;
  if (decision !== "go" && decision !== "no-go") {
    throw new Error("Invalid expansion sign-off: decision must be 'go' or 'no-go'");
  }

  if (value.recorded_at !== undefined && typeof value.recorded_at !== "string") {
    throw new Error("Invalid expansion sign-off: recorded_at must be a string when set");
  }

  if (value.actor !== undefined && typeof value.actor !== "string") {
    throw new Error("Invalid expansion sign-off: actor must be a string when set");
  }

  if (value.note !== undefined && typeof value.note !== "string") {
    throw new Error("Invalid expansion sign-off: note must be a string when set");
  }

  const signOff: ExpansionSignOff = {
    recorded: true,
    decision
  };

  if (typeof value.recorded_at === "string") {
    signOff.recorded_at = value.recorded_at;
  }

  if (typeof value.actor === "string") {
    signOff.actor = value.actor;
  }

  if (typeof value.note === "string") {
    signOff.note = value.note;
  }

  return signOff;
}

async function readRunRecord(runPath: string): Promise<{ run_id: string; account?: unknown; metrics: unknown }> {
  const raw = await fs.readFile(runPath, "utf8");
  const parsed = JSON.parse(raw);
  assertObject(parsed, `Invalid run record: ${runPath}`);

  if (typeof parsed.run_id !== "string" || parsed.run_id.trim().length === 0) {
    throw new Error(`Invalid run record: missing run_id in ${runPath}`);
  }

  return {
    run_id: parsed.run_id,
    account: parsed.account,
    metrics: parsed.metrics
  };
}

export type GateEvidence = {
  metrics: GateMetrics;
  source: string;
};

/**
 * Union/sum gate evidence across a pilot account's immutable live run records.
 * Returns undefined when no live run carries the evidence fields (never invents evidence).
 */
async function readCumulativeRunEvidence(dataDir: string, account: string): Promise<{ metrics: GateMetrics; runIds: string[] } | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(dataDir, "runs"));
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  const processed = new Set<string>();
  const runIds: string[] = [];
  let attempts = 0;
  let successes = 0;
  let misses = 0;

  for (const entry of entries.filter((name) => name.endsWith(".json") && !name.endsWith("-ingest.json"))) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dataDir, "runs", entry), "utf8"));
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }

    // Only live-apply records for the account that carry the evidence fields qualify;
    // a malformed record is skipped rather than failing the whole scan.
    if (
      parsed.mode !== "live-apply" ||
      parsed.account !== account ||
      !Array.isArray(parsed.message_ids) ||
      typeof parsed.archive_attempt_tallies !== "object" ||
      parsed.archive_attempt_tallies === null
    ) {
      continue;
    }

    const tallies = parsed.archive_attempt_tallies as { clean_attempts?: unknown; clean_successes?: unknown };
    const metricsRecord = (parsed.metrics ?? {}) as { no_touch_miss_count?: unknown };
    if (typeof tallies.clean_attempts !== "number" || typeof tallies.clean_successes !== "number") {
      continue;
    }

    for (const id of parsed.message_ids as unknown[]) {
      if (typeof id === "string") {
        processed.add(id);
      }
    }
    if (typeof parsed.run_id === "string") {
      runIds.push(parsed.run_id);
    }
    attempts += tallies.clean_attempts;
    successes += tallies.clean_successes;
    misses += typeof metricsRecord.no_touch_miss_count === "number" ? metricsRecord.no_touch_miss_count : 0;
  }

  if (runIds.length === 0) {
    return undefined;
  }

  return {
    metrics: {
      processed_count: processed.size,
      archive_precision_estimate: precisionFromTallies(successes, attempts),
      no_touch_miss_count: misses
    },
    runIds
  };
}

export async function loadGateEvidence(runPath: string): Promise<GateEvidence> {
  const runRecord = await readRunRecord(runPath);

  // Cumulative pilot evidence: scan the account's immutable live run records.
  const account = typeof runRecord.account === "string" && runRecord.account.trim().length > 0 ? runRecord.account : undefined;
  if (account) {
    const cumulative = await readCumulativeRunEvidence(path.dirname(path.dirname(runPath)), account);
    if (cumulative) {
      return {
        metrics: cumulative.metrics,
        source: `cumulative across ${cumulative.runIds.length} run(s)`
      };
    }
  }

  return { metrics: parseGateMetrics(runRecord.metrics), source: "run record" };
}

export async function loadExpansionGateMetricsFromRun(runPath: string): Promise<GateMetrics> {
  const runRecord = await readRunRecord(runPath);
  return parseGateMetrics(runRecord.metrics);
}

export async function loadExpansionSignOffFromRun(runPath: string): Promise<ExpansionSignOff | undefined> {
  await readRunRecord(runPath);
  const signOffPath = signOffPathForRun(runPath);

  let raw: string;
  try {
    raw = await fs.readFile(signOffPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  return parseExpansionSignOff(JSON.parse(raw));
}

export function evaluateExpansionGate(metrics: GateMetrics, signOff?: ExpansionSignOff): ExpansionGateEvaluation {
  const processedCountPass = metrics.processed_count >= EXPANSION_GATE_MIN_PROCESSED_COUNT;
  const archivePrecisionPass = metrics.archive_precision_estimate >= EXPANSION_GATE_MIN_ARCHIVE_PRECISION;
  const noTouchMissPass = metrics.no_touch_miss_count === 0;
  const explicitSignOffPass = signOff?.recorded === true && signOff?.decision === "go";

  return {
    allowed: processedCountPass && archivePrecisionPass && noTouchMissPass && explicitSignOffPass,
    conditions: {
      processed_count_met: processedCountPass,
      archive_precision_met: archivePrecisionPass,
      no_touch_misses_met: noTouchMissPass,
      sign_off_met: explicitSignOffPass
    }
  };
}

export async function recordExpansionSignOff(runPath: string, input: RecordExpansionSignOffInput): Promise<ExpansionSignOff> {
  const runRecord = await readRunRecord(runPath);

  const signOff: ExpansionSignOff = {
    recorded: true,
    decision: input.decision,
    recorded_at: input.recordedAt ?? new Date().toISOString()
  };

  if (input.actor && input.actor.trim().length > 0) {
    signOff.actor = input.actor;
  }

  if (input.note && input.note.trim().length > 0) {
    signOff.note = input.note;
  }

  const signOffPath = signOffPathForRun(runPath);
  await fs.mkdir(path.dirname(signOffPath), { recursive: true });
  await fs.writeFile(
    signOffPath,
    `${JSON.stringify(
      {
        run_id: runRecord.run_id,
        ...signOff
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return signOff;
}
