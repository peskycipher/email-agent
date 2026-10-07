import type { MailboxMessage } from "../adapter.ts";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "../config.ts";
import { isEmailLabel, type EmailLabel } from "./labels.ts";
import type { SecondPassClassifier } from "./ollama.ts";
import { KEYWORD_RULES, findKeywordRuleMatchInMessage } from "./rules.ts";
import { KeywordSystem1Fallback, type ClassifierSystem1, type System1Classification } from "./system1.ts";

export type RationaleTrace = {
  policy: string[];
  rule: string[];
  model: string[];
};

export type MessageClassification = {
  messageId: string;
  labels: EmailLabel[];
  rationale: RationaleTrace;
};

export type ClassificationPipelineOptions = {
  system1: ClassifierSystem1;
  secondPass: SecondPassClassifier;
  /** Used when the System1 call itself fails; defaults to KeywordSystem1Fallback. */
  system1Fallback?: ClassifierSystem1;
  confidenceThreshold?: number;
  /** Family/Friends (and any other config-driven labels) resolved from the sender. */
  senderLabels?: (message: MailboxMessage) => EmailLabel[];
};

function uniqueLabels(labels: EmailLabel[]): EmailLabel[] {
  return [...new Set(labels)];
}

function classifyByRules(message: MailboxMessage): { labels: EmailLabel[]; rationale: string } | undefined {
  const existing = message.categories.filter(isEmailLabel);
  if (existing.length > 0) {
    return {
      labels: existing,
      rationale: "existing mailbox label"
    };
  }

  const match = findKeywordRuleMatchInMessage(
    { subject: message.subject, ...(message.body === undefined ? {} : { body: message.body }) },
    KEYWORD_RULES.filter((rule) => rule.appliesToPipeline)
  );
  if (!match) {
    return undefined;
  }

  return {
    labels: match.rule.labels,
    rationale: `${match.rule.pipelineRationale} (${match.field})`
  };
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

  // Sender-derived labels (Family/Friends/IT News) come from the sender, not the
  // content, so they apply regardless of which other path classifies the message.
  const resolvedSenderLabels = options.senderLabels ? options.senderLabels(message) : [];

  if (policyReasons.length > 0) {
    rationale.rule.push("protected-message-routed-to-manual-label");
    return {
      messageId: message.id,
      labels: uniqueLabels(["Action Needed", ...resolvedSenderLabels]),
      rationale
    };
  }

  const byRule = classifyByRules(message);
  if (byRule) {
    rationale.rule.push(byRule.rationale);
    return {
      messageId: message.id,
      labels: uniqueLabels([...byRule.labels, ...resolvedSenderLabels]),
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

    const fallback = await (options.system1Fallback ?? new KeywordSystem1Fallback()).classify(message);
    // Keep the fallback below the threshold so System1-unavailable items still escalate to the second pass.
    system1Result = {
      ...fallback,
      confidence: Math.min(fallback.confidence, Math.max(0, confidenceThreshold - 0.01))
    };

    rationale.model.push(`system1-fallback:${fallback.rationale}:confidence=${system1Result.confidence.toFixed(2)}`);
  }

  if (system1Result.confidence >= confidenceThreshold) {
    return {
      messageId: message.id,
      labels: uniqueLabels([...system1Result.labels, ...resolvedSenderLabels]),
      rationale
    };
  }

  try {
    const secondPassResult = await options.secondPass.classify(message);
    rationale.model.push(`ollama:${secondPassResult.model}:${secondPassResult.rationale}`);
    return {
      messageId: message.id,
      labels: uniqueLabels([...secondPassResult.labels, ...resolvedSenderLabels]),
      rationale
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    rationale.model.push(`ollama-fallback:${text}`);
    return {
      messageId: message.id,
      labels: uniqueLabels([...system1Result.labels, ...resolvedSenderLabels]),
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
