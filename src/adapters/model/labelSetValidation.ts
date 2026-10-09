import { z } from "zod";
import type { LabelSet } from "../../core/dto/LabelSet.js";
import type { ModelConfig } from "../../core/dto/ModelConfig.js";
import type { Taxonomy } from "../../core/dto/Taxonomy.js";
import type { LogContext, LogPort } from "../../core/ports/LogPort.js";
import type { PromptParts } from "../../core/skill/prompt.js";
import type { ModelPort } from "../../core/ports/ModelPort.js";

/**
 * The initial call plus at most two retries — the retry budget fixed by the Story 6.2
 * human decision (2026-10-09): an invalid reply is re-issued twice, then the unit gives up.
 */
const MAX_ATTEMPTS = 3;

/**
 * The verdict of validating one raw model reply. `labels` is the accepted set on success
 * and empty on rejection; `reason` names the rejection cause and is present only when
 * `ok` is false.
 */
export interface LabelSetValidation {
  ok: boolean;
  labels: string[];
  reason?: string;
}

/**
 * The strict output schema for `{ labels: [...] }`, parameterised by the active taxonomy:
 * every entry must be a string naming a label in `taxonomy`, an empty array is valid,
 * duplicate names are rejected (a label set has no repeats), and an unexpected top-level
 * key is rejected rather than stripped (mirrors `adapters/config/taxonomy.ts`'s `.strict()`
 * precedent — a stray field is a malformed reply, not something to drop).
 */
export function labelSetSchema(taxonomy: Taxonomy) {
  const names = new Set(taxonomy.map((label) => label.name));
  return z
    .object({
      labels: z
        .array(
          z.string().refine((name) => names.has(name), "label is not in the active taxonomy"),
        )
        .refine((labels) => new Set(labels).size === labels.length, {
          message: "labels must not contain duplicates",
        }),
    })
    .strict();
}

/** One line per Zod issue, e.g. `labels.0: label is not in the active taxonomy`. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Pure verdict for one raw model reply. `raw` is untrusted: it may be any value the
 * adapter resolved with (a string, `null`, a wrongly-shaped object, a label name outside
 * the active taxonomy), and it is never mutated. Membership is checked against the
 * *active* taxonomy, so a label the user dropped can never be re-emitted.
 */
export function validateLabelSet(raw: unknown, taxonomy: Taxonomy): LabelSetValidation {
  const result = labelSetSchema(taxonomy).safeParse(raw);
  if (result.success) {
    return { ok: true, labels: result.data.labels };
  }
  return { ok: false, labels: [], reason: describeIssues(result.error) };
}

export interface CompleteWithRetryOptions {
  /** The configured model adapter. Re-issued unchanged on every retry. */
  model: ModelPort;
  /** The rendered request — Story 6.1's `buildPrompt` halves — passed through unchanged. */
  prompt: PromptParts;
  /** The run's model config; `temperature` is passed through unchanged on every attempt. */
  config: ModelConfig;
  /** The active (merged, frozen) taxonomy that defines the label universe. */
  taxonomy: Taxonomy;
  /** Where the exhausted path logs its one structured error. */
  log: LogPort;
  /** Per-message log fields (`accountId`, message id) merged into that error's context. */
  context?: LogContext;
}

/**
 * Calls `model.complete` and validates the reply against the active taxonomy, retrying an
 * invalid reply against the same configured model at most twice (three attempts total).
 * The `ModelConfig` is carried unchanged, so every attempt uses the same model and the
 * configured temperature. When the attempts are exhausted the last reply is logged once
 * through `LogPort.error` — with the raw response and the rejection reason — and an empty,
 * valid label set is returned, so an unclassifiable message degrades to no labels instead
 * of aborting the batch. A rejecting `model.complete` (transport error) is *not* absorbed:
 * it re-throws to the orchestrator, which owns retry-with-backoff and re-queues the message
 * for the next cycle (PRD FR-1) — an outage must not read as a valid empty classification.
 */
export async function completeWithRetry(options: CompleteWithRetryOptions): Promise<LabelSet> {
  const { model, prompt, config, taxonomy, log, context } = options;
  let raw: unknown;
  let reason = "the model returned no response";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    raw = await model.complete(prompt, taxonomy, config);
    const verdict = validateLabelSet(raw, taxonomy);
    if (verdict.ok) {
      return { labels: verdict.labels };
    }
    reason = verdict.reason ?? reason;
  }

  log.error("Model output failed label-set validation after the retry budget — returning an empty label set.", {
    ...context,
    raw,
    reason,
  });
  return { labels: [] };
}
