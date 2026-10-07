import type { MailboxMessage } from "./adapter.ts";
import { type EmailCategory } from "./classify/categories.ts";
import { DEFAULT_RECENT_DAYS } from "./config.ts";
import type { ExceptionQueueItem } from "./store.ts";

export type NoTouchReason = "vip-sender" | "flagged" | "recent-thread" | "finance-legal-keyword";

export type NoTouchPolicyOptions = {
  vipSenders?: string[];
  financeLegalKeywords?: string[];
  recentDays?: number;
  now?: () => Date;
};

export type NoTouchDryRunPlan = {
  exceptionQueue: ExceptionQueueItem[];
};

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
    return true;
  }

  const ageMs = now.getTime() - messageTime;
  if (ageMs < 0) {
    return true;
  }

  return ageMs <= recentDays * 24 * 60 * 60 * 1000;
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

export function evaluateNoTouchReasons(message: Pick<MailboxMessage, "from" | "subject" | "date" | "flagged">, options: NoTouchPolicyOptions = {}): NoTouchReason[] {
  const now = options.now ? options.now() : new Date();
  const vipSenders = normalizeList(options.vipSenders);
  const financeLegalKeywords = normalizeList(options.financeLegalKeywords);
  const recentDays = options.recentDays ?? DEFAULT_RECENT_DAYS;
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

export function shouldArchiveCategory(category: EmailCategory): boolean {
  return category === "Bulk/Archive" || category === "FYI/Reference";
}

export function buildNoTouchDryRunPlan(messages: MailboxMessage[], options: NoTouchPolicyOptions = {}): NoTouchDryRunPlan {
  const exceptionQueue: ExceptionQueueItem[] = [];

  for (const message of messages) {
    const reasons = evaluateNoTouchReasons(message, options);
    if (reasons.length === 0) {
      continue;
    }

    exceptionQueue.push({
      message_id: message.id,
      reasons,
      unread: message.unread
    });
  }

  return {
    exceptionQueue
  };
}
