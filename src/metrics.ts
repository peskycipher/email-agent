import type { MailboxAction } from "./adapter.ts";
import { EMAIL_CATEGORIES, type EmailCategory } from "./classify/categories.ts";
import type { ExceptionQueueItem } from "./store.ts";

export type AppliedActionStatus = "success" | "failed" | "skipped" | "blocked";

export type EvaluatedAction = {
  message_id: string;
  action: MailboxAction;
  category: EmailCategory;
  status: AppliedActionStatus;
};

export type ActionTotals = {
  planned: number;
  success: number;
  failed: number;
  skipped: number;
  blocked: number;
};

export type CategoryActionTotals = Record<EmailCategory, Record<MailboxAction, ActionTotals>>;

export type ExpansionSignOffDecision = "go" | "no-go";

export type ExpansionSignOff = {
  recorded: boolean;
  decision?: ExpansionSignOffDecision;
  recorded_at?: string;
  actor?: string;
  note?: string;
};

export type RunMetrics = {
  processed_count: number;
  archive_precision_estimate: number;
  no_touch_miss_count: number;
  category_totals: CategoryActionTotals;
  expansion_sign_off: ExpansionSignOff;
};

export type BuildRunMetricsInput = {
  evaluatedActions: EvaluatedAction[];
  exceptionQueue: ExceptionQueueItem[];
};

function createActionTotals(): ActionTotals {
  return {
    planned: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    blocked: 0
  };
}

function createCategoryTotals(): CategoryActionTotals {
  return Object.fromEntries(
    EMAIL_CATEGORIES.map((category) => [
      category,
      {
        classify: createActionTotals(),
        archive: createActionTotals()
      }
    ])
  ) as CategoryActionTotals;
}

export function buildRunMetrics(input: BuildRunMetricsInput): RunMetrics {
  const categoryTotals = createCategoryTotals();

  for (const action of input.evaluatedActions) {
    const totals = categoryTotals[action.category][action.action];
    totals.planned += 1;
    totals[action.status] += 1;
  }

  const exceptionMessageIds = new Set(input.exceptionQueue.map((item) => item.message_id));

  // An archive "attempt" is one that was actually sent to the adapter:
  // success or failed. Skipped and blocked actions never reached the adapter.
  const archiveAttempts = input.evaluatedActions.filter(
    (action) => action.action === "archive" && (action.status === "success" || action.status === "failed")
  );

  // Clean archive attempts target ids NOT in the exception queue. A 0-attempt
  // pilot run carries no evidence of imprecision, so it is treated as perfect.
  const cleanArchiveAttempts = archiveAttempts.filter((action) => !exceptionMessageIds.has(action.message_id));
  const cleanArchiveSuccesses = cleanArchiveAttempts.filter((action) => action.status === "success").length;

  // A no-touch miss is any archive attempt (success or failed) on a protected id.
  // Blocked actions are not attempts: the guard did its job.
  const noTouchMissCount = archiveAttempts.filter((action) => exceptionMessageIds.has(action.message_id)).length;

  const archivePrecisionEstimate =
    cleanArchiveAttempts.length === 0 ? 1 : Number((cleanArchiveSuccesses / cleanArchiveAttempts.length).toFixed(4));

  return {
    processed_count: new Set(input.evaluatedActions.map((action) => action.message_id)).size,
    archive_precision_estimate: archivePrecisionEstimate,
    no_touch_miss_count: noTouchMissCount,
    category_totals: categoryTotals,
    expansion_sign_off: {
      recorded: false
    }
  };
}
