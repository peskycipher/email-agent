import fs from "node:fs/promises";
import path from "node:path";

import type { MailboxAction, MailboxMessage } from "./adapter.ts";

export type PlannedAction = {
  message_id: string;
  action: MailboxAction;
  category?: string;
  rationale?: {
    policy: string[];
    rule: string[];
    model: string[];
  };
};

export type ExceptionQueueItem = {
  message_id: string;
  reasons: string[];
};

export type PersistDryRunInput = {
  runId: string;
  account: string;
  createdAt: string;
  messages: MailboxMessage[];
  plannedActions: PlannedAction[];
  exceptionQueue: ExceptionQueueItem[];
};

export type PersistDryRunOutput = {
  planId: string;
  planPath: string;
  runPath: string;
  ingestPath: string;
};

export async function persistDryRunArtifacts(dataDir: string, input: PersistDryRunInput): Promise<PersistDryRunOutput> {
  const plansDir = path.join(dataDir, "plans");
  const runsDir = path.join(dataDir, "runs");
  await fs.mkdir(plansDir, { recursive: true });
  await fs.mkdir(runsDir, { recursive: true });

  const planId = `plan-${input.runId}`;
  const planPath = path.join(plansDir, `${planId}.json`);
  const runPath = path.join(runsDir, `${input.runId}.json`);
  const ingestPath = path.join(runsDir, `${input.runId}-ingest.json`);

  const planRecord = {
    plan_id: planId,
    run_id: input.runId,
    account: input.account,
    created_at: input.createdAt,
    dry_run: true,
    actions: input.plannedActions,
    exception_queue: input.exceptionQueue
  };

  const runRecord = {
    run_id: input.runId,
    account: input.account,
    created_at: input.createdAt,
    mode: "dry-run",
    plan_id: planId,
    ingest_path: ingestPath,
    plan_path: planPath,
    planned_actions: input.plannedActions,
    exception_queue: input.exceptionQueue
  };

  const ingestRecord = {
    run_id: input.runId,
    account: input.account,
    ingested_at: input.createdAt,
    messages: input.messages
  };

  await fs.writeFile(planPath, `${JSON.stringify(planRecord, null, 2)}\n`, "utf8");
  await fs.writeFile(runPath, `${JSON.stringify(runRecord, null, 2)}\n`, "utf8");
  await fs.writeFile(ingestPath, `${JSON.stringify(ingestRecord, null, 2)}\n`, "utf8");

  return {
    planId,
    planPath,
    runPath,
    ingestPath
  };
}
