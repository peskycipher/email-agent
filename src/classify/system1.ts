import type { MailboxMessage } from "../adapter.ts";
import type { EmailCategory } from "./categories.ts";

export type System1Classification = {
  category: EmailCategory;
  confidence: number;
  rationale: string;
};

export type ClassifierSystem1 = {
  classify(message: MailboxMessage): Promise<System1Classification>;
};

function includesAny(value: string, keywords: string[]): string | undefined {
  const lowered = value.toLowerCase();
  return keywords.find((keyword) => lowered.includes(keyword));
}

export class JevSystem1Classifier implements ClassifierSystem1 {
  async classify(message: MailboxMessage): Promise<System1Classification> {
    const subject = message.subject.trim();

    const actionKeyword = includesAny(subject, ["action required", "urgent", "asap", "approval", "invoice", "payment", "contract"]);
    if (actionKeyword) {
      return {
        category: "Action Needed",
        confidence: 0.92,
        rationale: `system1 keyword '${actionKeyword}'`
      };
    }

    const waitingKeyword = includesAny(subject, ["follow-up", "follow up", "waiting", "pending", "check in", "reminder"]);
    if (waitingKeyword) {
      return {
        category: "Waiting/Follow-up",
        confidence: 0.84,
        rationale: `system1 keyword '${waitingKeyword}'`
      };
    }

    const archiveKeyword = includesAny(subject, ["newsletter", "unsubscribe", "promo", "digest", "sale"]);
    if (archiveKeyword) {
      return {
        category: "Bulk/Archive",
        confidence: 0.88,
        rationale: `system1 keyword '${archiveKeyword}'`
      };
    }

    const referenceKeyword = includesAny(subject, ["fyi", "reference", "minutes", "receipt", "summary", "update"]);
    if (referenceKeyword) {
      return {
        category: "FYI/Reference",
        confidence: 0.76,
        rationale: `system1 keyword '${referenceKeyword}'`
      };
    }

    return {
      category: "FYI/Reference",
      confidence: 0.45,
      rationale: "system1 low-confidence default"
    };
  }
}
