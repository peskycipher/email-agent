import type { MailboxMessage } from "./adapter.ts";
import { ARCHIVE_VETO_LABELS, isArchiveSafe, type EmailLabel } from "./classify/labels.ts";
import type { ExceptionQueueItem } from "./store.ts";

export type NoTouchReason = "vip-sender" | "flagged" | "finance-legal-keyword";

export type NoTouchPolicyOptions = {
  vipSenders?: string[];
  financeLegalKeywords?: string[];
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

export function evaluateNoTouchReasons(message: Pick<MailboxMessage, "from" | "subject" | "flagged">, options: NoTouchPolicyOptions = {}): NoTouchReason[] {
  const vipSenders = normalizeList(options.vipSenders);
  const financeLegalKeywords = normalizeList(options.financeLegalKeywords);
  const reasons: NoTouchReason[] = [];

  if (vipSenders.has(message.from.trim().toLowerCase())) {
    reasons.push("vip-sender");
  }

  if (message.flagged) {
    reasons.push("flagged");
  }

  if (hasKeywordMatch(message.subject, financeLegalKeywords)) {
    reasons.push("finance-legal-keyword");
  }

  return reasons;
}

export function shouldArchiveLabels(labels: EmailLabel[]): boolean {
  // A veto label anywhere wins, even alongside an archive-safe label.
  if (labels.some((label) => ARCHIVE_VETO_LABELS.includes(label))) {
    return false;
  }

  return labels.some(isArchiveSafe);
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
