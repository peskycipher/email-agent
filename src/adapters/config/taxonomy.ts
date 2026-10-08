import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { z } from "zod";
import { LABEL_NAME_PATTERN } from "../../core/dto/LabelDef.js";
import type { LabelDef } from "../../core/dto/LabelDef.js";
import type { Taxonomy } from "../../core/dto/Taxonomy.js";
import { ConfigFileError, readTaxonomyOverrides } from "./configFile.js";

/** M365 accepts only these named presets; anything else is rejected by the API. */
const M365_COLOR_PATTERN = /^preset(?:[0-9]|1[0-9]|2[0-4])$/;
/** Gmail accepts only 6-digit hex colors. */
const GMAIL_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const MIN_LABELS = 1;
const MAX_LABELS = 50;

/** The shipped taxonomy, reached from both `src/adapters/config/` and `dist/adapters/config/`. */
const DEFAULT_TAXONOMY_URL = new URL("../../../taxonomy.yaml", import.meta.url);

export interface LoadTaxonomyOptions {
  /** Taxonomy file path or URL; defaults to the shipped repo-root `taxonomy.yaml`. Inject in tests. */
  taxonomyPath?: string | URL;
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
}

export type TaxonomyErrorCode =
  | "SOURCE_UNREADABLE"
  | "SOURCE_INVALID"
  | "CONFIG_INVALID"
  | "OVERRIDE_MALFORMED"
  | "OVERRIDE_INCOMPLETE"
  | "INVALID_LABEL_NAME"
  | "INVALID_LABEL_FIELD"
  | "INVALID_LABEL_COLOR"
  | "DUPLICATE_LABEL_NAME"
  | "LABEL_COUNT_OUT_OF_BOUNDS";

/** Typed at the loader boundary; the CLI turns it into one actionable line (AD-4). */
export class TaxonomyError extends Error {
  readonly code: TaxonomyErrorCode;

  constructor(code: TaxonomyErrorCode, message: string) {
    super(message);
    this.name = "TaxonomyError";
    this.code = code;
  }
}

/**
 * One `taxonomyOverrides[]` entry: `name` keys the merge, the other three are the
 * fields it may patch. Mirrors `Config.taxonomyOverrides` (Story 11.1).
 */
const overrideSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    m365Color: z.string().optional(),
    gmailColor: z.string().optional(),
  })
  // Strict on purpose: a mistyped field would otherwise be stripped into a name-only
  // entry, which the merge reads as "drop that default" — a silent, data-affecting typo.
  .strict();

type TaxonomyOverride = z.infer<typeof overrideSchema>;

const labelSchema = z.object({
  name: z.string().regex(LABEL_NAME_PATTERN),
  description: z.string(),
  m365Color: z.string().regex(M365_COLOR_PATTERN),
  gmailColor: z.string().regex(GMAIL_COLOR_PATTERN),
});

/**
 * Loads the shipped `taxonomy.yaml`, applies `config.yaml`'s `taxonomyOverrides`
 * (patch / add / drop keyed by `name`), validates the 1–50 labels and freezes the
 * result. Side-effect-free: no network, keychain or mailbox I/O, and nothing is
 * ever deleted from a mailbox (a dropped default is simply absent from the merge).
 */
export async function loadTaxonomy(options: LoadTaxonomyOptions = {}): Promise<Taxonomy> {
  const defaults = await readDefaultLabels(options.taxonomyPath ?? DEFAULT_TAXONOMY_URL);
  const overrides = await readOverrides(options.configDir);
  const labels = mergeLabels(defaults, overrides);
  validateLabels(labels);
  for (const label of labels) Object.freeze(label);
  Object.freeze(labels);
  return labels;
}

function sourceDisplayPath(path: string | URL): string {
  // `fileURLToPath` decodes percent-escapes; `URL.pathname` would render `my labels` as `my%20labels`.
  return typeof path === "string" ? path : fileURLToPath(path);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

async function readDefaultLabels(path: string | URL): Promise<LabelDef[]> {
  const displayPath = sourceDisplayPath(path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      throw new TaxonomyError(
        "SOURCE_UNREADABLE",
        `No taxonomy file at ${displayPath} — the repo must ship taxonomy.yaml.`,
      );
    }
    throw new TaxonomyError("SOURCE_UNREADABLE", `The taxonomy file at ${displayPath} could not be read.`);
  }
  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch {
    throw new TaxonomyError("SOURCE_INVALID", `The taxonomy file at ${displayPath} is not valid YAML.`);
  }
  if (!Array.isArray(parsed)) {
    throw new TaxonomyError("SOURCE_INVALID", `The taxonomy file at ${displayPath} must be a list of labels.`);
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TaxonomyError(
        "SOURCE_INVALID",
        `taxonomy.yaml label ${index + 1} must be a mapping with name, description, m365Color and gmailColor.`,
      );
    }
    if (typeof (entry as { name?: unknown }).name !== "string") {
      throw new TaxonomyError("SOURCE_INVALID", `taxonomy.yaml label ${index + 1} is missing "name".`);
    }
    return entry as LabelDef;
  });
}

