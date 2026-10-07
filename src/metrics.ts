import type { MailboxAction } from "./adapter.ts";
import { EMAIL_LABELS, type EmailLabel } from "./classify/labels.ts";
import type { ExceptionQueueItem } from "./store.ts";

export type AppliedActionStatus = "success" | "failed" | "skipped" | "blocked";

export type EvaluatedAction = {
  message_id: string;
  action: MailboxAction;
  /** All labels attached to the message; the first is the primary label used for totals. */
  labels: EmailLabel[];
  status: AppliedActionStatus;
  /** True when the action failed for operational reasons (e.g. mailbox fetch); excluded from precision and miss evidence. */
  operationalFailure?: boolean;
};

export type ActionTotals = {
  planned: number;
  success: number;
  failed: number;
  skipped: number;
  blocked: number;
};

export type LabelActionTotals = Record<EmailLabel, Record<MailboxAction, ActionTotals>>;

export type RunMetrics = {
  processed_count: number;
  archive_precision_estimate: number;
  no_touch_miss_count: number;
  label_totals: LabelActionTotals;
};

export type BuildRunMetricsInput = {
  evaluatedActions: EvaluatedAction[];
  exceptionQueue: ExceptionQueueItem[];
};

/** Shared precision formula: 0 attempts fails closed at 0, never 1. */
export function precisionFromTallies(successes: number, attempts: number): number {
  return attempts === 0 ? 0 : Number((successes / attempts).toFixed(4));
}

function createActionTotals(): ActionTotals {
  return {
    planned: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    blocked: 0
  };
}

function createLabelTotals(): LabelActionTotals {
  return Object.fromEntries(
    EMAIL_LABELS.map((label) => [
      label,
      {
        classify: createActionTotals(),
        archive: createActionTotals()
      }
    ])
  ) as LabelActionTotals;
}

export function buildRunMetrics(input: BuildRunMetricsInput): RunMetrics {
  const labelTotals = createLabelTotals();

  for (const action of input.evaluatedActions) {
    // Count each action once, under the message's primary label, so the totals
    // still sum to the number of actions rather than the number of labels.
    const primary = action.labels[0];
    if (!primary) {
      continue;
    }

    const totals = labelTotals[primary][action.action];
    totals.planned += 1;
    totals[action.status] += 1;
  }

  const exceptionMessageIds = new Set(input.exceptionQueue.map((item) => item.message_id));

  // Archive attempts feed precision/miss evidence; operational failures (fetch errors)
  // are excluded so transient issues neither distort precision nor count as policy misses.
  const archiveAttempts = input.evaluatedActions.filter(
    (action) =>
      action.action === "archive" &&
      (action.status === "success" || action.status === "failed") &&
      !action.operationalFailure
  );

  const cleanArchiveAttempts = archiveAttempts.filter((action) => !exceptionMessageIds.has(action.message_id));
  const cleanArchiveSuccesses = cleanArchiveAttempts.filter((action) => action.status === "success").length;

  const blockedArchiveActions = input.evaluatedActions.filter((action) => action.action === "archive" && action.status === "blocked").length;
  const protectedArchiveAttempts = archiveAttempts.filter((action) => exceptionMessageIds.has(action.message_id)).length;
  const noTouchMissCount = blockedArchiveActions + protectedArchiveAttempts;

  const archivePrecisionEstimate = precisionFromTallies(cleanArchiveSuccesses, cleanArchiveAttempts.length);

  return {
    processed_count: new Set(input.evaluatedActions.map((action) => action.message_id)).size,
    archive_precision_estimate: archivePrecisionEstimate,
    no_touch_miss_count: noTouchMissCount,
    label_totals: labelTotals
  };
}
