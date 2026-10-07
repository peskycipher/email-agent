import type { MailboxAdapter, MailboxMessage } from "./adapter.ts";
import { EMAIL_LABELS, type EmailLabel } from "./classify/labels.ts";
import { classifyMessagesForDryRun } from "./classify/pipeline.ts";
import { OllamaCloudClassifier, type SecondPassClassifier } from "./classify/ollama.ts";
import { JevSystem1Classifier, type ClassifierSystem1 } from "./classify/system1.ts";
import type { ConfigSnapshot } from "./config.ts";
import { buildNoTouchDryRunPlan, shouldArchiveLabels } from "./policy.ts";
import { buildSenderLabelResolver } from "./sender_labels.ts";
import { persistDryRunArtifacts, type ExceptionQueueItem, type PlannedAction } from "./store.ts";

export type DryRunOptions = {
  adapter: MailboxAdapter;
  config: ConfigSnapshot;
  dataDir: string;
  limit: number;
  now?: () => Date;
  system1Classifier?: ClassifierSystem1;
  secondPassClassifier?: SecondPassClassifier;
};

export type DryRunSummary = {
  ingested: number;
  labels: Record<EmailLabel, number>;
  archivesPlanned: number;
  protectedItems: number;
  noTouchReasons: Record<string, number>;
  durationMs: number;
};

export type DryRunResult = {
  runId: string;
  planId: string;
  planPath: string;
  runPath: string;
  ingestPath: string;
  ingestedCount: number;
  summary: DryRunSummary;
};

function buildDryRunSummary(
  messages: MailboxMessage[],
  plannedActions: PlannedAction[],
  exceptionQueue: ExceptionQueueItem[],
  durationMs: number
): DryRunSummary {
  const labels = Object.fromEntries(EMAIL_LABELS.map((label) => [label, 0])) as Record<EmailLabel, number>;
  let archivesPlanned = 0;

  for (const action of plannedActions) {
    if (action.action === "classify") {
      for (const label of action.labels) {
        labels[label] += 1;
      }
    } else {
      archivesPlanned += 1;
    }
  }

  const noTouchReasons: Record<string, number> = {};
  for (const item of exceptionQueue) {
    for (const reason of item.reasons) {
      noTouchReasons[reason] = (noTouchReasons[reason] ?? 0) + 1;
    }
  }

  return {
    ingested: messages.length,
    labels,
    archivesPlanned,
    protectedItems: exceptionQueue.length,
    noTouchReasons,
    durationMs
  };
}

export async function runDryRun(options: DryRunOptions): Promise<DryRunResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = `run-${startedAt.getTime()}`;

  const messages = await options.adapter.listRecentInbox(options.limit);
  const plan = buildNoTouchDryRunPlan(messages, {
    vipSenders: options.config.vipSenders,
    financeLegalKeywords: options.config.financeLegalKeywords
  });

  const system1Classifier = options.system1Classifier ?? new JevSystem1Classifier();
  const secondPassClassifier = options.secondPassClassifier ?? new OllamaCloudClassifier();

  const noTouchReasonsByMessageId = new Map<string, string[]>();
  for (const item of plan.exceptionQueue) {
    noTouchReasonsByMessageId.set(item.message_id, item.reasons);
  }

  const classifications = await classifyMessagesForDryRun(messages, noTouchReasonsByMessageId, {
    system1: system1Classifier,
    secondPass: secondPassClassifier,
    confidenceThreshold: options.config.confidenceThreshold,
    senderLabels: buildSenderLabelResolver({
      familySenders: options.config.familySenders,
      friendSenders: options.config.friendSenders
    })
  });

  const plannedActions: PlannedAction[] = [];

  for (const message of messages) {
    const classified = classifications.get(message.id);
    if (!classified) {
      throw new Error(`Missing classification for message ${message.id}`);
    }

    // No labels means nothing to write: skip the classify action entirely rather
    // than PATCHing an empty category set.
    if (classified.labels.length > 0) {
      plannedActions.push({
        message_id: message.id,
        action: "classify",
        labels: classified.labels,
        rationale: classified.rationale
      });
    }

    const noTouchReasons = noTouchReasonsByMessageId.get(message.id) ?? [];
    if (classified.labels.length > 0 && noTouchReasons.length === 0 && shouldArchiveLabels(classified.labels)) {
      plannedActions.push({
        message_id: message.id,
        action: "archive"
      });
    }
  }

  const persisted = await persistDryRunArtifacts(options.dataDir, {
    runId,
    account: options.config.account,
    createdAt: startedAt.toISOString(),
    messages,
    plannedActions,
    exceptionQueue: plan.exceptionQueue,
    config: options.config
  });

  return {
    runId,
    planId: persisted.planId,
    planPath: persisted.planPath,
    runPath: persisted.runPath,
    ingestPath: persisted.ingestPath,
    ingestedCount: messages.length,
    summary: buildDryRunSummary(messages, plannedActions, plan.exceptionQueue, now().getTime() - startedAt.getTime())
  };
}
