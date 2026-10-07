import fs from "node:fs/promises";

import type { ExpansionSignOff, ExpansionSignOffDecision, RunMetrics } from "./metrics.ts";

export const EXPANSION_GATE_MIN_PROCESSED_COUNT = 500;
export const EXPANSION_GATE_MIN_ARCHIVE_PRECISION = 0.98;

export type GateMetrics = Pick<RunMetrics, "processed_count" | "archive_precision_estimate" | "no_touch_miss_count"> & {
  expansion_sign_off: ExpansionSignOff;
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

function parseExpansionSignOff(value: unknown): ExpansionSignOff {
  if (value === undefined) {
    return { recorded: false };
  }

  assertObject(value, "Invalid run metrics: expansion_sign_off must be an object");

  if (typeof value.recorded !== "boolean") {
    throw new Error("Invalid run metrics: expansion_sign_off.recorded must be a boolean");
  }

  if (!value.recorded) {
    return { recorded: false };
  }

  const decision = value.decision;
  if (decision !== "go" && decision !== "no-go") {
    throw new Error("Invalid run metrics: expansion_sign_off.decision must be 'go' or 'no-go'");
  }

  if (value.recorded_at !== undefined && typeof value.recorded_at !== "string") {
    throw new Error("Invalid run metrics: expansion_sign_off.recorded_at must be a string when set");
  }

  if (value.actor !== undefined && typeof value.actor !== "string") {
    throw new Error("Invalid run metrics: expansion_sign_off.actor must be a string when set");
  }

  if (value.note !== undefined && typeof value.note !== "string") {
    throw new Error("Invalid run metrics: expansion_sign_off.note must be a string when set");
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
    no_touch_miss_count: value.no_touch_miss_count,
    expansion_sign_off: parseExpansionSignOff(value.expansion_sign_off)
  };
}

async function readRunRecord(runPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(runPath, "utf8");
  const parsed = JSON.parse(raw);
  assertObject(parsed, `Invalid run record: ${runPath}`);
  return parsed;
}

export async function loadExpansionGateMetricsFromRun(runPath: string): Promise<GateMetrics> {
  const runRecord = await readRunRecord(runPath);
  return parseGateMetrics(runRecord.metrics);
}

export function evaluateExpansionGate(metrics: GateMetrics): ExpansionGateEvaluation {
  const processedCountPass = metrics.processed_count >= EXPANSION_GATE_MIN_PROCESSED_COUNT;
  const archivePrecisionPass = metrics.archive_precision_estimate >= EXPANSION_GATE_MIN_ARCHIVE_PRECISION;
  const noTouchMissPass = metrics.no_touch_miss_count === 0;
  const explicitSignOffPass = metrics.expansion_sign_off.recorded && metrics.expansion_sign_off.decision === "go";

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

export async function recordExpansionSignOff(runPath: string, input: RecordExpansionSignOffInput): Promise<GateMetrics> {
  const runRecord = await readRunRecord(runPath);
  const metrics = parseGateMetrics(runRecord.metrics);

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

  const updatedMetrics = {
    ...(runRecord.metrics as Record<string, unknown>),
    expansion_sign_off: signOff
  };

  await fs.writeFile(
    runPath,
    `${JSON.stringify(
      {
        ...runRecord,
        metrics: updatedMetrics
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    ...metrics,
    expansion_sign_off: signOff
  };
}
