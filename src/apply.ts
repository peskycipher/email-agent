import fs from "node:fs/promises";
import path from "node:path";

import type { MailboxAdapter, MailboxAction, MailboxMessage } from "./adapter.ts";
import { appendAuditRecord } from "./audit.ts";
import { collectPlannedCategories, requireApprovalDecisions, type CategoryApprovals } from "./approval.ts";
import { isEmailCategory, type EmailCategory } from "./classify/categories.ts";
import { buildConfigSnapshot, type ConfigSnapshot } from "./config.ts";
import { isMissingFileError } from "./http.ts";
import { buildRunMetrics, precisionFromTallies, type EvaluatedAction } from "./metrics.ts";
import { evaluateNoTouchReasons } from "./policy.ts";
import { buildRunReport } from "./report.ts";
import { ingestRecordPath, runRecordPath, type ExceptionQueueItem, type PlannedAction } from "./store.ts";

type StoredDryRunPlan = {
  plan_id: string;
  run_id: string;
  actions: PlannedAction[];
  exception_queue: ExceptionQueueItem[];
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
  config?: ConfigSnapshot;
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

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(message);
  }
}

function parseRationale(value: unknown): PlannedAction["rationale"] {
  if (value === undefined) {
    return undefined;
  }

  assertObject(value, "Invalid dry-run plan file: rationale must be an object");

  const parseList = (item: unknown, key: string): string[] => {
    if (!Array.isArray(item) || item.some((entry) => typeof entry !== "string")) {
      throw new Error(`Invalid dry-run plan file: rationale.${key} must be an array of strings`);
    }
    return [...item];
  };

  return {
    policy: parseList(value.policy, "policy"),
    rule: parseList(value.rule, "rule"),
    model: parseList(value.model, "model")
  };
}

function parsePlannedAction(value: unknown): PlannedAction {
  assertObject(value, "Invalid dry-run plan file: action must be an object");

  if (typeof value.message_id !== "string" || value.message_id.trim().length === 0) {
    throw new Error("Invalid dry-run plan file: action.message_id must be a non-empty string");
  }

  if (value.action === "archive") {
    return {
      message_id: value.message_id,
      action: "archive",
      rationale: parseRationale(value.rationale)
    };
  }

  if (value.action === "classify") {
    if (typeof value.category !== "string" || !isEmailCategory(value.category)) {
      throw new Error(`Invalid category in dry-run plan for message ${value.message_id}`);
    }

    return {
      message_id: value.message_id,
      action: "classify",
      category: value.category,
      rationale: parseRationale(value.rationale)
    };
  }

  throw new Error(`Invalid planned action ${String(value.action)} for message ${value.message_id}`);
}

function parseExceptionQueueItem(value: unknown): ExceptionQueueItem {
  assertObject(value, "Invalid dry-run plan file: exception_queue entry must be an object");

  if (typeof value.message_id !== "string" || value.message_id.trim().length === 0) {
    throw new Error("Invalid dry-run plan file: exception_queue.message_id must be a non-empty string");
  }

  if (!Array.isArray(value.reasons) || value.reasons.some((reason) => typeof reason !== "string")) {
    throw new Error(`Invalid dry-run plan file: exception_queue reasons must be string[] for message ${value.message_id}`);
  }

  if (value.unread !== undefined && typeof value.unread !== "boolean") {
    throw new Error(`Invalid dry-run plan file: exception_queue unread must be boolean for message ${value.message_id}`);
  }

  return {
    message_id: value.message_id,
    reasons: [...value.reasons],
    unread: value.unread ?? false
  };
}

async function readDryRunPlan(planPath: string): Promise<StoredDryRunPlan> {
  const raw = await fs.readFile(planPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.actions)) {
    throw new Error(`Invalid dry-run plan file: ${planPath}`);
  }

  if (typeof parsed.plan_id !== "string" || parsed.plan_id.trim().length === 0) {
    throw new Error(`Invalid dry-run plan file: missing plan_id in ${planPath}`);
  }

  if (typeof parsed.run_id !== "string" || parsed.run_id.trim().length === 0) {
    throw new Error(`Invalid dry-run plan file: missing run_id in ${planPath}`);
  }

  const exceptionQueueRaw = parsed.exception_queue;
  if (exceptionQueueRaw !== undefined && !Array.isArray(exceptionQueueRaw)) {
    throw new Error(`Invalid dry-run plan file: exception_queue must be an array in ${planPath}`);
  }

  return {
    plan_id: parsed.plan_id,
    run_id: parsed.run_id,
    actions: parsed.actions.map((action) => parsePlannedAction(action)),
    exception_queue: (exceptionQueueRaw ?? []).map((item) => parseExceptionQueueItem(item))
  };
}

function buildCategoryByMessage(actions: PlannedAction[]): Map<string, EmailCategory> {
  const categoryByMessageId = new Map<string, EmailCategory>();

  for (const action of actions) {
    if (action.action !== "classify") {
      continue;
    }

    categoryByMessageId.set(action.message_id, action.category);
  }

  return categoryByMessageId;
}

