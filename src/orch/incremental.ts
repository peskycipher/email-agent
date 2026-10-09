import type { FetchOpts } from "../core/dto/FetchOpts.js";
import type { MessageDTO } from "../core/dto/MessageDTO.js";
import type { LogPort } from "../core/ports/LogPort.js";
import { fetchAllMessages, type FetchAccount, type MessageFetchTarget } from "./fetch.js";

/** The slice of the shared state file this orchestrator reads; kept ISO to stay out of `core`. */
export interface IncrementalAccountState {
  lastRunTimestamp?: string;
  /** Gmail's resume cursor (Story 5.4); read-only here — the Gmail cycle is what writes it. */
  lastHistoryId?: string;
}

/** Injected seam over `adapters/config/stateFile.readAccountState` (AD-10: `orch` imports only `core`). */
export type ReadAccountState = (accountName: string) => Promise<IncrementalAccountState>;

/** Injected seam over `adapters/config/stateFile.writeLastRunTimestamp` (AD-10). */
export type WriteLastRunTimestamp = (accountName: string, date: Date) => Promise<void>;

/** Injected seam over `adapters/config/stateFile.writeLastHistoryId` (AD-10). */
export type WriteLastHistoryId = (accountName: string, historyId: string) => Promise<void>;

/**
 * A history walk's outcome; `GmailAdapter` satisfies this structurally, so `orch` never imports an
 * adapter. `expired` is Gmail's documented 404 for a `startHistoryId` that has aged out — a normal
 * result the orchestrator falls back from, never an error and never "no new mail". `skippedIds`
 * names the added ids whose hydration answered 404 — a purged message's per-message answer, never
 * the account's failure (Story 5.4 decision EC1) — so the orchestrator can warn naming each id.
 */
export type GmailHistoryOutcome =
  | { kind: "ok"; messages: MessageDTO[]; historyId: string; skippedIds: string[] }
  | { kind: "expired" };

/** The two Gmail calls the Gmail cycle needs, mirroring `MessageFetchTarget`'s structural seam (AD-10). */
export interface GmailHistoryTarget {
  /** The mailbox's current `historyId` (`users.getProfile`); read before a list-path walk. */
  fetchHistoryId(accountId: string): Promise<string>;
  /** `users.history.list` from a stored id, hydrated into DTOs; a 404 answers `expired`. */
  fetchHistory(opts: { accountId: string; historyId: string; batchSize?: number }): Promise<GmailHistoryOutcome>;
}

/**
 * The Gmail half of the incremental loop (Story 5.4): the provider calls plus the write that
 * records `lastHistoryId`. One optional seam, so the Gmail path cannot be half-wired; absent for
 * an m365 run.
 */
export interface GmailIncrementalSeam {
  history: GmailHistoryTarget;
  writeLastHistoryId: WriteLastHistoryId;
}

/** One account's incremental fetch plan; the caller folds the provider's settings into these fields. */
export interface IncrementalAccount {
  accountId: string;
  folders?: string[];
  batchSize?: number;
}

export interface FetchIncrementalOptions {
  accounts: IncrementalAccount[];
  mailPort: MessageFetchTarget;
  logPort: LogPort;
  readAccountState: ReadAccountState;
  writeLastRunTimestamp: WriteLastRunTimestamp;
  /** The provider id stamped on every request; defaults to M365's (Story 5.4 passes "gmail"). */
  source?: FetchOpts["source"];
  /** Required when `source` is "gmail"; the m365 path needs none of it. */
  gmail?: GmailIncrementalSeam;
  /** The clock seam; defaults to the wall clock. The per-account cycle start is read from it before its fetch. */
  now?: () => Date;
}

export interface FetchIncrementalResult {
  fetched: number;
  failures: number;
  /** Accounts whose fetch produced messages (or completed cleanly); ≥1 whenever `fetched > 0`. */
  accountsFetched: number;
}

/** The epic's cron window: an incremental Gmail cycle always scopes to the INBOX system label (the same label the adapter's history walk hardcodes). */
const GMAIL_INBOX = "INBOX";

