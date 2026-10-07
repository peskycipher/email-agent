import type { MailboxMessage } from "./adapter.ts";
import type { PlannedAction } from "./store.ts";

export type NoTouchReason = "vip-sender" | "flagged" | "recent-thread" | "finance-legal-keyword";

export type ExceptionQueueItem = {
  message_id: string;
  reasons: NoTouchReason[];
};

export type NoTouchPolicyOptions = {
  vipSenders?: string[];
  financeLegalKeywords?: string[];
  recentDays?: number;
  now?: () => Date;
};

export type NoTouchDryRunPlan = {
  plannedActions: PlannedAction[];
  exceptionQueue: ExceptionQueueItem[];
};

const DEFAULT_RECENT_DAYS = 7;

function normalizeList(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  );
}

function isRecentMessage(dateValue: string, now: Date, recentDays: number): boolean {
  const messageTime = Date.parse(dateValue);
  if (!Number.isFinite(messageTime)) {
    return false;
  }

  const ageMs = now.getTime() - messageTime;
  if (ageMs < 0) {
    return true;
  }

  return ageMs < recentDays * 24 * 60 * 60 * 1000;
}

function hasKeywordMatch(subject: string, keywords: Set<string>): boolean {
  if (keywords.size === 0) {
    return false;
  }

  const loweredSubject = subject.toLowerCase();
  for (const keyword of keywords) {
    if (loweredSubject.includes(keyword)) {
      return true;
    }
  }

  return false;
}

function evaluateNoTouchReasons(message: MailboxMessage, now: Date, vipSenders: Set<string>, financeLegalKeywords: Set<string>, recentDays: number): NoTouchReason[] {
  const reasons: NoTouchReason[] = [];

  if (vipSenders.has(message.from.trim().toLowerCase())) {
    reasons.push("vip-sender");
  }

  if (message.flagged) {
    reasons.push("flagged");
  }

  if (isRecentMessage(message.date, now, recentDays)) {
    reasons.push("recent-thread");
  }

  if (hasKeywordMatch(message.subject, financeLegalKeywords)) {
    reasons.push("finance-legal-keyword");
  }

  return reasons;
}

export function buildNoTouchDryRunPlan(messages: MailboxMessage[], options: NoTouchPolicyOptions = {}): NoTouchDryRunPlan {
  const now = options.now ? options.now() : new Date();
  const vipSenders = normalizeList(options.vipSenders);
  const financeLegalKeywords = normalizeList(options.financeLegalKeywords);
  const recentDays = options.recentDays ?? DEFAULT_RECENT_DAYS;

  const plannedActions: PlannedAction[] = [];
  const exceptionQueue: ExceptionQueueItem[] = [];

  for (const message of messages) {
    plannedActions.push({
      message_id: message.id,
      action: "classify",
      category: "FYI/Reference"
    });

    const reasons = evaluateNoTouchReasons(message, now, vipSenders, financeLegalKeywords, recentDays);
    if (reasons.length > 0) {
      exceptionQueue.push({
        message_id: message.id,
        reasons
      });
      continue;
    }

    plannedActions.push({
      message_id: message.id,
      action: "archive"
    });
  }

  return {
    plannedActions,
    exceptionQueue
  };
}
