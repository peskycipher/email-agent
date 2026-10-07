import type { MailboxMessage } from "../adapter.ts";
import { defaultFetch, parseJsonBody, type FetchFn } from "../http.ts";
import { isEmailCategory, type EmailCategory } from "./categories.ts";
import { KEYWORD_RULES, findKeywordRuleMatch } from "./rules.ts";

export type System1Classification = {
  category: EmailCategory;
  confidence: number;
  rationale: string;
};

export type ClassifierSystem1 = {
  classify(message: MailboxMessage): Promise<System1Classification>;
};

export type JevSystem1ClassifierOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchFn?: FetchFn;
  /** Delay before the single 429/529 retry (docs recommend backoff; fixed delay, upgrade if noisy). */
  retryDelayMs?: number;
};

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";

function toClassificationRequest(message: MailboxMessage, model: string): Record<string, unknown> {
  // State is the email material only — descriptive fields, no filler,
  // per docs/typesafe-jev.skill.md ("State").
  return {
    model,
    state: {
      subject: message.subject,
      from: message.from,
      received_at: message.date,
      unread: message.unread,
      flagged: message.flagged,
      existing_categories: message.categories
    },
    questions: {
      email_category: {
        type: "choice",
        instructions: "Classify the email described by this state into exactly one of the four categories.",
        criteria: {
          "Action Needed": "requires a response or action from the recipient",
          "Waiting/Follow-up": "you are waiting on someone else or should follow up later",
          "FYI/Reference": "informational, reference material, no action needed",
          "Bulk/Archive": "mass mail, newsletters, promotions, notifications"
        }
      }
    }
  };
}

function readSystem1Error(payload: unknown, status: number): string {
  if (!payload || typeof payload !== "object") {
    return `JEV System1 request failed (${status})`;
  }

  const typedPayload = payload as { error?: unknown };
  if (typeof typedPayload.error === "string" && typedPayload.error.trim().length > 0) {
    return `JEV System1 request failed (${status}): ${typedPayload.error}`;
  }

  return `JEV System1 request failed (${status})`;
}

function clampConfidence(value: number): number {
  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

export class JevSystem1Classifier implements ClassifierSystem1 {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly fetchFn: FetchFn;
  private readonly retryDelayMs: number;

  constructor(options: JevSystem1ClassifierOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.TYPESAFE_API_URL ?? DEFAULT_BASE_URL;
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/systemone`;
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  async classify(message: MailboxMessage): Promise<System1Classification> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error("Missing TYPESAFE_API_KEY");
    }

    const requestInit: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(toClassificationRequest(message, this.model))
    };

    let response = await this.fetchFn(this.endpoint, requestInit);

    // ponytail: single fixed-delay retry on 429/529 per the docs' backoff guidance —
    // upgrade to exponential backoff only if retries prove noisy
    if (response.status === 429 || response.status === 529) {
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      response = await this.fetchFn(this.endpoint, requestInit);
    }

    const payload = await parseJsonBody(response, "JEV System1 response");

    if (!response.ok) {
      throw new Error(readSystem1Error(payload, response.status));
    }

    const answer = (payload as { answers?: { email_category?: { choice?: unknown; confidence?: unknown } } }).answers?.email_category;

    if (!answer || typeof answer.choice !== "string" || !isEmailCategory(answer.choice)) {
      throw new Error("JEV System1 returned an invalid category");
    }

    if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) {
      throw new Error("JEV System1 returned an invalid confidence");
    }

    const confidence = clampConfidence(answer.confidence);

    return {
      category: answer.choice,
      confidence,
      rationale: `jev:category=${answer.choice}:confidence=${confidence}`
    };
  }
}

export class KeywordSystem1Fallback implements ClassifierSystem1 {
  async classify(message: MailboxMessage): Promise<System1Classification> {
    const subject = message.subject.trim();

    const match = findKeywordRuleMatch(subject, KEYWORD_RULES);
    if (match) {
      return {
        category: match.rule.category,
        confidence: match.rule.fallbackConfidence,
        rationale: `keyword '${match.keyword}'`
      };
    }

    return {
      category: "FYI/Reference",
      confidence: 0.45,
      rationale: "low-confidence default"
    };
  }
}
