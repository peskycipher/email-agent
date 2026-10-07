import type { MailboxMessage } from "../adapter.ts";
import { EMAIL_CATEGORIES, type EmailCategory } from "./categories.ts";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "../config.ts";
import type { SecondPassClassifier } from "./ollama.ts";
import { KeywordSystem1Fallback, type ClassifierSystem1, type System1Classification } from "./system1.ts";

export type RationaleTrace = {
  policy: string[];
  rule: string[];
  model: string[];
};

export type MessageClassification = {
  messageId: string;
  category: EmailCategory;
  rationale: RationaleTrace;
};

export type ClassificationPipelineOptions = {
  system1: ClassifierSystem1;
  secondPass: SecondPassClassifier;
  confidenceThreshold?: number;
};

function classifyByRules(message: MailboxMessage): { category: EmailCategory; rationale: string } | undefined {
  for (const category of message.categories) {
    if (EMAIL_CATEGORIES.includes(category as EmailCategory)) {
      return {
        category: category as EmailCategory,
        rationale: "existing mailbox category"
      };
    }
  }

  const subject = message.subject.toLowerCase();
  if (subject.includes("newsletter") || subject.includes("unsubscribe") || subject.includes("digest")) {
    return {
      category: "Bulk/Archive",
      rationale: "keyword rule: newsletter/unsubscribe/digest"
    };
  }

  if (subject.includes("follow-up") || subject.includes("follow up") || subject.includes("waiting") || subject.includes("pending")) {
    return {
      category: "Waiting/Follow-up",
      rationale: "keyword rule: follow-up/waiting"
    };
  }

  if (subject.includes("invoice") || subject.includes("approval") || subject.includes("urgent")) {
    return {
      category: "Action Needed",
      rationale: "keyword rule: invoice/approval/urgent"
    };
  }

  return undefined;
}

export async function classifyMessageForDryRun(
  message: MailboxMessage,
  policyReasons: string[],
  options: ClassificationPipelineOptions
): Promise<MessageClassification> {
  const rationale: RationaleTrace = {
    policy: policyReasons.map((reason) => `no-touch:${reason}`),
    rule: [],
    model: []
  };

  if (policyReasons.length > 0) {
    rationale.rule.push("protected-message-routed-to-manual-category");
    return {
      messageId: message.id,
      category: "Action Needed",
      rationale
    };
  }

  const byRule = classifyByRules(message);
  if (byRule) {
    rationale.rule.push(byRule.rationale);
    return {
      messageId: message.id,
      category: byRule.category,
      rationale
    };
  }

  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  let system1Result: System1Classification;
  try {
    system1Result = await options.system1.classify(message);
    rationale.model.push(`system1:${system1Result.rationale}:confidence=${system1Result.confidence.toFixed(2)}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    rationale.model.push(`system1-error:${reason}`);

    const fallback = await new KeywordSystem1Fallback().classify(message);
    const forcedConfidence = fallback.confidence <= confidenceThreshold ? fallback.confidence : confidenceThreshold - 0.01;
    system1Result = {
      ...fallback,
      confidence: forcedConfidence
    };

    rationale.model.push(`system1-fallback:${fallback.rationale}:confidence=${system1Result.confidence.toFixed(2)}`);
  }

  if (system1Result.confidence >= confidenceThreshold) {
    return {
      messageId: message.id,
      category: system1Result.category,
      rationale
    };
  }

  try {
    const secondPassResult = await options.secondPass.classify(message);
    rationale.model.push(`ollama:${secondPassResult.model}`);
    return {
      messageId: message.id,
      category: secondPassResult.category,
      rationale
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    rationale.model.push(`ollama-fallback:${text}`);
    return {
      messageId: message.id,
      category: system1Result.category,
      rationale
    };
  }
}

export async function classifyMessagesForDryRun(
  messages: MailboxMessage[],
  noTouchReasonsByMessageId: Map<string, string[]>,
  options: ClassificationPipelineOptions
): Promise<Map<string, MessageClassification>> {
  const results = new Map<string, MessageClassification>();

  for (const message of messages) {
    const policyReasons = noTouchReasonsByMessageId.get(message.id) ?? [];
    const classification = await classifyMessageForDryRun(message, policyReasons, options);
    results.set(message.id, classification);
  }

  return results;
}
