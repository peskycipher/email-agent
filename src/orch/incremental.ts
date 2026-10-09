import type { FetchOpts } from "../core/dto/FetchOpts.js";
import type { LogPort } from "../core/ports/LogPort.js";
import { fetchAllMessages, type FetchAccount, type MessageFetchTarget } from "./fetch.js";

/** The slice of the shared state file this orchestrator reads; kept ISO to stay out of `core`. */
export interface IncrementalAccountState {
  lastRunTimestamp?: string;
}

/** Injected seam over `adapters/config/stateFile.readAccountState` (AD-10: `orch` imports only `core`). */
export type ReadAccountState = (accountName: string) => Promise<IncrementalAccountState>;

/** Injected seam over `adapters/config/stateFile.writeLastRunTimestamp` (AD-10). */
export type WriteLastRunTimestamp = (accountName: string, date: Date) => Promise<void>;

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
  /** The clock seam; defaults to the wall clock. The per-account cycle start is read from it before its fetch. */
  now?: () => Date;
}

export interface FetchIncrementalResult {
  fetched: number;
  failures: number;
}

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
 * Fetches only what is new per account (Story 5.2): read the account's stored `lastRunTimestamp`,
 * capture the account's cycle start, fetch with that instant as the lower bound, and — only after
 * the cycle succeeds — record the cycle start. With no stored timestamp the fetch is filterless, so
 * a first run behaves like a backfill and a mailbox is never silently skipped. Accounts are
 * processed sequentially and isolated: a state or fetch failure is logged with its `accountId` and
 * never aborts the others, and that account's stored state is left untouched. Returns the total
 * fetched and the count of failed accounts so the caller can set an exit code.
 */
export async function fetchIncremental(options: FetchIncrementalOptions): Promise<FetchIncrementalResult> {
  const {
    accounts,
    mailPort,
    logPort,
    readAccountState,
    writeLastRunTimestamp,
    source = "m365",
    now = () => new Date(),
  } = options;
  let fetched = 0;
  let failures = 0;
  for (const account of accounts) {
    const cycleStart = now();
    let plan: FetchAccount;
    try {
      const state = await readAccountState(account.accountId);
      plan = toPlan(account, state.lastRunTimestamp);
    } catch (error) {
      failures += 1;
      logPort.error(errorLine(error), { accountId: account.accountId });
      continue;
    }
    const result = await fetchAllMessages({ accounts: [plan], mailPort, logPort, source });
    fetched += result.fetched;
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
  return { fetched, failures };
}
