import { basename, join } from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { ACCOUNT_NAME_PATTERN } from "../../core/dto/accountName.js";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "email-classify");

/** User-facing state directory; Epic 11 replaces this temporary reader with `ConfigLoader`. */
const STATE_DIR_DISPLAY_PATH = "~/.config/email-classify/state";

export interface StateFileOptions {
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
  /**
   * Which provider's cursor file to read/write: `state/m365-<name>.json` or
   * `state/gmail-<name>.json` (Story 5.4 decision 2-A, 2026-10-09), so same-named
   * accounts across providers never share a file. Defaults to m365, which keeps the
   * Stories 5.1/5.2 callers working unchanged.
   */
  provider?: "m365" | "gmail";
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
 * One account's fetch state. Every key is optional: M365 owns `lastRunTimestamp` (ISO 8601)
 * and `lastProcessedMessageId`, and a Gmail cycle records both `lastHistoryId` and its cycle
 * start (Story 5.4), so the two providers' keys are all merged — a writer never clobbers a key
 * another provider owns.
 */
export interface AccountState {
  lastRunTimestamp?: string;
  lastProcessedMessageId?: string;
  lastHistoryId?: string;
}

/** An ISO-8601 UTC instant, the only form `lastRunTimestamp` may take. */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The cursor file's name for one provider: `m365-<name>.json` or `gmail-<name>.json`. */
function stateFileName(accountName: string, provider: "m365" | "gmail"): string {
  return `${provider}-${accountName}.json`;
}

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

/**
 * The canonical cursor file's path — always the per-provider namespaced name (EC2), which is what
 * every write names and what read errors usually name; a legacy-file READ error may name
 * `state/<name>.json` instead (see `displayPathForFile`). The legacy file is never written.
 */
export function stateFileDisplayPath(accountName: string, options: StateFileOptions = {}): string {
  return options.configDir === undefined
    ? `${STATE_DIR_DISPLAY_PATH}/${stateFileName(accountName, options.provider ?? "m365")}`
    : join(accountStateDir(options), stateFileName(accountName, options.provider ?? "m365"));
}

/** The file an error names for a state file under an injected configDir, or the home form. */
function displayPathForFile(path: string, options: StateFileOptions): string {
  return options.configDir === undefined ? `${STATE_DIR_DISPLAY_PATH}/${basename(path)}` : path;
}

function invalidState(accountName: string, displayPath: string, detail: string): StateFileError {
  return new StateFileError(
    "STATE_INVALID",
    accountName,
    `State for account "${accountName}" is invalid — ${detail} (${displayPath}).`,
  );
}

function readTimestampField(
  raw: Record<string, unknown>,
  key: keyof AccountState,
  accountName: string,
  displayPath: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ISO_8601_UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalidState(accountName, displayPath, `"${key}" must be an ISO-8601 UTC string`);
  }
  return value;
}

