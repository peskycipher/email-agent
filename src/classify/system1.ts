import type { MailboxMessage } from "../adapter.ts";
import { defaultFetch, parseJsonBody, type FetchFn } from "../http.ts";
import { MODEL_INFERABLE_LABELS, type EmailLabel } from "./labels.ts";
import { KEYWORD_RULES, findKeywordRuleMatch } from "./rules.ts";

export type System1Classification = {
  labels: EmailLabel[];
  confidence: number;
  rationale: string;
};

export type ClassifierSystem1 = {
  classify(message: MailboxMessage): Promise<System1Classification>;
};

export type JevSystem1ClassifierOptions = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  fetchFn?: FetchFn;
  retryDelayMs?: number;
};

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";

/** Noul probability above which a label is attached. */
const LABEL_THRESHOLD = 0.7;

/** Human-readable rubric per label, used as the noul criteria text. */
const LABEL_CRITERIA: Record<EmailLabel, string> = {
  "Action Needed": "requires a response or action from the recipient",
  "Waiting/Follow Up": "the recipient is waiting on someone else or should follow up later",
  Important: "materially important to the recipient's money, housing, work, or obligations",
  Realestate: "about property: rentals, inspections, applications, agents, listings",
  Invoices: "an invoice, bill, receipt, payment request, or payment confirmation",
  Crypto: "about cryptocurrency, exchanges, tokens, or blockchain activity",
  Business: "commercial or business operations, partners, vendors, or company matters",
  Travel: "flights, hotels, itineraries, bookings, or trip logistics",
  Clients: "from or about a client of the recipient's business",
  Family: "from a family member",
  Friends: "from a friend",
  "IT News": "technology industry news or newsletters",
  Newsletters: "a newsletter, digest, or mass mailing",
  Promos: "a promotion, sale, discount, or marketing offer",
  Notifications: "an automated notification, alert, verification, or security message",
  Subscriptions: "a subscription, renewal, plan, or recurring service"
};

function toClassificationRequest(message: MailboxMessage, model: string): Record<string, unknown> {
  // State is the email material only — descriptive fields, no filler,
  // per docs/typesafe-jev.skill.md ("State").
  // One noul question per label: choice can only pick one option, so independent
  // yes/no questions are the documented way to attach several labels.
  const questions = Object.fromEntries(
    MODEL_INFERABLE_LABELS.map((label) => [
      label,
      {
        type: "noul",
        instructions: `Does this email belong to the label "${label}"?`,
        criteria: LABEL_CRITERIA[label]
      }
    ])
  );

  return {
    model,
    state: {
      subject: message.subject,
      from: message.from,
      received_at: message.date,
      unread: message.unread,
      flagged: message.flagged,
      existing_categories: message.categories,
      body: message.body ?? null
    },
    questions
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

type NoulAnswer = { type?: unknown; noul?: unknown };

function readLabels(payload: unknown): { labels: EmailLabel[]; probabilities: Array<[EmailLabel, number]> } {
  const answers = (payload as { answers?: Record<string, NoulAnswer> }).answers;
  if (!answers || typeof answers !== "object") {
    throw new Error("JEV System1 returned no answers");
  }

  const probabilities: Array<[EmailLabel, number]> = [];

  for (const label of MODEL_INFERABLE_LABELS) {
    const answer = answers[label];
    if (!answer || typeof answer !== "object") {
      continue;
    }

    if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
      throw new Error(`JEV System1 returned an invalid answer for ${label}`);
    }

    probabilities.push([label, clampConfidence(answer.noul)]);
  }

  if (probabilities.length === 0) {
    throw new Error("JEV System1 returned no usable label answers");
  }

  const labels = probabilities.filter(([, p]) => p >= LABEL_THRESHOLD).map(([label]) => label);
  return { labels, probabilities };
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

    const { labels, probabilities } = readLabels(payload);

    // Confidence = how far the decisive answers sit from the 0.5 decision boundary.
    // A confident yes/no on every label is 1; a pile of 0.5 answers is 0.
    const confidence = clampConfidence(
      probabilities.reduce((acc, [, p]) => acc + Math.abs(p - 0.5) * 2, 0) / probabilities.length
    );

    return {
      labels,
      confidence,
      rationale: `jev:labels=[${labels.join(", ")}]:confidence=${confidence.toFixed(2)}`
    };
  }
}

export class KeywordSystem1Fallback implements ClassifierSystem1 {
  async classify(message: MailboxMessage): Promise<System1Classification> {
    const subject = message.subject.trim();

    // Subject first, then body: the fallback stays deterministic and never guesses from nothing.
    const match = findKeywordRuleMatch(subject, KEYWORD_RULES) ?? (message.body ? findKeywordRuleMatch(message.body, KEYWORD_RULES) : undefined);
    if (match) {
      return {
        labels: [...match.rule.labels],
        confidence: match.rule.fallbackConfidence,
        rationale: `keyword '${match.keyword}'`
      };
    }

    return {
      labels: [],
      confidence: 0.45,
      rationale: "low-confidence default"
    };
  }
}
