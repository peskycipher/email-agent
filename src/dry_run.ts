import type { MailboxAdapter } from "./adapter.ts";
import { buildNoTouchDryRunPlan } from "./policy.ts";
import { persistDryRunArtifacts } from "./store.ts";

export type DryRunOptions = {
  adapter: MailboxAdapter;
  account: string;
  dataDir: string;
  limit: number;
  now?: () => Date;
  vipSenders?: string[];
  financeLegalKeywords?: string[];
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
    now
  });

  const persisted = await persistDryRunArtifacts(options.dataDir, {
    runId,
    account: options.account,
    createdAt: startedAt.toISOString(),
    messages,
    plannedActions: plan.plannedActions,
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
