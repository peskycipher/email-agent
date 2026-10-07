import fs from "node:fs/promises";
import path from "node:path";

import type { MailboxAdapter, MailboxAction, MailboxMessage } from "./adapter.ts";
import { appendAuditRecord } from "./audit.ts";
import { collectPlannedCategories, requireApprovalDecisions, type CategoryApprovals } from "./approval.ts";
import { isEmailCategory, type EmailCategory } from "./classify/categories.ts";
import { buildRunMetrics, type EvaluatedAction } from "./metrics.ts";
import { buildRunReport } from "./report.ts";
import type { ExceptionQueueItem, PlannedAction } from "./store.ts";

type StoredDryRunPlan = {
  plan_id: string;
  run_id: string;
  actions: PlannedAction[];
  exception_queue?: ExceptionQueueItem[];
};

type AppliedAction = {
  message_id: string;
  action: MailboxAction;
  category: EmailCategory;
  outcome: string;
};

export type LiveApplyOptions = {
  adapter: MailboxAdapter;
  account: string;
  dataDir: string;
  planPath: string;
  auditLogPath: string;
  approvals: CategoryApprovals;
  now?: () => Date;
};

export type LiveApplyResult = {
  runId: string;
  runPath: string;
  sourcePlanId: string;
  appliedActions: number;
  skippedActions: number;
};

function toRationaleText(action: PlannedAction): string {
  if (!action.rationale) {
    return `plan-action:${action.action}`;
  }

  const policy = action.rationale.policy.map((entry) => `policy:${entry}`);
  const rule = action.rationale.rule.map((entry) => `rule:${entry}`);
  const model = action.rationale.model.map((entry) => `model:${entry}`);
  const combined = [...policy, ...rule, ...model];

  if (combined.length === 0) {
    return `plan-action:${action.action}`;
  }

  return combined.join("; ");
}

async function readDryRunPlan(planPath: string): Promise<StoredDryRunPlan> {
  const raw = await fs.readFile(planPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.actions)) {
    throw new Error(`Invalid dry-run plan file: ${planPath}`);
  }

  if (typeof parsed.plan_id !== "string" || parsed.plan_id.trim().length === 0) {
    throw new Error(`Invalid dry-run plan file: missing plan_id in ${planPath}`);
  }

  if (typeof parsed.run_id !== "string" || parsed.run_id.trim().length === 0) {
    throw new Error(`Invalid dry-run plan file: missing run_id in ${planPath}`);
  }

  if (parsed.exception_queue !== undefined && !Array.isArray(parsed.exception_queue)) {
    throw new Error(`Invalid dry-run plan file: exception_queue must be an array in ${planPath}`);
  }

  return parsed as StoredDryRunPlan;
}

function validateAction(action: PlannedAction): void {
  if (action.action !== "classify" && action.action !== "archive") {
    throw new Error(`Invalid planned action ${String(action.action)} for message ${action.message_id}`);
  }

  if (action.action === "classify" && (!action.category || !isEmailCategory(action.category))) {
    throw new Error(`Invalid category in dry-run plan for message ${action.message_id}`);
  }
}

function buildCategoryByMessage(actions: PlannedAction[]): Map<string, EmailCategory> {
  const categoryByMessageId = new Map<string, EmailCategory>();

  for (const action of actions) {
    validateAction(action);

    if (action.action !== "classify") {
      continue;
    }

    if (!action.category || !isEmailCategory(action.category)) {
      throw new Error(`Invalid category in dry-run plan for message ${action.message_id}`);
    }

    categoryByMessageId.set(action.message_id, action.category);
  }

  return categoryByMessageId;
}

function resolveActionCategory(action: PlannedAction, categoryByMessageId: Map<string, EmailCategory>): EmailCategory {
  if (action.action === "classify") {
    if (!action.category || !isEmailCategory(action.category)) {
      throw new Error(`Invalid category in dry-run plan for message ${action.message_id}`);
    }

    return action.category;
  }

  const category = categoryByMessageId.get(action.message_id);
  if (!category) {
    throw new Error(`Missing classify action for archived message ${action.message_id}`);
  }

  return category;
}

