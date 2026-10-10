import type { FetchOpts } from "../core/dto/FetchOpts.js";
import type { MessageDTO } from "../core/dto/MessageDTO.js";
import type { LogPort } from "../core/ports/LogPort.js";
import { DEFAULT_BATCH_SIZE, DEFAULT_FOLDERS, type FetchAccount, type MessageFetchTarget } from "./fetch.js";

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

/**
 * The state one clean incremental fetch produced but has not yet recorded (Story 8.3's DTO egress
 * seam): the cycle start read before the fetch, plus Gmail's new history id. The caller commits it
 * — `writeLastRunTimestamp` and, for Gmail, the seam's `writeLastHistoryId` — only once its own
 * work on the fetched messages finished clean; a caller that holds the pending state re-fetches
 * the same window next cycle, which the 8.2 store makes cheap.
 */
export interface IncrementalPendingState {
  /** The instant read before the fetch; recorded as `lastRunTimestamp` on commit. */
  cycleStart: Date;
  /** Gmail's new history id (absent for m365); recorded as `lastHistoryId` on commit. */
  historyId?: string;
}

/**
 * One account's incremental fetch without any state write (Story 8.3's egress): the fetched
 * `MessageDTO`s — which `fetchIncremental` discards — plus the pending state the caller commits
 * only when the account finished clean. `failed` covers the state read and every fetch path, so a
 * failed account never carries `pending`; its cursor is held by construction.
 */
export interface IncrementalAccountEgress {
  accountId: string;
  /**
   * The fetched messages, including any a partly-failed folder walk produced — the caller decides
   * whether to process them (the committing `fetchIncremental` counts them; a retrying caller
   * re-fetches the window instead).
   */
  messages: MessageDTO[];
  /** Present iff the fetch completed cleanly; the caller commits it only once the account finished clean. */
  pending?: IncrementalPendingState;
  /** True when the state read or the fetch failed — nothing may be committed for the account. */
  failed: boolean;
}