function readIdField(
  raw: Record<string, unknown>,
  key: keyof AccountState,
  accountName: string,
  displayPath: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw invalidState(accountName, displayPath, `"${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Reads one account's state: a missing file is an empty state (the first run behaves like a
 * backfill), while unreadable, unparseable, or wrongly-typed state is a typed error naming the
 * account and path — never silently treated as "no state", which would re-walk the whole mailbox.
 * The cursor file is the per-provider namespaced one (`m365-<name>.json` / `gmail-<name>.json`,
 * Story 5.4's EC2); a legacy `state/<name>.json` written by Stories 5.1/5.2 is read back for
 * **m365 only** when the namespaced file is absent, and never written again — 5.2's cursors
 * survive the upgrade with no migration step, and a Gmail cycle can never touch an m365 bound.
 */
export async function readAccountState(accountName: string, options: StateFileOptions = {}): Promise<AccountState> {
  assertAccountName(accountName);
  const provider = options.provider ?? "m365";
  const dir = accountStateDir(options);
  const path = join(dir, stateFileName(accountName, provider));
  let displayPath = stateFileDisplayPath(accountName, options);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw new StateFileError(
        "STATE_INVALID",
        accountName,
        `State for account "${accountName}" could not be read (${displayPath}).`,
      );
    }
    if (provider !== "m365") return {};
    // The legacy name Stories 5.1/5.2 wrote; read-only.
    const legacyPath = join(dir, `${accountName}.json`);
    displayPath = displayPathForFile(legacyPath, options);
    try {
      raw = await readFile(legacyPath, "utf8");
    } catch (legacyError) {
      if (isEnoent(legacyError)) return {};
      throw new StateFileError(
        "STATE_INVALID",
        accountName,
        `State for account "${accountName}" could not be read (${displayPath}).`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidState(accountName, displayPath, "it is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidState(accountName, displayPath, "it must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const state: AccountState = {};
  const lastRunTimestamp = readTimestampField(record, "lastRunTimestamp", accountName, displayPath);
  if (lastRunTimestamp !== undefined) state.lastRunTimestamp = lastRunTimestamp;
  const lastProcessedMessageId = readIdField(record, "lastProcessedMessageId", accountName, displayPath);
  if (lastProcessedMessageId !== undefined) state.lastProcessedMessageId = lastProcessedMessageId;
  const lastHistoryId = readIdField(record, "lastHistoryId", accountName, displayPath);
  if (lastHistoryId !== undefined) state.lastHistoryId = lastHistoryId;
  return state;
}

/**
 * The one write body both providers share: read-merge-write the given keys so a key this
 * provider does not own (Gmail's `lastHistoryId`, M365's `lastProcessedMessageId`) survives and
 * an absent key stays absent. The directory is 0700 and the file 0600 (chmod on rewrite,
 * mirroring `KeychainTokenStore.writeFallbackFile`). An invalid existing file is never
 * overwritten. Always writes the per-provider namespaced file (EC2) — the legacy
 * `state/<name>.json` is never written again.
 *
 * ponytail: no lock around this read-merge-write — no concurrent runner exists until Story 8.3
 * owns one; the upgrade path is a lock file held around a cycle (Epic 8/9).
 */
async function writeMergedState(
  accountName: string,
  keys: AccountState,
  options: StateFileOptions,
): Promise<void> {
  assertAccountName(accountName);
  const existing = await readAccountState(accountName, options);
  const merged: AccountState = { ...existing, ...keys };
  const dir = accountStateDir(options);
  const path = join(dir, stateFileName(accountName, options.provider ?? "m365"));
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

/** Records an account's cycle start, merging it into the provider's state file. */
export async function writeLastRunTimestamp(
  accountName: string,
  date: Date,
  options: StateFileOptions = {},
): Promise<void> {
  await writeMergedState(accountName, { lastRunTimestamp: date.toISOString() }, options);
}

/**
 * Records Gmail's `lastHistoryId` (Story 5.4), merging it into the provider's state file — so a
 * history id and the cycle start recorded beside it share the writer, the permissions and the
 * no-clobber rules. An empty id is rejected here rather than persisted: its own reader
 * (`readIdField`) rejects one, so writing it would poison every later read (writer/reader
 * symmetry).
 */
export async function writeLastHistoryId(
  accountName: string,
  historyId: string,
  options: StateFileOptions = {},
): Promise<void> {
  // Gmail-only writer: unlike the shared options object, this one defaults to Gmail's namespace,
  // so a caller omitting `provider` writes the file the Gmail reader actually reads.
  const gmailOptions: StateFileOptions = { ...options, provider: "gmail" };
  if (historyId.length === 0) {
    throw invalidState(accountName, stateFileDisplayPath(accountName, gmailOptions), '"lastHistoryId" must be a non-empty string');
  }
  await writeMergedState(accountName, { lastHistoryId: historyId }, gmailOptions);
}
