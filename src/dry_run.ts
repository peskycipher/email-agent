import path from "node:path";

import type { MailboxAdapter } from "./adapter.ts";
import { classifyMessagesForDryRun } from "./classify/pipeline.ts";
import { OllamaCloudClassifier, type SecondPassClassifier } from "./classify/ollama.ts";
import { JevSystem1Classifier, type ClassifierSystem1 } from "./classify/system1.ts";
import { buildConfigSnapshot } from "./config.ts";
import { buildNoTouchDryRunPlan } from "./policy.ts";
import { persistDryRunArtifacts, type PlannedAction } from "./store.ts";

export type DryRunOptions = {
  adapter: MailboxAdapter;
  account: string;
  dataDir: string;
  limit: number;
  now?: () => Date;
  vipSenders?: string[];
  financeLegalKeywords?: string[];
  recentDays?: number;
  auditLogPath?: string;
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

export async function runDryRun(options: DryRunOptions): Promise<DryRunResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = `run-${startedAt.getTime()}`;

  const messages = await options.adapter.listRecentInbox(options.limit);
  const plan = buildNoTouchDryRunPlan(messages, {
    vipSenders: options.vipSenders,
    financeLegalKeywords: options.financeLegalKeywords,
    recentDays: options.recentDays,
    now
  });

  const config = buildConfigSnapshot({
    account: options.account,
    auditLogPath: options.auditLogPath ?? path.resolve("data", "audit.jsonl"),
    recentDays: options.recentDays,
    confidenceThreshold: options.confidenceThreshold,
    vipSenders: options.vipSenders,
    financeLegalKeywords: options.financeLegalKeywords
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
      rationale: classified.rationale
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
    exceptionQueue: plan.exceptionQueue,
    config
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
