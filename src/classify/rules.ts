import type { EmailLabel } from "./labels.ts";

export type KeywordRule = {
  labels: EmailLabel[];
  keywords: string[];
  pipelineRationale: string;
  fallbackConfidence: number;
  appliesToPipeline: boolean;
};

export const KEYWORD_RULES: KeywordRule[] = [
  {
    labels: ["Newsletters"],
    keywords: ["newsletter", "unsubscribe", "digest"],
    pipelineRationale: "keyword rule: newsletter/unsubscribe/digest",
    fallbackConfidence: 0.88,
    appliesToPipeline: true
  },
  {
    labels: ["Waiting/Follow Up"],
    keywords: ["follow-up", "follow up", "waiting", "pending"],
    pipelineRationale: "keyword rule: follow-up/waiting",
    fallbackConfidence: 0.84,
    appliesToPipeline: true
  },
  {
    labels: ["Invoices", "Action Needed"],
    keywords: ["invoice", "approval", "urgent"],
    pipelineRationale: "keyword rule: invoice/approval/urgent",
    fallbackConfidence: 0.92,
    appliesToPipeline: true
  },
  {
    labels: ["Action Needed"],
    keywords: ["action required", "asap", "payment", "contract"],
    pipelineRationale: "keyword rule: action-required/asap/payment/contract",
    fallbackConfidence: 0.92,
    appliesToPipeline: false
  },
  {
    labels: ["Waiting/Follow Up"],
    keywords: ["check in", "reminder"],
    pipelineRationale: "keyword rule: check-in/reminder",
    fallbackConfidence: 0.84,
    appliesToPipeline: false
  },
  {
    labels: ["Promos"],
    keywords: ["promo", "sale", "% off", "discount"],
    pipelineRationale: "keyword rule: promo/sale/discount",
    fallbackConfidence: 0.88,
    appliesToPipeline: false
  },
  {
    labels: ["Subscriptions"],
    keywords: ["subscription", "renewal", "renews", "your plan"],
    pipelineRationale: "keyword rule: subscription/renewal",
    fallbackConfidence: 0.86,
    appliesToPipeline: false
  },
  {
    labels: ["Notifications"],
    keywords: ["notification", "verify", "validation code", "sign in"],
    pipelineRationale: "keyword rule: notification/verify/code",
    fallbackConfidence: 0.86,
    appliesToPipeline: false
  },
  {
    labels: ["IT News"],
    keywords: ["itnews"],
    pipelineRationale: "keyword rule: itnews",
    fallbackConfidence: 0.9,
    appliesToPipeline: false
  }
];

export function findKeywordRuleMatch(
  value: string,
  rules: KeywordRule[] = KEYWORD_RULES
): { rule: KeywordRule; keyword: string } | undefined {
  const lowered = value.toLowerCase();

  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      if (lowered.includes(keyword)) {
        return { rule, keyword };
      }
    }
  }

  return undefined;
}

/**
 * Match keyword rules against the subject first, then the body when the subject has
 * no match. Returns which field matched so rationale traces stay honest.
 */
export function findKeywordRuleMatchInMessage(
  message: { subject: string; body?: string },
  rules: KeywordRule[] = KEYWORD_RULES
): { rule: KeywordRule; keyword: string; field: "subject" | "body" } | undefined {
  const subjectMatch = findKeywordRuleMatch(message.subject, rules);
  if (subjectMatch) {
    return { ...subjectMatch, field: "subject" };
  }

  if (message.body) {
    const bodyMatch = findKeywordRuleMatch(message.body, rules);
    if (bodyMatch) {
      return { ...bodyMatch, field: "body" };
    }
  }

  return undefined;
}