function resolveActionCategory(action: PlannedAction, categoryByMessageId: Map<string, EmailCategory>): EmailCategory {
  if (action.action === "classify") {
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

async function readSourceIngestMessages(dataDir: string, sourceRunId: string): Promise<MailboxMessage[] | undefined> {
  const sourceRunPath = runRecordPath(dataDir, sourceRunId);

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
  const fallbackIngestPath = ingestRecordPath(dataDir, sourceRunId);
  const ingestPath = typeof sourceRun.ingest_path === "string" && sourceRun.ingest_path.trim().length > 0 ? sourceRun.ingest_path : fallbackIngestPath;

  let ingestRaw: string;
  try {
    ingestRaw = await fs.readFile(ingestPath, "utf8");
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

  const exceptionQueue = plan.exception_queue;
  const protectedMessageIds = new Set(exceptionQueue.map((item) => item.message_id));
  const sourceMessages = await readSourceIngestMessages(options.dataDir, plan.run_id);
  const sourceMessageById = new Map((sourceMessages ?? []).map((message) => [message.id, message]));
  const existingCategoriesByMessageId = new Map((sourceMessages ?? []).map((message) => [message.id, message.categories]));
  const config = options.config ?? buildConfigSnapshot({ account: options.account, auditLogPath: options.auditLogPath });

  const appliedActions: AppliedAction[] = [];
  const evaluatedActions: EvaluatedAction[] = [];
  let skippedActions = 0;

  for (const action of plan.actions) {
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

    if (action.action === "archive" && protectedMessageIds.has(action.message_id)) {
      evaluatedActions.push({
        message_id: action.message_id,
        action: action.action,
        category,
        status: "blocked"
      });

      await appendAuditRecord(options.auditLogPath, {
        timestamp: now().toISOString(),
        account: options.account,
        message_id: action.message_id,
        action: action.action,
        category,
        outcome: "blocked:no-touch",
        rationale: toRationaleText(action),
        run_id: runId
      });
      continue;
    }

    if (action.action === "archive") {
      let currentMessage;
      try {
        currentMessage = await options.adapter.getMessage(action.message_id);
      } catch {
        evaluatedActions.push({
          message_id: action.message_id,
          action: action.action,
          category,
          status: "failed",
          operationalFailure: true
        });

        await appendAuditRecord(options.auditLogPath, {
          timestamp: now().toISOString(),
          account: options.account,
          message_id: action.message_id,
          action: action.action,
          category,
          outcome: "failed:mailbox-fetch",
          rationale: toRationaleText(action),
          run_id: runId
        });
        continue;
      }

      const sourceMessage = sourceMessageById.get(action.message_id);
      const noTouchReasons = evaluateNoTouchReasons(
        {
          from: currentMessage.from,
          subject: currentMessage.subject,
          date: sourceMessage?.date ?? "",
          flagged: currentMessage.flagged
        },
        {
          vipSenders: config.vipSenders,
          financeLegalKeywords: config.financeLegalKeywords,
          recentDays: config.recentDays,
          now
        }
      );

      if (noTouchReasons.length > 0) {
        evaluatedActions.push({
          message_id: action.message_id,
          action: action.action,
          category,
          status: "blocked"
        });

        await appendAuditRecord(options.auditLogPath, {
          timestamp: now().toISOString(),
          account: options.account,
          message_id: action.message_id,
          action: action.action,
          category,
          outcome: "blocked:no-touch",
          rationale: toRationaleText(action),
          run_id: runId
        });
        continue;
      }
    }

    const existingCategories = action.action === "classify" ? existingCategoriesByMessageId.get(action.message_id) : undefined;
    const result = await options.adapter.apply(
      action.message_id,
      action.action,
      action.action === "classify" ? category : undefined,
      existingCategories
    );
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

  const metrics = buildRunMetrics({
    evaluatedActions,
    exceptionQueue
  });

  // Per-run evidence for the gate's cumulative scan (see gate.readCumulativeRunEvidence).
  // Immutable by design: each run record carries its own tallies; the gate unions/sums across records.
  const archiveAttempts = evaluatedActions.filter(
    (action) =>
      action.action === "archive" &&
      (action.status === "success" || action.status === "failed") &&
      !action.operationalFailure &&
      !protectedMessageIds.has(action.message_id)
  );
  const cleanArchiveAttempts = archiveAttempts.length;
  const cleanArchiveSuccesses = archiveAttempts.filter((action) => action.status === "success").length;

  const report = buildRunReport({
    plannedActions: plan.actions,
    evaluatedActions,
    categoryTotals: metrics.category_totals,
    exceptionQueue,
    sourceMessages
  });

  const runPath = runRecordPath(options.dataDir, runId);
  await fs.mkdir(path.dirname(runPath), { recursive: true });

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
        config,
        approvals: decisions,
        applied_actions: appliedActions,
        skipped_actions: skippedActions,
        message_ids: [...new Set(evaluatedActions.map((action) => action.message_id))],
        archive_attempt_tallies: {
          clean_attempts: cleanArchiveAttempts,
          clean_successes: cleanArchiveSuccesses
        },
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
