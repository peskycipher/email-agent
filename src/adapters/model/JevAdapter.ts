import type { ModelConfig } from "../../core/dto/ModelConfig.js";
import type { Taxonomy } from "../../core/dto/Taxonomy.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import type { ModelPort } from "../../core/ports/ModelPort.js";
import type { PromptParts } from "../../core/skill/prompt.js";
import { requireEnvApiKey } from "./modelAdapterFactory.js";

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

/** Defensive object check for untrusted reply members (Story 6.3's Always rule). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
 * route to the client constructor instead. The whole reply is untrusted: a missing
 * or non-object `answers`/`usage` degrades (nulls in `labelProbs`, 0 usage) instead
 * of throwing. Provider rejections propagate unwrapped
 * to the orchestrator (PRD FR-1); only the env fault gets a typed adapter code.
 */
export class JevAdapter implements ModelPort {
  constructor(private readonly deps: JevAdapterDeps) {}

  async complete(prompt: PromptParts, taxonomy: Taxonomy, config: ModelConfig): Promise<unknown> {
    // The call-time re-check (decision 5): an env that changed between construction
    // and call throws here, before any transport call — never a silent empty label set.
    const apiKey = requireEnvApiKey(config);

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

    // A non-finite threshold (e.g. NaN from a bad config parse) would make every
    // `>=` comparison false — a silent all-empty set — so it falls back to 0.5.
    const configured = config.labelThreshold;
    const threshold =
      typeof configured === "number" && Number.isFinite(configured)
        ? configured
        : DEFAULT_LABEL_THRESHOLD;
    const answers = isRecord(result.answers) ? result.answers : {};
    const labelProbs: Record<string, number | null> = {};
    const labels: string[] = [];
    for (const label of taxonomy) {
      const probability = readNoul(answers[label.name]);
      labelProbs[label.name] = probability;
      if (probability !== null && probability >= threshold) labels.push(label.name);
    }

    this.deps.log.debug("Jev returned per-label probabilities for the message.", { labelProbs });
    // Missing/non-numeric usage fields log 0 — never a TypeError on the untrusted reply.
    const usage: Readonly<Record<string, unknown>> = isRecord(result.usage) ? result.usage : {};
    this.deps.log.info("Model call usage.", {
      provider: "jev",
      model: result.model,
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    });

    return { labels };
  }
}
