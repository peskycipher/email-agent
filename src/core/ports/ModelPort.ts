import type { ModelConfig } from "../dto/ModelConfig.js";
import type { Taxonomy } from "../dto/Taxonomy.js";
import type { PromptParts } from "../skill/prompt.js";

/**
 * The classification seam (Story 6.3 decision 1, "Option C"): it is not a generic
 * completion seam. Adapters shape `PromptParts` + `Taxonomy` into their provider's
 * wire format — Jev joins the prompt into one `state` with one `noul` question per
 * taxonomy label; OpenAI maps the halves to chat `messages` and builds its own
 * strict JSON schema from the taxonomy. The reply is untrusted — 6.2's
 * `completeWithRetry` owns validation — so the return stays `unknown`, and token
 * usage is logged once per call inside the adapter through the injected `LogPort`.
 */
export interface ModelPort {
  complete(prompt: PromptParts, taxonomy: Taxonomy, config: ModelConfig): Promise<unknown>;
}
