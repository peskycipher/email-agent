import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_NAME_PATTERN } from "../../core/dto/accountName.js";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "email-classify");

/** User-facing state directory; Epic 11 replaces this temporary reader with `ConfigLoader`. */
const STATE_DIR_DISPLAY_PATH = "~/.config/email-classify/state";

export interface StateFileOptions {
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
}

export type StateFileErrorCode = "STATE_INVALID" | "STATE_WRITE_FAILED";

/** Typed at this temporary reader's boundary; the CLI turns it into one actionable line (AD-4). */
export class StateFileError extends Error {
  readonly code: StateFileErrorCode;
  readonly accountName: string;

  constructor(code: StateFileErrorCode, accountName: string, message: string) {
    super(message);
    this.name = "StateFileError";
    this.code = code;
    this.accountName = accountName;
  }
}

/**
 * One account's fetch state, shared by M365 and Gmail (Stories 5.2/5.4). Every key is
 * optional: M365 owns `lastRunTimestamp` (ISO 8601) and `lastProcessedMessageId`, Gmail
 * owns `lastHistoryId`. `writeLastRunTimestamp` merges, so one provider never clobbers the other.
 */
export interface AccountState {
  lastRunTimestamp?: string;
  lastProcessedMessageId?: string;
  lastHistoryId?: string;
}

/** An ISO-8601 UTC instant, the only form `lastRunTimestamp` may take. */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** The same account-name rule the sibling settings reader enforces — a name can never escape the state dir. */
function assertAccountName(accountName: string): void {
  if (!ACCOUNT_NAME_PATTERN.test(accountName)) {
    throw new StateFileError(
      "STATE_INVALID",
      accountName,
      `Account name "${accountName}" is invalid — it must match ${ACCOUNT_NAME_PATTERN.source}.`,
    );
  }
}

export function accountStateDir(options: StateFileOptions = {}): string {
  return join(options.configDir ?? DEFAULT_CONFIG_DIR, "state");
}

/** An injected `configDir` (tests, a future XDG override) must be named correctly in errors. */
export function stateFileDisplayPath(accountName: string, options: StateFileOptions = {}): string {
  return options.configDir === undefined
    ? `${STATE_DIR_DISPLAY_PATH}/${accountName}.json`
    : join(accountStateDir(options), `${accountName}.json`);
}

function invalidState(accountName: string, options: StateFileOptions, detail: string): StateFileError {
  return new StateFileError(
    "STATE_INVALID",
    accountName,
    `State for account "${accountName}" is invalid — ${detail} (${stateFileDisplayPath(accountName, options)}).`,
  );
}

function readTimestampField(raw: Record<string, unknown>, key: keyof AccountState, accountName: string, options: StateFileOptions): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ISO_8601_UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalidState(accountName, options, `"${key}" must be an ISO-8601 UTC string`);
  }
  return value;
}

function readIdField(raw: Record<string, unknown>, key: keyof AccountState, accountName: string, options: StateFileOptions): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw invalidState(accountName, options, `"${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Reads one account's state: a missing file is an empty state (the first run behaves like a
 * backfill), while unreadable, unparseable, or wrongly-typed state is a typed error naming the
 * account and path — never silently treated as "no state", which would re-walk the whole mailbox.
 */
export async function readAccountState(accountName: string, options: StateFileOptions = {}): Promise<AccountState> {
  assertAccountName(accountName);
  const path = join(accountStateDir(options), `${accountName}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return {};
    throw new StateFileError(
      "STATE_INVALID",
      accountName,
      `State for account "${accountName}" could not be read (${stateFileDisplayPath(accountName, options)}).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidState(accountName, options, "it is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidState(accountName, options, "it must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const state: AccountState = {};
  const lastRunTimestamp = readTimestampField(record, "lastRunTimestamp", accountName, options);
  if (lastRunTimestamp !== undefined) state.lastRunTimestamp = lastRunTimestamp;
  const lastProcessedMessageId = readIdField(record, "lastProcessedMessageId", accountName, options);
  if (lastProcessedMessageId !== undefined) state.lastProcessedMessageId = lastProcessedMessageId;
  const lastHistoryId = readIdField(record, "lastHistoryId", accountName, options);
  if (lastHistoryId !== undefined) state.lastHistoryId = lastHistoryId;
  return state;
}

/**
 * Records an account's cycle start, read-merge-write so a key this provider does not own
 * (Gmail's `lastHistoryId`, M365's `lastProcessedMessageId`) survives and an absent key stays
 * absent. The directory is 0700 and the file 0600 (chmod on rewrite, mirroring
 * `KeychainTokenStore.writeFallbackFile`). An invalid existing file is never overwritten.
 *
 * ponytail: no lock around this read-merge-write — no concurrent runner exists until Story 8.3
 * owns one; the upgrade path is a lock file held around a cycle (Epic 8/9).
 */
export async function writeLastRunTimestamp(
  accountName: string,
  date: Date,
  options: StateFileOptions = {},
): Promise<void> {
  assertAccountName(accountName);
  const existing = await readAccountState(accountName, options);
  const merged: AccountState = { ...existing, lastRunTimestamp: date.toISOString() };
  const dir = accountStateDir(options);
  const path = join(dir, `${accountName}.json`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only on creation; chmod restores 0700 on a pre-existing directory.
    await chmod(dir, 0o700);
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    // writeFile's mode applies only on creation; chmod guarantees 0600 on rewrite.
    await chmod(path, 0o600);
  } catch {
    throw new StateFileError(
      "STATE_WRITE_FAILED",
      accountName,
      `Could not write the state for account "${accountName}" (${stateFileDisplayPath(accountName, options)}).`,
    );
  }
}