async function readOverrides(configDir: string | undefined): Promise<unknown[]> {
  try {
    return (await readTaxonomyOverrides(configDir === undefined ? {} : { configDir })) ?? [];
  } catch (error) {
    if (error instanceof ConfigFileError) {
      throw new TaxonomyError("CONFIG_INVALID", error.message);
    }
    throw error;
  }
}

function mergeLabels(defaults: LabelDef[], rawOverrides: unknown[]): LabelDef[] {
  const labels = defaults.map((label) => ({ ...label }));
  const defaultIndexByName = new Map(defaults.map((label, index) => [label.name, index]));
  const dropped = new Set<string>();
  const added: LabelDef[] = [];

  rawOverrides.forEach((raw, overrideIndex) => {
    const override = readOverride(raw, overrideIndex);
    const defaultIndex = defaultIndexByName.get(override.name);
    if (defaultIndex === undefined) {
      added.push(readAddedLabel(override, overrideIndex));
      return;
    }
    const patched = applyPatch(labels[defaultIndex], override);
    if (patched === undefined) {
      dropped.add(override.name);
      // Forgetting the name here would let a later same-name entry resolve back to the dropped
      // default and then be filtered out silently; dropping it from the map makes a later
      // entry an add instead, which must supply all three fields or fail loudly.
      defaultIndexByName.delete(override.name);
    } else {
      labels[defaultIndex] = patched;
    }
  });

  return [...labels.filter((label) => !dropped.has(label.name)), ...added];
}

function readOverride(raw: unknown, index: number): TaxonomyOverride {
  const result = overrideSchema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  if (issue !== undefined && "keys" in issue) {
    const keys = (issue as { keys: string[] }).keys;
    throw new TaxonomyError(
      "OVERRIDE_MALFORMED",
      `taxonomyOverrides[${index}] is malformed — unknown field "${keys.join('", "')}" (expected name, description, m365Color, gmailColor).`,
    );
  }
  const field = issue?.path.join(".") ?? "";
  const detail = field === "" ? 'expected a mapping with a "name"' : `field "${field}" is invalid`;
  throw new TaxonomyError("OVERRIDE_MALFORMED", `taxonomyOverrides[${index}] is malformed — ${detail}.`);
}

/** A matched entry with no other field drops the default (returns `undefined`). */
function applyPatch(label: LabelDef, override: TaxonomyOverride): LabelDef | undefined {
  const { description, m365Color, gmailColor } = override;
  if (description === undefined && m365Color === undefined && gmailColor === undefined) {
    return undefined;
  }
  return {
    name: label.name,
    description: description ?? label.description,
    m365Color: m365Color ?? label.m365Color,
    gmailColor: gmailColor ?? label.gmailColor,
  };
}

/** An unmatched name is a new label and must carry all three remaining fields. */
function readAddedLabel(override: TaxonomyOverride, index: number): LabelDef {
  const { name, description, m365Color, gmailColor } = override;
  if (description === undefined || m365Color === undefined || gmailColor === undefined) {
    const missing = description === undefined ? "description" : m365Color === undefined ? "m365Color" : "gmailColor";
    throw new TaxonomyError(
      "OVERRIDE_INCOMPLETE",
      `taxonomyOverrides[${index}] adds "${name}" but is missing "${missing}" — a new label needs description, m365Color and gmailColor.`,
    );
  }
  return { name, description, m365Color, gmailColor };
}

function validateLabels(labels: LabelDef[]): void {
  if (labels.length < MIN_LABELS) {
    throw new TaxonomyError(
      "LABEL_COUNT_OUT_OF_BOUNDS",
      `The merged taxonomy has ${labels.length} labels — it must hold at least ${MIN_LABELS}.`,
    );
  }
  if (labels.length > MAX_LABELS) {
    throw new TaxonomyError(
      "LABEL_COUNT_OUT_OF_BOUNDS",
      `The merged taxonomy has ${labels.length} labels — it must hold at most ${MAX_LABELS}.`,
    );
  }
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label.name)) {
      throw new TaxonomyError(
        "DUPLICATE_LABEL_NAME",
        `The merged taxonomy has two labels named "${label.name}" — label names must be unique.`,
      );
    }
    seen.add(label.name);
    validateLabel(label);
  }
}

function validateLabel(label: LabelDef): void {
  const result = labelSchema.safeParse(label);
  if (result.success) return;
  const field = result.error.issues[0]?.path.join(".") ?? "";
  if (field === "name") {
    throw new TaxonomyError(
      "INVALID_LABEL_NAME",
      `Label "${label.name}" has an invalid name — it must match ${LABEL_NAME_PATTERN.source}.`,
    );
  }
  if (field === "m365Color") {
    throw new TaxonomyError(
      "INVALID_LABEL_COLOR",
      `Label "${label.name}" has an invalid m365Color "${label.m365Color}" — expected preset0–preset24.`,
    );
  }
  if (field === "gmailColor") {
    throw new TaxonomyError(
      "INVALID_LABEL_COLOR",
      `Label "${label.name}" has an invalid gmailColor "${label.gmailColor}" — expected a #RRGGBB hex color.`,
    );
  }
  throw new TaxonomyError("INVALID_LABEL_FIELD", `Label "${label.name}" has an invalid "${field}".`);
}