/** Renders one actionable line — never a stack trace or a raw payload (AD-4). */
function errorLine(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Folds the stored ISO bound (or its absence) into the account's folder walk. */
function toPlan(account: IncrementalAccount, lastRunTimestamp: string | undefined): FetchAccount {
  return {
    accountId: account.accountId,
    ...(account.folders === undefined ? {} : { folders: account.folders }),
    ...(account.batchSize === undefined ? {} : { batchSize: account.batchSize }),
    ...(lastRunTimestamp === undefined ? {} : { since: new Date(lastRunTimestamp) }),
  };
}

/** One Gmail account's cycle: what it produced and whether the account counts as failed. */
interface GmailCycleResult {
  fetched: number;
  failures: number;
}

/** The per-cycle seams every Gmail path shares. */
interface GmailCycleSeams {
  mailPort: MessageFetchTarget;
  logPort: LogPort;
  gmail: GmailIncrementalSeam;
  writeLastRunTimestamp: WriteLastRunTimestamp;
  cycleStart: Date;
}

/**
 * Records a Gmail cycle's state — the history id first (empty ids never reach the writer: the
 * state-file writer rejects them), then the cycle start — only ever called after that account's
 * fetch succeeded. A write failure means the next run repeats the work, so it is logged and
 * counted rather than swallowed.
 */
async function recordGmailState(
  accountId: string,
  historyId: string,
  seams: GmailCycleSeams,
): Promise<boolean> {
  try {
    await seams.gmail.writeLastHistoryId(accountId, historyId);
    await seams.writeLastRunTimestamp(accountId, seams.cycleStart);
    return true;
  } catch (error) {
    seams.logPort.error(errorLine(error), { accountId });
    return false;
  }
}

/**
 * The Gmail list path, shared by the first run and the expiry fallback: read the profile's history
 * id **before** the INBOX walk, so the recorded id predates everything the walk sees and a message
 * arriving mid-cycle is re-fetched next run rather than lost. The stored cycle start bounds the
 * re-walk on the wire — the adapter's list URL carries `q=after:` for a `since` bound — and with
 * no stored timestamp (the first run) the whole INBOX is walked, so a mailbox is never silently
 * skipped.
 */
async function fetchGmailListPath(
  account: IncrementalAccount,
  state: IncrementalAccountState,
  seams: GmailCycleSeams,
): Promise<GmailCycleResult> {
  const { mailPort, logPort, gmail } = seams;
  const accountId = account.accountId;
  let historyId: string;
  try {
    historyId = await gmail.history.fetchHistoryId(accountId);
  } catch (error) {
    logPort.error(errorLine(error), { accountId });
    return { fetched: 0, failures: 1 };
  }
  const plan: FetchAccount = {
    accountId,
    folders: [GMAIL_INBOX],
    ...(account.batchSize === undefined ? {} : { batchSize: account.batchSize }),
    // The stored cycle start is the walk's lower bound; the adapter turns it into the
    // stepped-back `q=after:` filter. With the pre-walk profile id recorded below, nothing
    // between that id and the walk can land unseen.
    ...(state.lastRunTimestamp === undefined ? {} : { since: new Date(state.lastRunTimestamp) }),
  };
  const result = await fetchAllMessages({ accounts: [plan], mailPort, logPort, source: "gmail" });
  if (result.failures > 0) return { fetched: result.fetched, failures: result.failures };
  const recorded = await recordGmailState(accountId, historyId, seams);
  return { fetched: result.fetched, failures: recorded ? 0 : 1 };
}

/**
 * One Gmail account's cycle: resume from the stored history id when there is one, otherwise read
 * the profile and walk the whole INBOX. An expired history id is warned about by name and answered
 * with the same list walk, bounded by the stored cycle start.
 */
async function fetchGmailAccount(
  account: IncrementalAccount,
  state: IncrementalAccountState,
  seams: GmailCycleSeams,
): Promise<GmailCycleResult> {
  const { logPort, gmail } = seams;
  const accountId = account.accountId;
  if (state.lastHistoryId === undefined) return fetchGmailListPath(account, state, seams);
  let outcome: GmailHistoryOutcome;
  try {
    outcome = await gmail.history.fetchHistory({
      accountId,
      historyId: state.lastHistoryId,
      ...(account.batchSize === undefined ? {} : { batchSize: account.batchSize }),
    });
  } catch (error) {
    logPort.error(errorLine(error), { accountId });
    return { fetched: 0, failures: 1 };
  }
  if (outcome.kind === "expired") {
    // Warn by name, then fall back rather than skipping the account or crashing the cycle.
    logPort.warn(
      `Gmail's history for account "${accountId}" has expired — falling back to an INBOX walk since the last recorded cycle.`,
      { accountId },
    );
    return fetchGmailListPath(account, state, seams);
  }
  const messages = outcome.messages;
  // A purged message's 404 part is a per-message answer, not the account's failure (EC1): warn
  // naming the id, keep the cycle successful, and let the recorded history id move past it.
  for (const id of outcome.skippedIds) {
    logPort.warn(
      `Gmail's history for account "${accountId}" named message "${id}", but Gmail has since purged it — the message is skipped.`,
      { accountId },
    );
  }
  logPort.info(`Fetched ${messages.length} messages.`, { accountId });
  const recorded = await recordGmailState(accountId, outcome.historyId, seams);
  return { fetched: messages.length, failures: recorded ? 0 : 1 };
}

/**
 * Fetches only what is new per account: M365 through the stored `lastRunTimestamp` (Story 5.2),
 * Gmail through the stored `lastHistoryId` — a history walk when one is stored, the profile plus a
 * full INBOX walk on a first run, and a warned INBOX fallback whenever Gmail reports the history
 * expired (Story 5.4). Each account's cycle start is captured before its fetch, and the state only
 * advances after that account's fetch succeeded, so a failed cycle leaves its state untouched.
 * Accounts are processed sequentially and isolated: a state, profile, history, batch or fetch
 * failure is logged with its `accountId` and never aborts the others. Returns the total fetched and
 * the count of failed accounts so the caller can set an exit code.
 */
export async function fetchIncremental(options: FetchIncrementalOptions): Promise<FetchIncrementalResult> {
  const {
    accounts,
    mailPort,
    logPort,
    readAccountState,
    writeLastRunTimestamp,
    source = "m365",
    gmail,
    now = () => new Date(),
  } = options;
  // A wiring bug, not a per-account failure: without the seam the Gmail branch could not run, and
  // falling through to the m365 list path would mis-stamp every DTO. Hoisted above the account
  // loop so it costs no per-account read and is thrown once, loudly.
  if (source === "gmail" && gmail === undefined) {
    throw new Error('A Gmail run needs the Gmail incremental seam (history calls + "writeLastHistoryId").');
  }
  let fetched = 0;
  let failures = 0;
  let accountsFetched = 0;
  for (const account of accounts) {
    const cycleStart = now();
    let state: IncrementalAccountState;
    try {
      state = await readAccountState(account.accountId);
    } catch (error) {
      failures += 1;
      logPort.error(errorLine(error), { accountId: account.accountId });
      continue;
    }
    if (source === "gmail" && gmail !== undefined) {
      const result = await fetchGmailAccount(account, state, {
        mailPort,
        logPort,
        gmail,
        writeLastRunTimestamp,
        cycleStart,
      });
      fetched += result.fetched;
      failures += result.failures;
      if (result.failures === 0 || result.fetched > 0) accountsFetched += 1;
      continue;
    }
    const plan = toPlan(account, state.lastRunTimestamp);
    const result = await fetchAllMessages({ accounts: [plan], mailPort, logPort, source });
    fetched += result.fetched;
    // An account counts as fetched when it returned messages or completed cleanly; a partly-failed
    // account still contributed messages, so it stays in the count while also counting as a failure.
    if (result.failures === 0 || result.fetched > 0) accountsFetched += 1;
    if (result.failures > 0) {
      // The fetch failed, so this account's stored state must not advance.
      failures += result.failures;
      continue;
    }
    try {
      await writeLastRunTimestamp(account.accountId, cycleStart);
    } catch (error) {
      // The messages came back, but the timestamp did not advance; the next run repeats the work.
      failures += 1;
      logPort.error(errorLine(error), { accountId: account.accountId });
    }
  }
  return { fetched, failures, accountsFetched };
}