function toMailboxMessages(value: unknown): MailboxMessage[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const messages: MailboxMessage[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      return undefined;
    }

    const message = item as Record<string, unknown>;
    if (
      typeof message.id !== "string" ||
      typeof message.from !== "string" ||
      typeof message.subject !== "string" ||
      typeof message.date !== "string" ||
      typeof message.unread !== "boolean" ||
      typeof message.flagged !== "boolean" ||
      !Array.isArray(message.categories) ||
      message.categories.some((category) => typeof category !== "string")
    ) {
      return undefined;
    }

    messages.push({
      id: message.id,
      from: message.from,
      subject: message.subject,
      date: message.date,
      unread: message.unread,
      flagged: message.flagged,
      categories: [...message.categories]
    });
  }

  return messages;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readSourceIngestMessages(dataDir: string, sourceRunId: string): Promise<MailboxMessage[] | undefined> {
  const sourceRunPath = path.join(dataDir, "runs", `${sourceRunId}.json`);

  let sourceRunRaw: string;
  try {
    sourceRunRaw = await fs.readFile(sourceRunPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  const sourceRun = JSON.parse(sourceRunRaw) as { ingest_path?: unknown };
  if (typeof sourceRun.ingest_path !== "string" || sourceRun.ingest_path.trim().length === 0) {
    return undefined;
  }

  let ingestRaw: string;
  try {
    ingestRaw = await fs.readFile(sourceRun.ingest_path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  const ingest = JSON.parse(ingestRaw) as { messages?: unknown };
  return toMailboxMessages(ingest.messages);
}

export async function runLiveApply(options: LiveApplyOptions): Promise<LiveApplyResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = `live-${startedAt.getTime()}`;

  const plan = await readDryRunPlan(options.planPath);
  const categoryByMessageId = buildCategoryByMessage(plan.actions);
  const plannedCategories = collectPlannedCategories(plan.actions);
  const decisions = requireApprovalDecisions(plannedCategories, options.approvals);

  const appliedActions: AppliedAction[] = [];
  const evaluatedActions: EvaluatedAction[] = [];
  let skippedActions = 0;

  for (const action of plan.actions) {
    validateAction(action);

    const category = resolveActionCategory(action, categoryByMessageId);
    if (!decisions[category]) {
      skippedActions += 1;
      evaluatedActions.push({
        message_id: action.message_id,
        action: action.action,
        category,
        status: "skipped"
      });
      continue;
    }

    const result = await options.adapter.apply(action.message_id, action.action, action.action === "classify" ? category : undefined);
    const status: EvaluatedAction["status"] = result.ok ? "success" : "failed";
    const outcome = result.ok ? "success" : `failed:${result.error ?? "unknown"}`;

    await appendAuditRecord(options.auditLogPath, {
      timestamp: now().toISOString(),
      account: options.account,
      message_id: action.message_id,
      action: action.action,
      category,
      outcome,
      rationale: toRationaleText(action),
      run_id: runId
    });

    appliedActions.push({
      message_id: action.message_id,
      action: action.action,
      category,
      outcome
    });

    evaluatedActions.push({
      message_id: action.message_id,
      action: action.action,
      category,
      status
    });
  }

  const exceptionQueue = plan.exception_queue ?? [];
  const sourceMessages = await readSourceIngestMessages(options.dataDir, plan.run_id);
  const metrics = buildRunMetrics({
    evaluatedActions,
    exceptionQueue
  });
  const report = buildRunReport({
    plannedActions: plan.actions,
    evaluatedActions,
    categoryTotals: metrics.category_totals,
    exceptionQueue,
    sourceMessages
  });

  const runsDir = path.join(options.dataDir, "runs");
  await fs.mkdir(runsDir, { recursive: true });
  const runPath = path.join(runsDir, `${runId}.json`);

  await fs.writeFile(
    runPath,
    `${JSON.stringify(
      {
        run_id: runId,
        account: options.account,
        created_at: startedAt.toISOString(),
        mode: "live-apply",
        source_plan_id: plan.plan_id,
        source_plan_path: options.planPath,
        source_run_id: plan.run_id,
        approvals: decisions,
        applied_actions: appliedActions,
        skipped_actions: skippedActions,
        report,
        metrics
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    runId,
    runPath,
    sourcePlanId: plan.plan_id,
    appliedActions: appliedActions.length,
    skippedActions
  };
}
