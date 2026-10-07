import type { MailboxAdapter } from "./adapter.ts";
import { classifyMessagesForDryRun, type ClassificationRationaleTrace } from "./classify/pipeline.ts";
import { OllamaCloudClassifier, type SecondPassClassifier } from "./classify/ollama.ts";
import { JevSystem1Classifier, type ClassifierSystem1 } from "./classify/system1.ts";
import { buildNoTouchDryRunPlan, type NoTouchReason } from "./policy.ts";
import { persistDryRunArtifacts, type PlannedAction } from "./store.ts";

export type DryRunOptions = {
  adapter: MailboxAdapter;
  account: string;
  dataDir: string;
  limit: number;
  now?: () => Date;
  vipSenders?: string[];
  financeLegalKeywords?: string[];
  system1Classifier?: ClassifierSystem1;
  secondPassClassifier?: SecondPassClassifier;
  confidenceThreshold?: number;
};

export type DryRunResult = {
  runId: string;
  planId: string;
  planPath: string;
  runPath: string;
  ingestPath: string;
  ingestedCount: number;
};

function toStoredRationale(rationale: ClassificationRationaleTrace): {
  policy: string[];
  rule: string[];
  model: string[];
} {
  return {
    policy: [...rationale.policy],
    rule: [...rationale.rule],
    model: [...rationale.model]
  };
}

export async function runDryRun(options: DryRunOptions): Promise<DryRunResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = `run-${startedAt.getTime()}`;

  const messages = await options.adapter.listRecentInbox(options.limit);
  const plan = buildNoTouchDryRunPlan(messages, {
    vipSenders: options.vipSenders,
    financeLegalKeywords: options.financeLegalKeywords,
    now
  });

  const system1Classifier = options.system1Classifier ?? new JevSystem1Classifier();
  const secondPassClassifier = options.secondPassClassifier ?? new OllamaCloudClassifier();

  const noTouchReasonsByMessageId = new Map<string, NoTouchReason[]>();
  for (const item of plan.exceptionQueue) {
    noTouchReasonsByMessageId.set(item.message_id, item.reasons);
  }

  const classifications = await classifyMessagesForDryRun(messages, noTouchReasonsByMessageId, {
    system1: system1Classifier,
    secondPass: secondPassClassifier,
    confidenceThreshold: options.confidenceThreshold
  });

  const archiveMessageIds = new Set(plan.plannedActions.filter((action) => action.action === "archive").map((action) => action.message_id));
  const plannedActions: PlannedAction[] = [];

  for (const message of messages) {
    const classified = classifications.get(message.id);
    if (!classified) {
      throw new Error(`Missing classification for message ${message.id}`);
    }

    plannedActions.push({
      message_id: message.id,
      action: "classify",
      category: classified.category,
      rationale: toStoredRationale(classified.rationale)
    });

    if (archiveMessageIds.has(message.id)) {
      plannedActions.push({
        message_id: message.id,
        action: "archive"
      });
    }
  }

  const persisted = await persistDryRunArtifacts(options.dataDir, {
    runId,
    account: options.account,
    createdAt: startedAt.toISOString(),
    messages,
    plannedActions,
    exceptionQueue: plan.exceptionQueue
  });

  return {
    runId,
    planId: persisted.planId,
    planPath: persisted.planPath,
    runPath: persisted.runPath,
    ingestPath: persisted.ingestPath,
    ingestedCount: messages.length
  };
}
