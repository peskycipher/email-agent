import type { EmailCategory } from "./categories.ts";

export type KeywordRule = {
  category: EmailCategory;
  keywords: string[];
  pipelineRationale: string;
  fallbackConfidence: number;
  appliesToPipeline: boolean;
};

export const KEYWORD_RULES: KeywordRule[] = [
  {
    category: "Bulk/Archive",
    keywords: ["newsletter", "unsubscribe", "digest"],
    pipelineRationale: "keyword rule: newsletter/unsubscribe/digest",
    fallbackConfidence: 0.88,
    appliesToPipeline: true
  },
  {
    category: "Waiting/Follow-up",
    keywords: ["follow-up", "follow up", "waiting", "pending"],
    pipelineRationale: "keyword rule: follow-up/waiting",
    fallbackConfidence: 0.84,
    appliesToPipeline: true
  },
  {
    category: "Action Needed",
    keywords: ["urgent", "approval", "invoice"],
    pipelineRationale: "keyword rule: invoice/approval/urgent",
    fallbackConfidence: 0.92,
    appliesToPipeline: true
  },
  {
    category: "Action Needed",
    keywords: ["action required", "asap", "payment", "contract"],
    pipelineRationale: "keyword rule: invoice/approval/urgent",
    fallbackConfidence: 0.92,
    appliesToPipeline: false
  },
  {
    category: "Waiting/Follow-up",
    keywords: ["check in", "reminder"],
    pipelineRationale: "keyword rule: follow-up/waiting",
    fallbackConfidence: 0.84,
    appliesToPipeline: false
  },
  {
    category: "Bulk/Archive",
    keywords: ["promo", "sale"],
    pipelineRationale: "keyword rule: newsletter/unsubscribe/digest",
    fallbackConfidence: 0.88,
    appliesToPipeline: false
  },
  {
    category: "FYI/Reference",
    keywords: ["fyi", "reference", "minutes", "receipt", "summary", "update"],
    pipelineRationale: "keyword rule: fyi/reference",
    fallbackConfidence: 0.76,
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
