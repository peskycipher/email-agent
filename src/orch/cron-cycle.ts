import type { LabelDef } from "../core/dto/LabelDef.js";
import type { ModelConfig } from "../core/dto/ModelConfig.js";
import type { Taxonomy } from "../core/dto/Taxonomy.js";
import type { LogPort } from "../core/ports/LogPort.js";
import type { ModelPort } from "../core/ports/ModelPort.js";
import {
  classifyMessages,
  logProgress,
  PROGRESS_INTERVAL,
  type AccountProgress,
  type ClassificationRecordStore,
  type LabelWriteTarget,
} from "./classification-run.js";
import type { MessageFetchTarget } from "./fetch.js";
import {
  fetchIncrementalAccount,
  type GmailIncrementalSeam,
  type IncrementalAccount,
  type IncrementalPendingState,
  type ReadAccountState,
  type WriteLastRunTimestamp,
} from "./incremental.js";

/**
 * The one backoff before an account's single retry (the AC's 30 seconds). Epic 9 owns exponential
 * backoff; this is deliberately the one flat wait the cron matrix names.
 */
export const RETRY_BACKOFF_MS = 30_000;

/**
 * One provider's half of a cycle: its selected accounts, its fetch+write port, its own
 * namespaced state seams (the caller closes them over the provider's `state/<provider>-<name>.json`)
 * and, for Gmail, its history seam. `--source all` is two of these in one cycle.
 */
/**
 * The one `MailPort` method the Gmail half of a cycle needs beyond fetch and write: the adapter's
 * `writeLabels` refuses an uncached account (Story 7.2's typed error), so the cycle must populate
 * the name → id map itself. m365's write needs no cache and no call (Story 7.1).
 */
export interface CategoryEnsureTarget {
  ensureCategories(accountId: string, labels: LabelDef[]): Promise<void>;
}

export interface CronCycleProvider {
  source: "m365" | "gmail";
  accounts: IncrementalAccount[];
  /** The fetch + write + category-ensure seam: the three `MailPort` methods the cycle needs (AD-8, AD-10). */
  mailPort: MessageFetchTarget & LabelWriteTarget & CategoryEnsureTarget;
  readAccountState: ReadAccountState;
  writeLastRunTimestamp: WriteLastRunTimestamp;
  /** Story 5.4's Gmail half; required for a gmail provider (the cycle throws without it). */
  gmail?: GmailIncrementalSeam;
}

export interface CronCycleOptions {
  /** Every provider's selected accounts, run sequentially and isolated within the cycle. */
  providers: CronCycleProvider[];
  /** The durable per-message record; a re-fetched window skips what it already holds (Story 8.2). */
  store: ClassificationRecordStore;
  /** The active (merged, frozen) taxonomy every message is classified against. */
  taxonomy: Taxonomy;
  /** The configured model adapter; one `complete` call per attempt, owned by `classify`. */
  model: ModelPort;
  /** The run's model config, carried unchanged into `classify`. */
  config: ModelConfig;
  logPort: LogPort;
  /** The clock seam; defaults to the wall clock. The cycle start is read from it before anything runs. */
  now?: () => Date;
  /** The backoff seam; defaults to a real `setTimeout` sleep. Injected so tests never really wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The graceful-shutdown signal (Story 9.2). Absent for a direct caller. When aborted, the cycle
   * stops at the account boundary, holds the in-flight account's cursor, and neither counts nor
   * logs it as a failure.
   */
  signal?: AbortSignal;
}

/**
 * The per-cycle counters the AC's one line reports. `fetched = labeled + skipped + alreadyDone +
 * errors` across the accounts that ran; `failures` counts accounts whose cycle ended failed.
 */
export interface CronCycleResult {
  fetched: number;
  labeled: number;
  skipped: number;
  alreadyDone: number;
  errors: number;
  /** Accounts whose cycle failed (a fetch or write failing twice, or a state commit failing). */
  failures: number;
  /** The failed accounts' names, so the caller's per-cycle line can name them (isolation rule). */
  failedAccounts: string[];
  /** The instant the cycle started, read from the `now` seam before anything ran. */
  startedAt: Date;
  /** The cycle's wall-clock length in milliseconds, read from the same seam. */
  durationMs: number;
}

