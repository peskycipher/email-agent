import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import type { ZodType } from "zod";
import { ACCOUNT_NAME_PATTERN } from "../../core/dto/accountName.js";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "email-classify");

/** Every per-account settings shape must at least carry the slug and the `@account all` flag. */
export interface PerAccountSettingsBase {
  name: string;
  enabled: boolean;
}

export interface PerAccountSettingsOptions {
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

export interface PerAccountSettingsReader<S> {
  read(accountName: string): Promise<S>;
}

export interface PerAccountSettingsListing<S> {
  accounts: S[];
  errors: AccountSettingsError[];
}

export interface PerAccountSettingsSpec<S extends PerAccountSettingsBase> {
  /** Directory under `accounts/`; also the `provider` id used with `TokenPort`. */
  provider: string;
  /** Validates one account file; must require `name` (a slug) and `enabled`. Unknown keys (e.g. the Epic-5 label keys in a Gmail file) are tolerated. */
  schema: ZodType<S>;
  /** User-facing directory form, e.g. `~/.config/email-classify/accounts/gmail`. */
  displayDir: string;
}

export interface PerAccountSettings<S extends PerAccountSettingsBase> {
  accountsDir(options?: PerAccountSettingsOptions): string;
  accountsDirDisplayPath(): string;
  accountSettingsDisplayPath(accountName: string): string;
  readAccountSettings(accountName: string, options?: PerAccountSettingsOptions): Promise<S>;
  listEnabledAccounts(options?: PerAccountSettingsOptions): Promise<PerAccountSettingsListing<S>>;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * The one per-account reader machine (Story 3.1): each provider supplies only its
 * directory name, its Zod schema and its display path. The readers are temporary
 * (Story 2.1 decision 1) — Epic 11 replaces them with `ConfigLoader`/DI over
 * `Config.<provider>.accounts[]`.
 */
export function createPerAccountSettings<S extends PerAccountSettingsBase>(
  spec: PerAccountSettingsSpec<S>,
): PerAccountSettings<S> {
  const { provider, schema, displayDir } = spec;

  function accountsDir(options: PerAccountSettingsOptions = {}): string {
    return join(options.configDir ?? DEFAULT_CONFIG_DIR, "accounts", provider);
  }

  function accountsDirDisplayPath(): string {
    return displayDir;
  }

  function accountSettingsDisplayPath(accountName: string): string {
    return `${displayDir}/${accountName}.yaml`;
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

  async function readAccountSettings(
    accountName: string,
    options: PerAccountSettingsOptions = {},
  ): Promise<S> {
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
    const result = schema.safeParse(parsed);
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

  /**
   * The only implementable `--account all` source until `Config.<provider>.accounts[]`
   * lands (Epic 11): enumerate `accounts/<provider>/*.yaml`, skip names that fail the
   * account-name rule, keep `enabled: true` entries, and report — not swallow — any
   * file whose settings cannot be read or validated (I/O matrix row 8).
   */
  async function listEnabledAccounts(
    options: PerAccountSettingsOptions = {},
  ): Promise<PerAccountSettingsListing<S>> {
    let entries: string[];
    try {
      entries = await readdir(accountsDir(options));
    } catch (error) {
      // A missing directory means "no accounts yet"; anything else is a real failure.
      if (isEnoent(error)) return { accounts: [], errors: [] };
      throw error;
    }
    const accounts: S[] = [];
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

  return {
    accountsDir,
    accountsDirDisplayPath,
    accountSettingsDisplayPath,
    readAccountSettings,
    listEnabledAccounts,
  };
}
