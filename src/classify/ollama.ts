import type { MailboxMessage } from "../adapter.ts";
import { defaultFetch, parseJsonBody, type FetchFn } from "../http.ts";
import { MODEL_INFERABLE_LABELS, isEmailLabel, type EmailLabel } from "./labels.ts";

export type SecondPassClassification = {
  labels: EmailLabel[];
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

function parseLabels(content: string): { labels: EmailLabel[]; rationale: string } {
  const trimmed = content.trim();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { labels?: unknown; rationale?: unknown };
      if (Array.isArray(parsed.labels)) {
        const labels = parsed.labels.filter((value): value is EmailLabel => typeof value === "string" && isEmailLabel(value));
        if (labels.length > 0 || parsed.labels.length === 0) {
          return {
            labels,
            rationale: typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0 ? parsed.rationale : trimmed
          };
        }
      }
    } catch {
      // fall through to plain-text parsing
    }
  }

  const matched = MODEL_INFERABLE_LABELS.filter((label) => trimmed.toLowerCase().includes(label.toLowerCase()));
  if (matched.length > 0) {
    return { labels: matched, rationale: trimmed };
  }

  throw new Error("Ollama response did not include any valid labels");
}

function toPrompt(message: MailboxMessage): string {
  return [
    "Attach every applicable label to this email. An email can have zero, one, or many labels.",
    `Valid labels: ${MODEL_INFERABLE_LABELS.join(", ")}.`,
    "Respond as compact JSON with keys labels (array of strings) and rationale.",
    `From: ${message.from}`,
    `Subject: ${message.subject}`,
    ...(message.body ? [`Body: ${message.body}`] : []),
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

    return parseLabels(content);
  }
}
