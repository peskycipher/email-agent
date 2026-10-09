import type { ModelConfig } from "../../core/dto/ModelConfig.js";
import type { Taxonomy } from "../../core/dto/Taxonomy.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import type { ModelPort } from "../../core/ports/ModelPort.js";
import type { PromptParts } from "../../core/skill/prompt.js";
import { ModelAdapterError, resolveEnvApiKey } from "./modelAdapterFactory.js";

/** The threshold cutting per-label probabilities into the label set (decision 3). */
const DEFAULT_LABEL_THRESHOLD = 0.5;

/**
 * A `noul` question as the Jev API carries it (Story 6.3 decision 1): the label's
 * description is the yes-criterion. Kept structural so tests can stub `JevClient`
 * without importing `@typesafe-ai/sdk` (oxlint bans it under `tests/adapters/**`).
 */
export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions?: string | null;
  readonly criteria?: {
    readonly true?: string | null;
    readonly false?: string | null;
  } | null;
}

/** One `systemOne` request: one joined `state`, one question per taxonomy label. */
export interface JevSystemOneRequest {
  readonly state: string;
  readonly questions: Readonly<Record<string, JevNoulQuestion>>;
  readonly model?: string;
}

/**
 * One `systemOne` result. `answers` stays `unknown`-valued — the reply is untrusted
 * (Story 6.3's Always rule) and 6.2's `completeWithRetry` owns validation — so the
 * adapter reads `noul` defensively instead of trusting a typed shape.
 */
export interface JevSystemOneResult {
  readonly model: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly usage: Readonly<{ input_tokens: number; output_tokens: number }>;
}

/** The `TypeSafeClient` surface the adapter uses; built per call, never cached. */
export interface JevClient {
  systemOne(request: JevSystemOneRequest): Promise<JevSystemOneResult>;
}

/** Client-constructor options: the env-resolved key plus `extraParams` (baseURL, timeout, headers, retry). */
export interface JevClientOptions {
  apiKey: string;
  [extra: string]: unknown;
}

export interface JevAdapterDeps {
  log: LogPort;
  /** The per-call client seam (default: `TypeSafeClient`, wired by `modelAdapterFactory`). */
  createJevClient(options: JevClientOptions): JevClient;
}

/** A label's probability as read from one untrusted answer; `null` when absent or non-numeric. */
function readNoul(answer: unknown): number | null {
  if (typeof answer !== "object" || answer === null) return null;
  const noul = (answer as { noul?: unknown }).noul;
  return typeof noul === "number" ? noul : null;
}

/**
 * The Jev adapter: one `systemOne` request per call carrying the joined prompt as
 * `state` and one `noul` question per taxonomy label, with each label's description
 * as the yes-criterion. A label joins the returned set iff its probability is
 * `>= config.labelThreshold ?? 0.5` — an all-below-threshold reply resolves
 * `{ labels: [] }`, a valid empty set. The full probability distribution is logged
 * at debug per message so the threshold can be re-judged from spot-check evidence
 * (SM-C2); token usage is info-logged once per call. `temperature`/`maxTokens` are
 * not sent to Jev — the API rejects unknown request fields — and `extraParams`
 * route to the client constructor instead. Provider rejections propagate unwrapped
 * to the orchestrator (PRD FR-1); only the env fault gets a typed adapter code.
 */
export class JevAdapter implements ModelPort {
  constructor(private readonly deps: JevAdapterDeps) {}

  async complete(prompt: PromptParts, taxonomy: Taxonomy, config: ModelConfig): Promise<unknown> {
    // The call-time re-check (decision 5): an env that changed between construction
    // and call throws here, before any transport call — never a silent empty label set.
    const apiKey = resolveEnvApiKey(config);
    if (apiKey === undefined) {
      throw new ModelAdapterError(
        "MISSING_API_KEY",
        `environment variable "${config.apiKeyEnvVar}" is not set — set it before running`,
      );
    }

    // `extraParams` are client-constructor options (baseURL, timeout, headers, retry);
    // `apiKey` is set after the spread so the validated env channel always wins.
    const client = this.deps.createJevClient({
      ...config.extraParams,
      apiKey,
    });

    const questions: Record<string, JevNoulQuestion> = {};
    for (const label of taxonomy) {
      questions[label.name] = {
        type: "noul",
        instructions: `Does this email match the label "${label.name}"?`,
        criteria: { true: label.description },
      };
    }

    const result = await client.systemOne({
      state: `${prompt.system}\n\n${prompt.user}`,
      questions,
      model: config.model,
    });

    const threshold = config.labelThreshold ?? DEFAULT_LABEL_THRESHOLD;
    const labelProbs: Record<string, number | null> = {};
    const labels: string[] = [];
    for (const label of taxonomy) {
      const probability = readNoul(result.answers[label.name]);
      labelProbs[label.name] = probability;
      if (probability !== null && probability >= threshold) labels.push(label.name);
    }

    this.deps.log.debug("Jev returned per-label probabilities for the message.", { labelProbs });
    this.deps.log.info("Model call usage.", {
      provider: "jev",
      model: result.model,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    });

    return { labels };
  }
}