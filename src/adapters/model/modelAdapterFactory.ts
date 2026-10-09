import type { ModelConfig } from "../../core/dto/ModelConfig.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import type { ModelPort } from "../../core/ports/ModelPort.js";
import { OpenAI } from "openai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { TypeSafeClientConfig } from "@typesafe-ai/sdk";
import type { JevClient, JevClientOptions } from "./JevAdapter.js";
import { JevAdapter } from "./JevAdapter.js";
import type { OpenAIChatClient, OpenAIClientOptions } from "./OpenAIAdapter.js";
import { OpenAIAdapter } from "./OpenAIAdapter.js";

export type ModelAdapterErrorCode = "MISSING_API_KEY" | "UNSUPPORTED_PROVIDER";

/**
 * Typed at the adapter boundary (AD-4) so the CLI renders one actionable line:
 * `MISSING_API_KEY` names the env var to set; `UNSUPPORTED_PROVIDER` names the
 * `provider: "custom"` + `extraParams.baseURL` remedy. Provider rejections and
 * transport failures never use this class — they propagate unwrapped (PRD FR-1).
 */
export class ModelAdapterError extends Error {
  readonly code: ModelAdapterErrorCode;

  constructor(code: ModelAdapterErrorCode, message: string) {
    super(message);
    this.name = "ModelAdapterError";
    this.code = code;
  }
}

/** The ratified Story 6.3 defaults: `system1` is a model-class name (the live API 400s it), not a model id. */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "jev",
  model: "jev-latest",
  apiKeyEnvVar: "TYPESAFE_API_KEY",
  temperature: 0.1,
  maxTokens: 500,
};

/**
 * The seams the factory (and through it the adapters) run on: tests inject stub
 * clients and a recording log, so no suite ever imports `@typesafe-ai/sdk` or
 * `openai` (oxlint-enforced under `tests/adapters/**`).
 */
export interface ModelAdapterDeps {
  log: LogPort;
  /** Default: a per-call `TypeSafeClient` from `@typesafe-ai/sdk`. */
  createJevClient(options: JevClientOptions): JevClient;
  /** Default: a per-call `OpenAI` chat client (also used for `custom` providers). */
  createOpenAIClient(options: OpenAIClientOptions): OpenAIChatClient;
}

/**
 * Reads `config.apiKeyEnvVar` from the environment. `undefined` when the var is
 * unset or whitespace-only (the SDK ignores empties the same way); the value is
 * otherwise returned as-is, because the SDK applies its own trimming.
 */
export function resolveEnvApiKey(config: ModelConfig): string | undefined {
  const value = process.env[config.apiKeyEnvVar];
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

/**
 * The provider routing table (Story 6.3 decision 4) and wiring-time validation
 * (decision 5): `jev` builds the Jev adapter; `openai` and `custom` (custom
 * self-hosted providers universally speak the OpenAI protocol, with
 * `extraParams.baseURL` pointing at the compatible endpoint) build the OpenAI
 * adapter; `anthropic` throws a typed `UNSUPPORTED_PROVIDER` naming the remedy.
 * Construction fails before the run starts when the config's provider is not
 * routable or `config.apiKeyEnvVar` names an unset env var — the call-time re-check
 * inside each adapter survives so an env that changes between construction and
 * call still errors per call, never a silent empty label set.
 */
export function createModelAdapter(config: ModelConfig, deps: ModelAdapterDeps): ModelPort {
  // Provider routing is validated at wiring time (decision 5); the runtime `default`
  // arm keeps an unvalidated (e.g. YAML-parsed) value loud instead of mis-routing it.
  switch (config.provider) {
    case "jev":
    case "openai":
    case "custom":
      break;
    case "anthropic":
      throw new ModelAdapterError(
        "UNSUPPORTED_PROVIDER",
        'provider "anthropic" has no adapter — set provider: "custom" with extraParams.baseURL for OpenAI-compatible providers',
      );
    default:
      throw new ModelAdapterError(
        "UNSUPPORTED_PROVIDER",
        `provider ${JSON.stringify(String(config.provider))} is not one of "jev" | "openai" | "anthropic" | "custom" — fix the config's provider field`,
      );
  }
  if (resolveEnvApiKey(config) === undefined) {
    throw new ModelAdapterError(
      "MISSING_API_KEY",
      `environment variable "${config.apiKeyEnvVar}" is not set — set it before running`,
    );
  }
  if (config.provider === "jev") {
    return new JevAdapter({ log: deps.log, createJevClient: deps.createJevClient });
  }
  return new OpenAIAdapter({ log: deps.log, createOpenAIClient: deps.createOpenAIClient });
}

/** The default client factories; only the factory imports the SDKs. The SDKs' typed
 * surfaces are narrowed to the adapters' structural client seams with casts — the
 * replies stay untrusted either way, and 6.2's `completeWithRetry` owns validation. */
export const defaultModelClientFactories = {
  createJevClient(options: JevClientOptions): JevClient {
    return new TypeSafeClient(
      options as unknown as TypeSafeClientConfig,
    ) as unknown as JevClient;
  },
  createOpenAIClient(options: OpenAIClientOptions): OpenAIChatClient {
    return new OpenAI(
      options as unknown as ConstructorParameters<typeof OpenAI>[0],
    ) as unknown as OpenAIChatClient;
  },
};