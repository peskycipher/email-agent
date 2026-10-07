import type { MailboxMessage } from "../adapter.ts";
import { fetchJson, type FetchFn } from "../http.ts";
import { isEmailCategory, type EmailCategory } from "./categories.ts";

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
};

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";

function includesAny(value: string, keywords: string[]): string | undefined {
  const lowered = value.toLowerCase();
  return keywords.find((keyword) => lowered.includes(keyword));
}

function toClassificationRequest(message: MailboxMessage, model: string): Record<string, unknown> {
  return {
    model,
    state: {
      request: [
        "Classify email:",
        `Subject: ${message.subject}`,
        `From: ${message.from}`,
        "Body snippet: (not available)"
      ].join(" "),
      conversation_excerpt: null,
      environment: {
        cwd: null,
        active_model: null,
        context_tokens_used: null
      },
      budget: {
        spent_today_usd: 0,
        spent_this_month_usd: 0,
        daily_cap_usd: null,
        monthly_cap_usd: null,
        fraction_of_budget_used: 0
      }
    },
    questions: {
      email_category: {
        type: "choice",
        instructions: "Classify the email in `request` into exactly one of the four categories.",
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

  constructor(options: JevSystem1ClassifierOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.TYPESAFE_API_URL ?? DEFAULT_BASE_URL;
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/systemone`;
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async classify(message: MailboxMessage): Promise<System1Classification> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error("Missing TYPESAFE_API_KEY");
    }

    const response = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(toClassificationRequest(message, this.model))
    });

    const payload = await fetchJson(response, "JEV System1 response");

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

    const actionKeyword = includesAny(subject, ["action required", "urgent", "asap", "approval", "invoice", "payment", "contract"]);
    if (actionKeyword) {
      return {
        category: "Action Needed",
        confidence: 0.92,
        rationale: `keyword '${actionKeyword}'`
      };
    }

    const waitingKeyword = includesAny(subject, ["follow-up", "follow up", "waiting", "pending", "check in", "reminder"]);
    if (waitingKeyword) {
      return {
        category: "Waiting/Follow-up",
        confidence: 0.84,
        rationale: `keyword '${waitingKeyword}'`
      };
    }

    const archiveKeyword = includesAny(subject, ["newsletter", "unsubscribe", "promo", "digest", "sale"]);
    if (archiveKeyword) {
      return {
        category: "Bulk/Archive",
        confidence: 0.88,
        rationale: `keyword '${archiveKeyword}'`
      };
    }

    const referenceKeyword = includesAny(subject, ["fyi", "reference", "minutes", "receipt", "summary", "update"]);
    if (referenceKeyword) {
      return {
        category: "FYI/Reference",
        confidence: 0.76,
        rationale: `keyword '${referenceKeyword}'`
      };
    }

    return {
      category: "FYI/Reference",
      confidence: 0.45,
      rationale: "low-confidence default"
    };
  }
}
