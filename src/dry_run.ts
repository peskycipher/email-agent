import type { MailboxAdapter } from "./adapter.ts";
import { persistDryRunArtifacts } from "./store.ts";

export type DryRunOptions = {
  adapter: MailboxAdapter;
  account: string;
  dataDir: string;
  limit: number;
  now?: () => Date;
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
  const plannedActions = messages.map((message) => ({
    message_id: message.id,
    action: "classify" as const,
    category: "FYI/Reference"
  }));

  const persisted = await persistDryRunArtifacts(options.dataDir, {
    runId,
    account: options.account,
    createdAt: startedAt.toISOString(),
    messages,
    plannedActions
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
