import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { z } from "zod";
import { ACCOUNT_NAME_PATTERN } from "../../core/dto/accountName.js";

/**
 * Temporary per-account reader (Story 2.1 decision 1): Epic 11 replaces it with
 * `ConfigLoader`/DI over `Config.m365.accounts[]`. Kept to one file so deleting
 * it is a single import change.
 */
const PROVIDER = "m365";
const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "email-classify");

const accountSettingsSchema = z.object({
  name: z.string().regex(ACCOUNT_NAME_PATTERN),
  enabled: z.boolean(),
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
});

export type M365AccountSettings = z.infer<typeof accountSettingsSchema>;

export interface AccountSettingsReader {
  read(accountName: string): Promise<M365AccountSettings>;
}

export interface AccountSettingsOptions {
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
}

export type AccountSettingsErrorCode =
  | "INVALID_ACCOUNT_NAME"
  | "SETTINGS_NOT_FOUND"
  | "SETTINGS_INVALID";

/** Typed at the adapter boundary; the CLI turns it into one actionable line. */
export class AccountSettingsError extends Error {
  readonly code: AccountSettingsErrorCode;
  readonly accountName: string;

  constructor(code: AccountSettingsErrorCode, accountName: string, message: string) {
    super(message);
    this.name = "AccountSettingsError";
    this.code = code;
    this.accountName = accountName;
  }
}

export function accountsDir(options: AccountSettingsOptions = {}): string {
  return join(options.configDir ?? DEFAULT_CONFIG_DIR, "accounts", PROVIDER);
}

/** User-facing path forms, so errors name the `~` location the user must populate. */
export function accountsDirDisplayPath(): string {
  return "~/.config/email-classify/accounts/m365";
}

export function accountSettingsDisplayPath(accountName: string): string {
  return `~/.config/email-classify/accounts/m365/${accountName}.yaml`;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function assertAccountName(accountName: string): void {
  if (!ACCOUNT_NAME_PATTERN.test(accountName)) {
    throw new AccountSettingsError(
      "INVALID_ACCOUNT_NAME",
      accountName,
      `Account name "${accountName}" is invalid — it must match ${ACCOUNT_NAME_PATTERN.source}.`,
    );
  }
}

export async function readAccountSettings(
  accountName: string,
  options: AccountSettingsOptions = {},
): Promise<M365AccountSettings> {
  assertAccountName(accountName);
  const path = join(accountsDir(options), `${accountName}.yaml`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      throw new AccountSettingsError(
        "SETTINGS_NOT_FOUND",
        accountName,
        `No settings for account "${accountName}" — create ${accountSettingsDisplayPath(accountName)}.`,
      );
    }
    throw new AccountSettingsError(
      "SETTINGS_INVALID",
      accountName,
      `Settings for account "${accountName}" could not be read (${accountSettingsDisplayPath(accountName)}).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch {
    throw new AccountSettingsError(
      "SETTINGS_INVALID",
      accountName,
      `Settings for account "${accountName}" are not valid YAML (${accountSettingsDisplayPath(accountName)}).`,
    );
  }
  const result = accountSettingsSchema.safeParse(parsed);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new AccountSettingsError(
      "SETTINGS_INVALID",
      accountName,
      `Settings for account "${accountName}" are invalid (${fields}) — check ${accountSettingsDisplayPath(accountName)}.`,
    );
  }
  if (result.data.name !== accountName) {
    throw new AccountSettingsError(
      "SETTINGS_INVALID",
      accountName,
      `Settings for account "${accountName}" declare name "${result.data.name}" — the file name and its "name" field must match.`,
    );
  }
  return result.data;
}

export interface M365AccountsListing {
  accounts: M365AccountSettings[];
  errors: AccountSettingsError[];
}

/**
 * The only implementable `--account all` source until `Config.m365.accounts[]`
 * lands (Epic 11): enumerate `accounts/m365/*.yaml`, skip names that fail the
 * account-name rule, keep `enabled: true` entries, and report — not swallow —
 * any file whose settings cannot be read or validated (I/O matrix row 8).
 */
export async function listEnabledAccounts(
  options: AccountSettingsOptions = {},
): Promise<M365AccountsListing> {
  let entries: string[];
  try {
    entries = await readdir(accountsDir(options));
  } catch (error) {
    // A missing directory means "no accounts yet"; anything else is a real failure.
    if (isEnoent(error)) return { accounts: [], errors: [] };
    throw error;
  }
  const accounts: M365AccountSettings[] = [];
  const errors: AccountSettingsError[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    const accountName = entry.slice(0, -".yaml".length);
    if (!ACCOUNT_NAME_PATTERN.test(accountName)) continue;
    try {
      const settings = await readAccountSettings(accountName, options);
      if (settings.enabled) accounts.push(settings);
    } catch (error) {
      errors.push(
        error instanceof AccountSettingsError
          ? error
          : new AccountSettingsError(
              "SETTINGS_INVALID",
              accountName,
              `Settings for account "${accountName}" could not be read.`,
            ),
      );
    }
  }
  return { accounts, errors };
}
