import fs from "node:fs/promises";
import path from "node:path";

import type { MailboxAction, MailboxMessage } from "./adapter.ts";
import type { EmailLabel } from "./classify/labels.ts";
import type { RationaleTrace } from "./classify/pipeline.ts";
import type { ConfigSnapshot } from "./config.ts";

export type PlannedAction =
  | {
      message_id: string;
      action: Extract<MailboxAction, "classify">;
      labels: EmailLabel[];
      rationale?: RationaleTrace;
    }
  | {
      message_id: string;
      action: Extract<MailboxAction, "archive">;
      rationale?: RationaleTrace;
    };

export type ExceptionQueueItem = {
  message_id: string;
  reasons: string[];
  unread: boolean;
};

export type PersistDryRunInput = {
  runId: string;
  account: string;
  createdAt: string;
  messages: MailboxMessage[];
  plannedActions: PlannedAction[];
  exceptionQueue: ExceptionQueueItem[];
  config: ConfigSnapshot;
};

export type PersistDryRunOutput = {
  planId: string;
  planPath: string;
  runPath: string;
  ingestPath: string;
};

export function runRecordPath(dataDir: string, runId: string): string {
  return path.join(dataDir, "runs", `${runId}.json`);
}

export function ingestRecordPath(dataDir: string, runId: string): string {
  return path.join(dataDir, "runs", `${runId}-ingest.json`);
}

export function signOffPathForRun(runPath: string): string {
  return path.join(path.dirname(path.dirname(runPath)), "signoffs", `${path.basename(runPath, ".json")}.json`);
}

export async function persistDryRunArtifacts(dataDir: string, input: PersistDryRunInput): Promise<PersistDryRunOutput> {
  const plansDir = path.join(dataDir, "plans");
  const runsDir = path.join(dataDir, "runs");
  await fs.mkdir(plansDir, { recursive: true });
  await fs.mkdir(runsDir, { recursive: true });

  const planId = `plan-${input.runId}`;
  const planPath = path.join(plansDir, `${planId}.json`);
  const runPath = runRecordPath(dataDir, input.runId);
  const ingestPath = ingestRecordPath(dataDir, input.runId);

  const planRecord = {
    plan_id: planId,
    run_id: input.runId,
    account: input.account,
    created_at: input.createdAt,
    dry_run: true,
    config: input.config,
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
    config: input.config,
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
