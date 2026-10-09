import type { ModelConfig } from "../../core/dto/ModelConfig.js";
import type { Taxonomy } from "../../core/dto/Taxonomy.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import type { ModelPort } from "../../core/ports/ModelPort.js";
import type { PromptParts } from "../../core/skill/prompt.js";
import { ModelAdapterError, resolveEnvApiKey } from "./modelAdapterFactory.js";

/**
 * A chat-completion request as the adapter builds it. `schema` values are plain
 * JSON (the schema is built from the taxonomy below), so they stay `unknown` here —
 * the OpenAI wire format never leaks into the seam type.
 */
export interface OpenAIChatParams {
  model: string;
  messages: ReadonlyArray<{ role: "system" | "user"; content: string }>;
  temperature?: number;
  max_tokens?: number;
  response_format: {
    type: "json_schema";
    json_schema: { name: string; strict: true; schema: Record<string, unknown> };
  };
}

/**
 * A chat-completion result. Only `content` and usage figures are read — the parsed
 * body stays untrusted and 6.2's `completeWithRetry` owns validation. Kept
 * structural so tests stub the client without importing `openai` (oxlint bans it
 * under `tests/adapters/**`).
 */
export interface OpenAIChatCompletion {
  choices: ReadonlyArray<{ readonly message?: { readonly content?: string | null } }>;
  usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

/** The `OpenAI` SDK surface the adapter uses; built per call, never cached. */
export interface OpenAIChatClient {
  chat: { completions: { create(params: OpenAIChatParams): Promise<OpenAIChatCompletion> } };
}

/** Client-constructor options: the env-resolved key plus `extraParams` (baseURL, timeout, headers). */
export interface OpenAIClientOptions {
  apiKey: string;
  [extra: string]: unknown;
}

export interface OpenAIAdapterDeps {
  log: LogPort;
  /** The per-call client seam (default: the `openai` SDK, wired by `modelAdapterFactory`). */
  createOpenAIClient(options: OpenAIClientOptions): OpenAIChatClient;
}

/**
 * The strict JSON schema for `{ labels: [...] }` sent with the request: every string
 * must be one of the taxonomy names (an empty array stays valid, which strict mode
 * preserves — no minimum). Built inside the adapter because OpenAI is the only
 * consumer of a schema: core's `JsonSchema` was deleted in Story 6.3 (decision 1).
 */
export function buildLabelSetResponseSchema(taxonomy: Taxonomy): Record<string, unknown> {
  const names = [...new Set(taxonomy.map((label) => label.name))];
  return {
    type: "object",
    properties: {
      labels: { type: "array", items: { type: "string", enum: names } },
    },
    required: ["labels"],
    additionalProperties: false,
  };
}

/**
 * The OpenAI adapter (also serves `provider: "custom"` via `extraParams.baseURL`):
 * `PromptParts` map to a system/user `messages` pair, the taxonomy becomes an
 * internally built strict `response_format` schema, and `temperature`/`max_tokens`
 * from the config are honored. The reply's `content` is JSON-parsed and passed
 * through unparsed-any-further — 6.2 validates it. Token usage is info-logged once
 * per call. Provider rejections and undecodable content propagate unwrapped to the
 * orchestrator (PRD FR-1); only the env fault gets a typed adapter code.
 */
export class OpenAIAdapter implements ModelPort {
  constructor(private readonly deps: OpenAIAdapterDeps) {}

  async complete(prompt: PromptParts, taxonomy: Taxonomy, config: ModelConfig): Promise<unknown> {
    // The call-time re-check (decision 5): an env that changed between construction
    // and call throws here, before any transport call.
    const apiKey = resolveEnvApiKey(config);
    if (apiKey === undefined) {
      throw new ModelAdapterError(
        "MISSING_API_KEY",
        `environment variable "${config.apiKeyEnvVar}" is not set — set it before running`,
      );
    }

    // `extraParams` are client-constructor options (baseURL, timeout, headers);
    // `apiKey` is set after the spread so the validated env channel always wins.
    const client = this.deps.createOpenAIClient({
      ...config.extraParams,
      apiKey,
    });

    const completion = await client.chat.completions.create({
      model: config.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "label_set",
          strict: true,
          schema: buildLabelSetResponseSchema(taxonomy),
        },
      },
    });

    const content = completion.choices[0]?.message?.content ?? null;
    const parsed = content === null ? null : JSON.parse(content);

    this.deps.log.info("Model call usage.", {
      provider: "openai",
      model: config.model,
      inputTokens: completion.usage?.prompt_tokens,
      outputTokens: completion.usage?.completion_tokens,
    });

    return parsed;
  }
}