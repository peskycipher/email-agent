import type { MailboxMessage } from "../adapter.ts";
import { defaultFetch, parseJsonBody, type FetchFn } from "../http.ts";
import { EMAIL_CATEGORIES, isEmailCategory, type EmailCategory } from "./categories.ts";

export type SecondPassClassification = {
  category: EmailCategory;
  rationale: string;
  model: string;
};

export type SecondPassClassifier = {
  classify(message: MailboxMessage): Promise<SecondPassClassification>;
};

export type OllamaCloudClassifierOptions = {
  baseUrl?: string;
  apiKey?: string;
  primaryModel?: string;
  backupModel?: string;
  fetchFn?: FetchFn;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

function parseCategory(content: string): { category: EmailCategory; rationale: string } {
  const trimmed = content.trim();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { category?: unknown; rationale?: unknown };
      if (typeof parsed.category === "string" && isEmailCategory(parsed.category)) {
        return {
          category: parsed.category,
          rationale: typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0 ? parsed.rationale : trimmed
        };
      }
    } catch {
      // fall through to plain-text parsing
    }
  }

  for (const category of EMAIL_CATEGORIES) {
    if (trimmed.toLowerCase().includes(category.toLowerCase())) {
      return {
        category,
        rationale: trimmed
      };
    }
  }

  throw new Error("Ollama response did not include a valid category");
}

function toPrompt(message: MailboxMessage): string {
  return [
    "Classify this email into exactly one category:",
    `${EMAIL_CATEGORIES.join(", ")}.`,
    "Respond as compact JSON with keys category and rationale.",
    `From: ${message.from}`,
    `Subject: ${message.subject}`,
    `Date: ${message.date}`,
    `Unread: ${message.unread}`,
    `Flagged: ${message.flagged}`
  ].join("\n");
}

export class OllamaCloudClassifier implements SecondPassClassifier {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly primaryModel: string;
  private readonly backupModel: string;
  private readonly fetchFn: FetchFn;

  constructor(options: OllamaCloudClassifierOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://ollama.com/v1";
    this.apiKey = options.apiKey ?? process.env.OLLAMA_API_KEY;
    this.primaryModel = options.primaryModel ?? "deepseek-4.1-flash";
    this.backupModel = options.backupModel ?? "glm-5.3-flash";
    this.fetchFn = options.fetchFn ?? defaultFetch;
  }

  async classify(message: MailboxMessage): Promise<SecondPassClassification> {
    const errors: string[] = [];

    for (const model of [this.primaryModel, this.backupModel]) {
      try {
        const result = await this.callModel(model, message);
        return {
          ...result,
          model
        };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        errors.push(`${model}: ${text}`);
      }
    }

    throw new Error(`ollama-second-pass-failed (${errors.join("; ")})`);
  }

  private async callModel(model: string, message: MailboxMessage): Promise<Omit<SecondPassClassification, "model">> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error("missing OLLAMA_API_KEY");
    }

    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "user",
            content: toPrompt(message)
          }
        ]
      })
    });

    const payload = (await parseJsonBody(response, "Ollama response")) as ChatCompletionResponse & { error?: unknown };
    if (!response.ok) {
      const error = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(error);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("empty completion content");
    }

    return parseCategory(content);
  }
}
