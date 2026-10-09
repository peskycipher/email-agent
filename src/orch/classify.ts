import { completeWithRetry } from "../adapters/model/labelSetValidation.js";
import type { LabelSet } from "../core/dto/LabelSet.js";
import type { MessageDTO } from "../core/dto/MessageDTO.js";
import type { ModelConfig } from "../core/dto/ModelConfig.js";
import type { Taxonomy } from "../core/dto/Taxonomy.js";
import type { LogContext, LogPort } from "../core/ports/LogPort.js";
import type { ModelPort } from "../core/ports/ModelPort.js";
import { buildPrompt } from "../core/skill/prompt.js";

/**
 * The composed classification unit (Story 6.4, decision 7): the repo's seams-object
 * idiom (6.2's `CompleteWithRetryOptions`, 4.4's `SyncCategoriesOptions`), with AD-1's
 * trio (message, taxonomy, modelConfig) carrying the story and the port/logger plumbing
 * alongside. The caller owns the adapter and the logger — nothing here imports an SDK.
 */
export interface ClassifyOptions {
  /** The one canonical message (Epic 5's fetch output); never mutated. */
  message: MessageDTO;
  /** The active (merged, frozen) taxonomy; never mutated. */
  taxonomy: Taxonomy;
  /** The configured model adapter; exactly one `complete` call per attempt. */
  model: ModelPort;
  /** The run's model config, carried unchanged into `completeWithRetry`. */
  config: ModelConfig;
  /** The injected logger; only 6.2's exhaustion path writes, through it. */
  log: LogPort;
  /** Per-message log fields (`accountId`, message id) the caller owns. */
  context?: LogContext;
}

/**
 * Classifies one message against the active taxonomy: builds the prompt (Story 6.1's
 * `buildPrompt`) and drives the model through 6.2's bounded conversation
 * (`completeWithRetry`), which validates the reply and retries within the frozen ≤3
 * budget. A valid reply — including the model's own `{ labels: [] }` — resolves as the
 * validated `LabelSet`; validation exhaustion resolves to an empty set after one
 * structured error through the injected `log`. A transport rejection re-throws
 * unwrapped (PRD FR-1): the orchestrator re-queues, and an outage never reads as a
 * valid empty classification. No other decisions live here — the prompt rules are 6.1's,
 * the conversation semantics 6.2's, the wire formats 6.3's (Story 6.4 decision 6/7).
 */
export async function classify(options: ClassifyOptions): Promise<LabelSet> {
  const { message, taxonomy, model, config, log, context } = options;
  const prompt = buildPrompt(message, taxonomy);
  return completeWithRetry({ model, prompt, config, taxonomy, log, context });
}