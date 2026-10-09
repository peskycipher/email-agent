import type { LabelDef } from "../dto/LabelDef.js";
import type { MessageDTO } from "../dto/MessageDTO.js";
import type { Taxonomy } from "../dto/Taxonomy.js";

/**
 * The two halves of the model request (Story 6.1). They stay separate because the
 * system side carries the taxonomy and the output contract while the user side
 * carries the message; how a caller joins them into `ModelPort.complete`'s single
 * `prompt` string is Story 6.3/6.4's decision, so this builder must not flatten them.
 */
export interface PromptParts {
  system: string;
  user: string;
}

/** `bodyPreview` enters the user prompt truncated to this many characters (FR-12). */
const BODY_PREVIEW_LIMIT = 2000;

/** At most this many few-shot examples; fewer when the taxonomy is smaller. */
const MAX_FEW_SHOT_EXAMPLES = 5;

/** The exact JSON shape the model must return. */
const OUTPUT_SHAPE = '{"labels":["<label>"]}';

/** Stated explicitly so the model may answer with no labels instead of inventing one. */
const EMPTY_ANSWER = '{"labels":[]}';

/**
 * A one-line synthetic email built from a single label's name and description,
 * paired with the answer that names it. Few-shot examples are synthesised from the
 * passed taxonomy (human decision, 2026-10-09) so a user who drops or renames a
 * label can never be taught, by the prompt's own examples, to emit a removed label.
 */
function renderFewShot(label: LabelDef, index: number): string {
  return [
    `Example ${index + 1}:`,
    `Subject: ${label.name}`,
    `Body: ${label.description}`,
    `Answer: ${JSON.stringify({ labels: [label.name] })}`,
  ].join("\n");
}

function buildSystem(taxonomy: Taxonomy): string {
  const labelList = taxonomy
    .map((label) => `- ${label.name}: ${label.description}`)
    .join("\n");
  const examples = taxonomy
    .slice(0, MAX_FEW_SHOT_EXAMPLES)
    .map(renderFewShot)
    .join("\n\n");

  return [
    "You classify an email against a fixed label taxonomy. Assign zero or more labels from the taxonomy to the email.",
    "",
    "Return only valid JSON, with no prose and no code fences, in exactly this shape:",
    OUTPUT_SHAPE,
    "",
    `Every label you return must come from the taxonomy. An empty array is valid: when no label fits, return ${EMPTY_ANSWER}.`,
    "Precision beats recall — one correct label is better than three wrong ones.",
    "",
    "Taxonomy:",
    labelList,
    "",
    "Examples:",
    examples,
  ].join("\n");
}

function buildUser(message: MessageDTO): string {
  const existing =
    message.existingLabels.length > 0 ? message.existingLabels.join(", ") : "none";

  return [
    `Subject: ${message.subject}`,
    `From: ${message.senderName} <${message.senderEmail}>`,
    `Received: ${message.receivedDateTime}`,
    `Existing labels: ${existing}`,
    "",
    "Body:",
    message.bodyPreview.slice(0, BODY_PREVIEW_LIMIT),
  ].join("\n");
}

/**
 * Renders the system and user prompt halves for one message against the merged,
 * frozen taxonomy. Pure: no I/O, no clock, no randomness, and neither argument is
 * mutated, so repeated calls yield identical text.
 */
export function buildPrompt(message: MessageDTO, taxonomy: Taxonomy): PromptParts {
  // Truncating `bodyPreview` is the builder's job — no adapter truncates it today.
  return { system: buildSystem(taxonomy), user: buildUser(message) };
}