/** Renders one actionable line — never a stack trace or a raw payload (AD-4). */
function errorLine(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyProgress(): AccountProgress {
  return { processed: 0, labeled: 0, skipped: 0, alreadyDone: 0, errors: 0 };
}

/** One account's cycle attempt: what it produced, and whether it earns the single backoff retry. */
interface AccountAttempt {
  fetched: number;
  progress: AccountProgress;
  /** A fetch or `writeLabels` failure — the AC's single 30s-backoff-and-retry-once trigger. */
  retryable: boolean;
  pending?: IncrementalPendingState;
}

/**
 * One account's attempt: the incremental egress fetch, then the per-message classify → write →
 * record flow over what it produced. The state is never committed here — the attempt hands back
 * the pending state and the caller commits it only when the account finished clean.
 */
async function runAccountAttempt(
  provider: CronCycleProvider,
  account: IncrementalAccount,
  options: CronCycleOptions,
): Promise<AccountAttempt> {
  const egress = await fetchIncrementalAccount({
    account,
    mailPort: provider.mailPort,
    logPort: options.logPort,
    readAccountState: provider.readAccountState,
    source: provider.source,
    ...(provider.gmail === undefined ? {} : { gmail: provider.gmail }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // A failed fetch earned its one retry; its partly-fetched messages are left for that retry's
  // re-fetch (the held cursor re-covers them, and the store makes the re-walk cheap).
  if (egress.failed) return { fetched: 0, progress: emptyProgress(), retryable: true };
  // Gmail's write refuses an uncached account, and a daemon that never synced would wedge the
  // account forever — every write failing while its held cursor never advances. Ensuring the
  // taxonomy's labels each cycle is one labels GET that self-heals that; a failure is the
  // account's retryable kind, so the single 30s backoff and retry apply.
  if (provider.source === "gmail") {
    try {
      await provider.mailPort.ensureCategories(account.accountId, options.taxonomy);
    } catch (error) {
      // An interrupt during the labels call is a shutdown, not this account's failure: rethrow so
      // the cycle's abort check abandons it without a spurious line (Story 9.2).
      if (options.signal?.aborted) throw error;
      options.logPort.error(errorLine(error), { accountId: account.accountId });
      return { fetched: 0, progress: emptyProgress(), retryable: true };
    }
  }
  const flow = await classifyMessages({
    accountId: account.accountId,
    messages: egress.messages,
    mailPort: provider.mailPort,
    store: options.store,
    taxonomy: options.taxonomy,
    model: options.model,
    config: options.config,
    logPort: options.logPort,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    fetched: egress.messages.length,
    progress: flow.progress,
    retryable: flow.writeFailed,
    ...(egress.pending === undefined ? {} : { pending: egress.pending }),
  };
}

/**
 * One cron cycle across every selected account of every provider, sequentially and isolated
 * (Story 8.3): per account, the incremental egress fetch → classify → write → record (8.1's
 * stages over 8.2's store) → commit the pending state **only when the account finished clean** —
 * the held-cursor re-queue, so the next cycle re-fetches the window while completed messages
 * answer `alreadyDone` and the failed ones genuinely retry. A fetch or `writeLabels` failure
 * backs off 30 seconds and retries that account's cycle once; a second failure logs one line,
 * counts the account failed and holds its cursor. One account's failure is logged with its name
 * and never aborts the others; a failed account never reads as a successful one.
 */
export async function runCronCycle(options: CronCycleOptions): Promise<CronCycleResult> {
  const { providers, logPort } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // A wiring bug, not a per-account failure: without the seam the Gmail branch could not run.
  // Hoisted above the cycle so it is thrown once, loudly, before any account is touched.
  for (const provider of providers) {
    if (provider.source === "gmail" && provider.gmail === undefined) {
      throw new Error('A Gmail run needs the Gmail incremental seam (history calls + "writeLastHistoryId").');
    }
  }
  const startedAt = now();
  const result: CronCycleResult = {
    fetched: 0,
    labeled: 0,
    skipped: 0,
    alreadyDone: 0,
    errors: 0,
    failures: 0,
    failedAccounts: [],
    startedAt,
    durationMs: 0,
  };
  const finish = (): CronCycleResult => {
    result.durationMs = now().getTime() - startedAt.getTime();
    return result;
  };
  for (const provider of providers) {
    for (const account of provider.accounts) {
      // The account boundary (Story 9.2): the accounts above are counted and committed; nothing
      // further starts once a signal has been handled.
      if (options.signal?.aborted) return finish();
      const accountId = account.accountId;
      let attempt: AccountAttempt;
      try {
        attempt = await runAccountAttempt(provider, account, options);
      } catch (error) {
        // An aborted fetch's thrown wait is the shutdown, not this account's failure.
        if (options.signal?.aborted) return finish();
        // A failure outside the per-message try (a programming fault, not a provider rejection):
        // reported with the account, never as a stack trace, and the cycle moves on.
        result.failures += 1;
        result.failedAccounts.push(accountId);
        logPort.error(errorLine(error), { accountId });
        continue;
      }
      if (attempt.retryable) {
        // A shutdown in progress holds the cursor and stops rather than backing off into the loop.
        if (options.signal?.aborted) return finish();
        logPort.warn(
          `Account "${accountId}" failed its cycle — backing off 30 seconds, then retrying the account's cycle once.`,
          { accountId },
        );
        try {
          await sleep(RETRY_BACKOFF_MS);
        } catch (error) {
          // The shutdown's abort surfaces as a throw from the raced wait; any other fault is a
          // wiring fault and keeps escaping to the CLI (the CYCLE_FAULT contract).
          if (options.signal?.aborted) return finish();
          throw error;
        }
        if (options.signal?.aborted) return finish();
        try {
          attempt = await runAccountAttempt(provider, account, options);
        } catch (error) {
          if (options.signal?.aborted) return finish();
          result.failures += 1;
          result.failedAccounts.push(accountId);
          logPort.error(errorLine(error), { accountId });
          continue;
        }
        if (attempt.retryable) {
          // The second failure the AC names: logged, the account counts failed, its cursor stays
          // held, and the loop proceeds to the next interval.
          result.failures += 1;
          result.failedAccounts.push(accountId);
          logPort.error(
            `Account "${accountId}" failed again after one retry — its cursor is held; the next cycle re-fetches the window.`,
            { accountId },
          );
          continue;
        }
      }
      const progress = attempt.progress;
      result.fetched += attempt.fetched;
      result.labeled += progress.labeled;
      result.skipped += progress.skipped;
      result.alreadyDone += progress.alreadyDone;
      result.errors += progress.errors;
      // The same final per-account line the backfill run writes; an empty account still gets one.
      if (progress.processed === 0 || progress.processed % PROGRESS_INTERVAL !== 0) {
        logProgress(progress, accountId, logPort);
      }
      // The held-cursor re-queue: any message error (classify, record, lookup) holds the account's
      // state, so the next cycle re-fetches the window — completed messages answer `alreadyDone`
      // through the store and the failed ones genuinely retry.
      if (progress.errors > 0 || attempt.pending === undefined) continue;
      // An abort leaves a partly-processed account: hold its cursor so the next run re-fetches the
      // tail it never saw, and stop without committing (Story 9.2).
      if (options.signal?.aborted) return finish();
      // Gmail's history id first (mirroring the incremental commit), then the cycle start; the
      // writes are separate, so a partial commit is reported for what it did.
      if (provider.source === "gmail" && provider.gmail !== undefined && attempt.pending.historyId !== undefined) {
        try {
          await provider.gmail.writeLastHistoryId(accountId, attempt.pending.historyId);
        } catch (error) {
          // Nothing landed: the next cycle repeats the window.
          result.failures += 1;
          result.failedAccounts.push(accountId);
          logPort.error(errorLine(error), { accountId });
          continue;
        }
      }
      try {
        await provider.writeLastRunTimestamp(accountId, attempt.pending.cycleStart);
      } catch (error) {
        result.failures += 1;
        result.failedAccounts.push(accountId);
        if (provider.source === "gmail" && attempt.pending.historyId !== undefined) {
          // The history id landed, so the window will not repeat — say that, never "cursor held":
          // a held-cursor line here would promise a re-fetch that cannot happen.
          logPort.error(
            `Account "${accountId}": its history id committed but the cycle start did not — this window will not repeat next cycle (${errorLine(error)}).`,
            { accountId },
          );
        } else {
          logPort.error(errorLine(error), { accountId });
        }
      }
    }
  }
  return finish();
}