/** The per-account seams of `fetchIncrementalAccount`. */
export interface FetchIncrementalAccountOptions {
  account: IncrementalAccount;
  mailPort: MessageFetchTarget;
  logPort: LogPort;
  readAccountState: ReadAccountState;
  /** The provider id stamped on every request; defaults to M365's. */
  source?: FetchOpts["source"];
  /** Required when `source` is "gmail". */
  gmail?: GmailIncrementalSeam;
  /** The clock seam; the cycle start is read from it before the state read. */
  now?: () => Date;
  /**
   * Story 9.2's shutdown signal. When a fetch throws with the signal aborted (the provider wait
   * was cut short), the abort is rethrown rather than logged as a per-folder error naming an
   * account that was never at fault; the caller abandons the account and holds its cursor.
   */
  signal?: AbortSignal;
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

/**
 * One account's folder walk: every folder's DTOs, collected, with the same per-account rules
 * `fetchAllMessages` applies — folder de-duplication, the `DEFAULT_FOLDERS`/`DEFAULT_BATCH_SIZE`
 * defaults, a per-folder failure logged with its folder that never stops the others, and the
 * `Fetched N messages.` info line only for a clean walk. `fetch.ts` is frozen (Story 8.3's out of
 * bounds), so the egress seam re-states its single-account walk here rather than widening that
 * module's contract to return DTOs.
 */
async function walkAccount(
  plan: FetchAccount,
  mailPort: MessageFetchTarget,
  logPort: LogPort,
  source: FetchOpts["source"],
  signal: AbortSignal | undefined,
): Promise<{ messages: MessageDTO[]; failed: boolean }> {
  const accountId = plan.accountId;
  const folders = plan.folders === undefined || plan.folders.length === 0 ? DEFAULT_FOLDERS : plan.folders;
  const batchSize = plan.batchSize ?? DEFAULT_BATCH_SIZE;
  const messages: MessageDTO[] = [];
  let failed = false;
  // A settings file can list the same folder twice; walking the de-duplicated list keeps both the
  // work and the count honest.
  for (const folder of new Set(folders)) {
    // An abort between folders starts no further fetch; the account is abandoned, not failed.
    if (signal?.aborted) {
      failed = true;
      break;
    }
    try {
      messages.push(
        ...(await mailPort.fetchMessages({
          source,
          accountId,
          folder,
          batchSize,
          ...(plan.since === undefined ? {} : { since: plan.since }),
        })),
      );
    } catch (error) {
      failed = true;
      // An interrupt during a provider wait is not this folder's fault: rethrow so the caller sees
      // the shutdown and abandons the account rather than logging a spurious line (Story 9.2).
      if (signal?.aborted) throw error;
      logPort.error(errorLine(error), { accountId, folder });
    }
  }
  if (!failed) logPort.info(`Fetched ${messages.length} messages.`, { accountId });
  return { messages, failed };
}

/** The Gmail fetch's clean outcome; `failed: true` carries any messages a partly-failed list walk produced. */
type GmailRawFetch = { failed: true; messages: MessageDTO[] } | { failed: false; messages: MessageDTO[]; historyId: string };

/** The per-fetch Gmail seams (no state writes — the caller commits the pending state). */
interface GmailFetchSeams {
  mailPort: MessageFetchTarget;
  logPort: LogPort;
  gmail: GmailIncrementalSeam;
  /** Story 9.2's shutdown signal, threaded through to the folder walk and the history calls. */
  signal?: AbortSignal;
}

/**
 * The Gmail list path, shared by the first run and the expiry fallback: read the profile's history
 * id **before** the INBOX walk, so the recorded id predates everything the walk sees and a message
 * arriving mid-cycle is re-fetched next run rather than lost. The stored cycle start bounds the
 * re-walk on the wire — the adapter's list URL carries `q=after:` for a `since` bound — and with
 * no stored timestamp (the first run) the whole INBOX is walked, so a mailbox is never silently
 * skipped.
 */
async function fetchGmailListRaw(
  account: IncrementalAccount,
  state: IncrementalAccountState,
  seams: GmailFetchSeams,
): Promise<GmailRawFetch> {
  const { mailPort, logPort, gmail } = seams;
  const accountId = account.accountId;
  let historyId: string;
  try {
    historyId = await gmail.history.fetchHistoryId(accountId);
  } catch (error) {
    // An interrupt during the profile call is a shutdown, not this account's failure.
    if (seams.signal?.aborted) throw error;
    logPort.error(errorLine(error), { accountId });
    return { failed: true, messages: [] };
  }
  const plan: FetchAccount = {
    accountId,
    folders: [GMAIL_INBOX],
    ...(account.batchSize === undefined ? {} : { batchSize: account.batchSize }),
    // The stored cycle start is the walk's lower bound; the adapter turns it into the
    // stepped-back `q=after:` filter. With the pre-walk profile id returned below, nothing
    // between that id and the walk can land unseen.
    ...(state.lastRunTimestamp === undefined ? {} : { since: new Date(state.lastRunTimestamp) }),
  };
  const walked = await walkAccount(plan, mailPort, logPort, "gmail", seams.signal);
  return walked.failed
    ? { failed: true, messages: walked.messages }
    : { failed: false, messages: walked.messages, historyId };
}

/**
 * One Gmail account's raw fetch: resume from the stored history id when there is one, otherwise
 * read the profile and walk the whole INBOX. An expired history id is warned about by name and
 * answered with the same list walk, bounded by the stored cycle start. Never writes state — the
 * returned history id is the caller's to commit.
 */
async function fetchGmailAccountRaw(
  account: IncrementalAccount,
  state: IncrementalAccountState,
  seams: GmailFetchSeams,
): Promise<GmailRawFetch> {
  const { logPort, gmail } = seams;
  const accountId = account.accountId;
  if (state.lastHistoryId === undefined) return fetchGmailListRaw(account, state, seams);
  let outcome: GmailHistoryOutcome;
  try {
    outcome = await gmail.history.fetchHistory({
      accountId,
      historyId: state.lastHistoryId,
      ...(account.batchSize === undefined ? {} : { batchSize: account.batchSize }),
    });
  } catch (error) {
    // An interrupt during the history call is a shutdown, not this account's failure.
    if (seams.signal?.aborted) throw error;
    logPort.error(errorLine(error), { accountId });
    return { failed: true, messages: [] };
  }
  if (outcome.kind === "expired") {
    // Warn by name, then fall back rather than skipping the account or crashing the cycle.
    logPort.warn(
      `Gmail's history for account "${accountId}" has expired — falling back to an INBOX walk since the last recorded cycle.`,
      { accountId },
    );
    return fetchGmailListRaw(account, state, seams);
  }
  const messages = outcome.messages;
  // A purged message's 404 part is a per-message answer, not the account's failure (EC1): warn
  // naming the id, keep the cycle successful, and let the returned history id move past it.
  for (const id of outcome.skippedIds) {
    logPort.warn(
      `Gmail's history for account "${accountId}" named message "${id}", but Gmail has since purged it — the message is skipped.`,
      { accountId },
    );
  }
  logPort.info(`Fetched ${messages.length} messages.`, { accountId });
  return { failed: false, messages, historyId: outcome.historyId };
}

/**
 * One account's incremental fetch as egress (Story 8.3's seam): M365 through the stored
 * `lastRunTimestamp` (Story 5.2), Gmail through the stored `lastHistoryId` — a history walk when
 * one is stored, the profile plus a full INBOX walk on a first run, and a warned INBOX fallback
 * whenever Gmail reports the history expired (Story 5.4). The cycle start is captured before the
 * state read, the fetch hands back its `MessageDTO`s plus the pending state, and nothing is
 * committed here: the caller commits only when the account finished clean, so a failed account's
 * cursor is held by construction. A state, profile, history, batch or fetch failure is logged with
 * its `accountId` and answers `failed: true`.
 */
export async function fetchIncrementalAccount(options: FetchIncrementalAccountOptions): Promise<IncrementalAccountEgress> {
  const { account, mailPort, logPort, readAccountState, source = "m365" } = options;
  const gmail = options.gmail;
  // A wiring bug, not a per-account failure: without the seam the Gmail branch could not run, and
  // falling through to the m365 list path would mis-stamp every DTO.
  if (source === "gmail" && gmail === undefined) {
    throw new Error('A Gmail run needs the Gmail incremental seam (history calls + "writeLastHistoryId").');
  }
  const cycleStart = (options.now ?? (() => new Date()))();
  const accountId = account.accountId;
  let state: IncrementalAccountState;
  try {
    state = await readAccountState(accountId);
  } catch (error) {
    logPort.error(errorLine(error), { accountId });
    return { accountId, messages: [], failed: true };
  }
  if (source === "gmail" && gmail !== undefined) {
    const fetched = await fetchGmailAccountRaw(account, state, {
      mailPort,
      logPort,
      gmail,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (fetched.failed) return { accountId, messages: fetched.messages, failed: true };
    return {
      accountId,
      messages: fetched.messages,
      failed: false,
      pending: { cycleStart, historyId: fetched.historyId },
    };
  }
  const walked = await walkAccount(toPlan(account, state.lastRunTimestamp), mailPort, logPort, source, options.signal);
  return {
    accountId,
    messages: walked.messages,
    failed: walked.failed,
    ...(walked.failed ? {} : { pending: { cycleStart } }),
  };
}

/**
 * Fetches only what is new per account and commits the state itself: M365 through the stored
 * `lastRunTimestamp` (Story 5.2), Gmail through the stored `lastHistoryId` — a history walk when
 * one is stored, the profile plus a full INBOX walk on a first run, and a warned INBOX fallback
 * whenever Gmail reports the history expired (Story 5.4). Each account's cycle start is captured
 * before its fetch, and the state only advances after that account's fetch succeeded — Gmail's
 * history id first, then the cycle start — so a failed cycle leaves its state untouched. Accounts
 * are processed sequentially and isolated: a state, profile, history, batch or fetch failure is
 * logged with its `accountId` and never aborts the others. Returns the total fetched and the count
 * of failed accounts so the caller can set an exit code. The one-cycle caller that needs the
 * fetched `MessageDTO`s (the cron cycle) uses `fetchIncrementalAccount` and commits itself.
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
    const egress = await fetchIncrementalAccount({
      account,
      mailPort,
      logPort,
      readAccountState,
      source,
      ...(gmail === undefined ? {} : { gmail }),
      now,
    });
    fetched += egress.messages.length;
    // An account counts as fetched when it returned messages or completed cleanly; a partly-failed
    // account still contributed messages, so it stays in the count while also counting as a failure.
    if (!egress.failed || egress.messages.length > 0) accountsFetched += 1;
    if (egress.failed || egress.pending === undefined) {
      // The fetch failed, so this account's stored state must not advance.
      if (egress.failed) failures += 1;
      continue;
    }
    try {
      // Gmail's history id first (empty ids never reach the writer: the state-file writer rejects
      // them), then the cycle start — a write failure means the next run repeats the work, so it
      // is logged and counted rather than swallowed.
      if (source === "gmail" && gmail !== undefined && egress.pending.historyId !== undefined) {
        await gmail.writeLastHistoryId(account.accountId, egress.pending.historyId);
      }
      await writeLastRunTimestamp(account.accountId, egress.pending.cycleStart);
    } catch (error) {
      // The messages came back, but the cursor did not advance; the next run repeats the work.
      failures += 1;
      logPort.error(errorLine(error), { accountId: account.accountId });
    }
  }
  return { fetched, failures, accountsFetched };
}
