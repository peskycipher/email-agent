import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { z } from "zod";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "email-classify");

/** User-facing path used in errors; Epic 11 replaces this reader with `ConfigLoader`. */
export const CONFIG_FILE_DISPLAY_PATH = "~/.config/email-classify/config.yaml";

export interface ConfigFileOptions {
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
}

export type ConfigFileErrorCode = "CONFIG_UNREADABLE" | "CONFIG_INVALID";

/** Typed at this temporary reader's boundary; `loadTaxonomy` re-types it as a `TaxonomyError`. */
export class ConfigFileError extends Error {
  readonly code: ConfigFileErrorCode;

  constructor(code: ConfigFileErrorCode, message: string) {
    super(message);
    this.name = "ConfigFileError";
    this.code = code;
  }
}

/** Only the `taxonomyOverrides` key is modelled; every other config key is Epic 11's. */
const configFileSchema = z.object({
  taxonomyOverrides: z.array(z.unknown()).optional(),
});

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Temporary `config.yaml` reader (Story 4.1 decision 2): exposes only the raw
 * `taxonomyOverrides[]` list. A missing file or absent key means "no overrides";
 * an unreadable file, unparseable YAML, or a non-list value is a typed error.
 * `loadTaxonomy` validates the list's entries, so they stay `unknown` here.
 */
export async function readTaxonomyOverrides(options: ConfigFileOptions = {}): Promise<unknown[] | undefined> {
  const path = join(options.configDir ?? DEFAULT_CONFIG_DIR, "config.yaml");
  // An injected `configDir` (tests, a future XDG override) must be named correctly in errors.
  const displayPath = options.configDir === undefined ? CONFIG_FILE_DISPLAY_PATH : path;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw new ConfigFileError("CONFIG_UNREADABLE", `Configuration at ${displayPath} could not be read.`);
  }
  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch {
    throw new ConfigFileError("CONFIG_INVALID", `Configuration at ${displayPath} is not valid YAML.`);
  }
  const result = configFileSchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new ConfigFileError(
      "CONFIG_INVALID",
      `Configuration at ${displayPath} is invalid — "taxonomyOverrides" must be a list.`,
    );
  }
  return result.data.taxonomyOverrides;
}
