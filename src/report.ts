import type { MailboxMessage } from "./adapter.ts";
import { isEmailCategory, type EmailCategory } from "./classify/categories.ts";
import type { RationaleTrace } from "./classify/pipeline.ts";
import type { CategoryActionTotals, EvaluatedAction } from "./metrics.ts";
import type { ExceptionQueueItem, PlannedAction } from "./store.ts";

const DEFAULT_TRACE_SAMPLE_SIZE = 5;

export type TraceSample = {
  message_id: string;
  category: EmailCategory;
  rationale: RationaleTrace;
};

export type RunReport = {
  summary: {
    category_action_totals: CategoryActionTotals;
    unread_before: number | null;
    unread_after: number | null;
    unread_delta: number | null;
    ingest_unavailable?: true;
  };
  trace_samples: TraceSample[];
  exception_queue_snapshot: ExceptionQueueItem[];
};

export type BuildRunReportInput = {
  plannedActions: PlannedAction[];
  evaluatedActions: EvaluatedAction[];
  categoryTotals: CategoryActionTotals;
  exceptionQueue: ExceptionQueueItem[];
  sourceMessages?: MailboxMessage[];
  traceSampleSize?: number;
};

function buildTraceSamples(plannedActions: PlannedAction[], sampleSize: number): TraceSample[] {
  const samples: TraceSample[] = [];

  for (const action of plannedActions) {
    if (action.action !== "classify" || !isEmailCategory(action.category)) {
      continue;
    }

    samples.push({
      message_id: action.message_id,
      category: action.category,
      rationale: {
        policy: [...(action.rationale?.policy ?? [])],
        rule: [...(action.rationale?.rule ?? [])],
        model: [...(action.rationale?.model ?? [])]
      }
    });

    if (samples.length >= sampleSize) {
      break;
    }
  }

  return samples;
}

function computeUnreadSummary(sourceMessages: MailboxMessage[] | undefined, evaluatedActions: EvaluatedAction[]): {
  unreadBefore: number | null;
  unreadAfter: number | null;
  unreadDelta: number | null;
  ingestUnavailable: boolean;
} {
  if (!sourceMessages) {
    return {
      unreadBefore: null,
      unreadAfter: null,
      unreadDelta: null,
      ingestUnavailable: true
    };
  }

  const archivedMessageIds = evaluatedActions
    .filter((action) => action.action === "archive" && action.status === "success")
    .map((action) => action.message_id);

  const unreadMessageIds = new Set(sourceMessages.filter((message) => message.unread).map((message) => message.id));
  const unreadBefore = unreadMessageIds.size;

  let unreadArchivedCount = 0;
  for (const messageId of archivedMessageIds) {
    if (unreadMessageIds.has(messageId)) {
      unreadArchivedCount += 1;
    }
  }

  const unreadAfter = Math.max(0, unreadBefore - unreadArchivedCount);

  return {
    unreadBefore,
    unreadAfter,
    unreadDelta: unreadBefore - unreadAfter,
    ingestUnavailable: false
  };
}

export function buildRunReport(input: BuildRunReportInput): RunReport {
  const unread = computeUnreadSummary(input.sourceMessages, input.evaluatedActions);

  return {
    summary: {
      category_action_totals: input.categoryTotals,
      unread_before: unread.unreadBefore,
      unread_after: unread.unreadAfter,
      unread_delta: unread.unreadDelta,
      ...(unread.ingestUnavailable ? { ingest_unavailable: true } : {})
    },
    trace_samples: buildTraceSamples(input.plannedActions, input.traceSampleSize ?? DEFAULT_TRACE_SAMPLE_SIZE),
    exception_queue_snapshot: input.exceptionQueue.map((item) => ({
      message_id: item.message_id,
      reasons: [...item.reasons],
      unread: item.unread
    }))
  };
}
