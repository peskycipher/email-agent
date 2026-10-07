import type { MailboxAdapter } from "./adapter.ts";
import { classifyMessagesForDryRun } from "./classify/pipeline.ts";
import { OllamaCloudClassifier, type SecondPassClassifier } from "./classify/ollama.ts";
import { JevSystem1Classifier, type ClassifierSystem1 } from "./classify/system1.ts";
import type { ConfigSnapshot } from "./config.ts";
import { buildNoTouchDryRunPlan, shouldArchiveCategory } from "./policy.ts";
import { persistDryRunArtifacts, type PlannedAction } from "./store.ts";

export type DryRunOptions = {
  adapter: MailboxAdapter;
  config: ConfigSnapshot;
  dataDir: string;
  limit: number;
  now?: () => Date;
  system1Classifier?: ClassifierSystem1;
  secondPassClassifier?: SecondPassClassifier;
};

export type DryRunResult = {
  runId: string;
  planId: string;
  planPath: string;
  runPath: string;
  ingestPath: string;
  ingestedCount: number;
};

export async function runDryRun(options: DryRunOptions): Promise<DryRunResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = `run-${startedAt.getTime()}`;

  const messages = await options.adapter.listRecentInbox(options.limit);
  const plan = buildNoTouchDryRunPlan(messages, {
    vipSenders: options.config.vipSenders,
    financeLegalKeywords: options.config.financeLegalKeywords,
    recentDays: options.config.recentDays,
    now
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
    confidenceThreshold: options.config.confidenceThreshold
  });

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
      rationale: classified.rationale
    });

    const noTouchReasons = noTouchReasonsByMessageId.get(message.id) ?? [];
    if (noTouchReasons.length === 0 && shouldArchiveCategory(classified.category)) {
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
    ingestedCount: messages.length
  };
}
