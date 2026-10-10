import type { LabelSet } from "../core/dto/LabelSet.js";
import type { MessageDTO } from "../core/dto/MessageDTO.js";
import type { ModelConfig } from "../core/dto/ModelConfig.js";
import type { Taxonomy } from "../core/dto/Taxonomy.js";
import type { LogPort } from "../core/ports/LogPort.js";
import type { ModelPort } from "../core/ports/ModelPort.js";
import { classify } from "./classify.js";
import { DEFAULT_BATCH_SIZE, DEFAULT_FOLDERS, type FetchAccount, type MessageFetchTarget } from "./fetch.js";

/** How often an account's progress line is written, in processed messages (Story 8.1's AC). */
export const PROGRESS_INTERVAL = 100;

/** The one `MailPort` method this loop needs beyond `fetchMessages`; both adapters implement it (AD-8, AD-10). */
export interface LabelWriteTarget {
  writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void>;
}

/**
 * The idempotency seam the loop needs (AD-10): the pre-classify lookup and the post-write record,
 * both on the store's `(accountId, internetMessageId)` pair. The store adapter implements it; the
 * loop never sees the AC's hash or SQLite.
 */
export interface ClassificationRecordStore {
  /** The labels recorded for the pair, or `undefined` when the message was never completed. */
  labelsFor(accountId: string, internetMessageId: string): Promise<string[] | undefined>;
  /** Records a completed message — its labels, or an empty set — so a re-run skips it. */
  record(accountId: string, internetMessageId: string, labels: string[]): Promise<void>;
}

/** One account's backfill plan: the same fetch bounds the fetch loop takes, plus nothing new. */
export type BackfillAccount = FetchAccount;

/**
 * The per-account counters the AC names. `processed = labeled + skipped` keeps 8.1's meaning — an
 * already-recorded message is never classified — so the full partition of what was fetched is
 * `fetched = labeled + skipped + alreadyDone + errors`.
 */
export interface AccountProgress {
  processed: number;
  labeled: number;
  skipped: number;
  /** Messages the store already recorded, skipped before any classify call (Story 8.2). */
  alreadyDone: number;
  errors: number;
}

export interface BackfillOptions {
  accounts: BackfillAccount[];
  /** The fetch + write seam: one object carrying the two `MailPort` methods this loop needs. */
  mailPort: MessageFetchTarget & LabelWriteTarget;
  /** The durable per-message record; a resumed run skips what it already holds (Story 8.2). */
  store: ClassificationRecordStore;
  /** The active (merged, frozen) taxonomy every message is classified against. */
  taxonomy: Taxonomy;
  /** The configured model adapter; one `complete` call per attempt, owned by `classify`. */
  model: ModelPort;
  /** The run's model config, carried unchanged into `classify`. */
  config: ModelConfig;
  logPort: LogPort;
  /** The provider id stamped on every fetch; defaults to M365's (a Gmail run passes "gmail"). */
  source?: "m365" | "gmail";
  /**
   * The graceful-shutdown signal (Story 9.2). Absent for a direct/one-shot caller. When aborted,
   * both loops stop at their boundary: the in-flight message finishes, no further message or
   * account starts, and an account abandoned mid-fetch is not counted as failed.
   */
  signal?: AbortSignal;
}

export interface BackfillResult {
  /** Messages fetched across accounts that fetched cleanly; `fetched = labeled + skipped + alreadyDone + errors`. */
  fetched: number;
  /** Messages classified and labelled, across every account. */
  labeled: number;
  /** Messages the classifier emptied — processed without a write (the "skipped" counter). */
  skipped: number;
  /** Messages the store already recorded; they were never classified this run. */
  alreadyDone: number;
  /** Messages whose lookup, classification, write or record failed; each was logged and did not stop the run. */
  errors: number;
  /** Accounts whose fetch failed outright; they are reported on stderr by the caller. */
  failures: number;
}

/** Renders one actionable line — never a stack trace or a raw payload (AD-4). */
function errorLine(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logProgress(progress: AccountProgress, accountId: string, logPort: LogPort): void {
  logPort.info(
    `Processed ${progress.processed} message(s): ${progress.labeled} labeled, ${progress.skipped} skipped, ` +
      `${progress.alreadyDone} already done, ${progress.errors} error(s).`,
    { accountId },
  );
}

/** The seams of `classifyMessages`: everything the per-message flow needs beyond the messages. */
export interface ClassifyMessagesOptions {
  /** The account the messages belong to; names every log line and keys every store record. */
  accountId: string;
  /** The already-fetched messages to resolve; this flow never fetches (the caller owns the fetch). */
  messages: MessageDTO[];
  /** The label write seam: the one `MailPort` method this flow needs (AD-8, AD-10). */
  mailPort: LabelWriteTarget;
  store: ClassificationRecordStore;
  taxonomy: Taxonomy;
  model: ModelPort;
  config: ModelConfig;
  logPort: LogPort;
  /** Story 9.2's shutdown signal; aborts at the per-message boundary — the current message finishes. */
  signal?: AbortSignal;
}

export interface ClassifyMessagesResult {
  progress: AccountProgress;
  /**
   * Whether any `writeLabels` call rejected. The backfill treats it as one message error; the cron
   * cycle (Story 8.3) reads it as its single 30s-backoff-and-retry-once trigger.
   */
  writeFailed: boolean;
}

/**
 * The per-message classify→write→record unit (Stories 8.1/8.2) over an already-fetched list:
 * the flow `runAccount` runs after its fetch, exported so the cron cycle reuses it verbatim
 * against the incremental egress. One already-recorded message is skipped before any classify
 * call; a single message's lookup, classification, write or record failure is logged with its
 * message's id and never stops the remaining messages.
 */
export async function classifyMessages(options: ClassifyMessagesOptions): Promise<ClassifyMessagesResult> {
  const { accountId, messages, mailPort, store, taxonomy, model, config, logPort } = options;
  const progress: AccountProgress = { processed: 0, labeled: 0, skipped: 0, alreadyDone: 0, errors: 0 };
  let writeFailed = false;
  const context = { accountId };
  for (const message of messages) {
    // The per-message boundary (Story 9.2): once a signal has been handled, the message just
    // finished stays finished and no further message is started.
    if (options.signal?.aborted) break;
    // An empty identity can never key a record: every such message would collapse onto the one
    // `(accountId, "")` pair. It is therefore never looked up and never recorded — the message is
    // simply classified again on the next run, which is the safe half of that trade.
    const identity = message.internetMessageId;
    if (identity.length > 0) {
      let recorded: string[] | undefined;
      try {
        recorded = await store.labelsFor(accountId, identity);
      } catch (error) {
        // A read failure is this message's error; the account's remaining messages still run.
        progress.errors += 1;
        logPort.error(errorLine(error), { accountId, messageId: message.id });
        continue;
      }
      if (recorded !== undefined) {
        // Already recorded: no classify call, no write — the pre-classify skip the AC names.
        progress.alreadyDone += 1;
        continue;
      }
    }
    let labels: LabelSet;
    try {
      labels = await classify({ message, taxonomy, model, config, logPort, context });
    } catch (error) {
      progress.errors += 1;
      logPort.error(errorLine(error), { accountId, messageId: message.id });
      continue;
    }
    if (labels.labels.length > 0) {
      try {
        await mailPort.writeLabels(accountId, message.id, labels.labels);
      } catch (error) {
        progress.errors += 1;
        writeFailed = true;
        logPort.error(errorLine(error), { accountId, messageId: message.id });
        continue;
      }
    }
    // The outcome — labels or the empty set — is recorded only once the write it describes landed.
    // A failure here records nothing, so the next run retries the message; its add-only write is
    // safe to repeat.
    try {
      if (identity.length > 0) await store.record(accountId, identity, labels.labels);
    } catch (error) {
      progress.errors += 1;
      logPort.error(errorLine(error), { accountId, messageId: message.id });
      continue;
    }
    // An empty set is a valid classification — no write was attempted; both outcomes count as
    // processed, so the counters partition as processed = labeled + skipped.
    if (labels.labels.length === 0) progress.skipped += 1;
    else progress.labeled += 1;
    progress.processed += 1;
    if (progress.processed % PROGRESS_INTERVAL === 0) logProgress(progress, accountId, logPort);
  }
  return { progress, writeFailed };
}

/**
 * One account's fetch, then the per-message lookup → classify → write → record flow
 * (`classifyMessages`). The fetch walks the account's folders with the same
 * `DEFAULT_FOLDERS`/`DEFAULT_BATCH_SIZE` defaults the fetch loop uses, and — like that loop — one
 * folder's failure does not stop the account's other folders. Every fetched message is then
 * resolved individually: one already recorded in the store is skipped before any classify call,
 * and a single message's lookup, classification, write or record failure is logged with that
 * message's id and never stops the account's remaining messages.
 */
async function runAccount(
  account: BackfillAccount,
  options: BackfillOptions,
  logPort: LogPort,
): Promise<{ progress: AccountProgress; fetched: number; failed: boolean }> {
  const { mailPort, store, taxonomy, model, config, source = "m365" } = options;
  const accountId = account.accountId;
  const progress: AccountProgress = { processed: 0, labeled: 0, skipped: 0, alreadyDone: 0, errors: 0 };
  // An empty list is not "walk nothing" — it is a plan that never set folders, so it takes the default.
  const folders = account.folders === undefined || account.folders.length === 0 ? DEFAULT_FOLDERS : account.folders;
  const batchSize = account.batchSize ?? DEFAULT_BATCH_SIZE;

  const messages: MessageDTO[] = [];
  let accountFailed = false;
  // A settings file can list the same folder twice; walking the de-duplicated list keeps both the
  // work and the count honest.
  for (const folder of new Set(folders)) {
    // An abort between folders starts no further fetch; the account is abandoned, not failed.
    if (options.signal?.aborted) {
      accountFailed = true;
      break;
    }
    try {
      messages.push(
        ...(await mailPort.fetchMessages({
          source,
          accountId,
          folder,
          batchSize,
          ...(account.since === undefined ? {} : { since: account.since }),
        })),
      );
    } catch (error) {
      accountFailed = true;
      // An interrupt during a provider wait is not this folder's fault: the account is abandoned
      // with its cursor held, so nothing is logged here (Story 9.2).
      if (options.signal?.aborted) break;
      logPort.error(errorLine(error), { accountId, folder });
    }
  }
  // A failure in one folder does not abandon the account's other folders, but the account's
  // partial fetch must never be reported as a clean one.
  if (accountFailed) return { progress, fetched: messages.length, failed: true };

  const flow = await classifyMessages({
    accountId,
    messages,
    mailPort,
    store,
    taxonomy,
    model,
    config,
    logPort,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { progress: flow.progress, fetched: messages.length, failed: false };
}

/**
 * Runs a one-shot backfill across every account, sequentially and independently: each
 * account fetches, then classifies, writes and records its own messages, and one account's
 * failure is logged with its `accountId` and never aborts the others (Epic 8's isolation rule).
 * Returns the run's totals so the caller can report them and set an exit code.
 */
export async function runBackfillAccounts(options: BackfillOptions): Promise<BackfillResult> {
  const { accounts, logPort } = options;
  const result: BackfillResult = { fetched: 0, labeled: 0, skipped: 0, alreadyDone: 0, errors: 0, failures: 0 };
  for (const account of accounts) {
    // The account boundary (Story 9.2): the accounts finished above keep their committed cursors;
    // the interrupted account re-fetches on the next run.
    if (options.signal?.aborted) break;
    const accountId = account.accountId;
    let outcome: Awaited<ReturnType<typeof runAccount>>;
    try {
      outcome = await runAccount(account, options, logPort);
    } catch (error) {
      // An aborted fetch surfaces as a throw; the signal — never the error type — says it is a
      // shutdown, not a failure of this account.
      if (options.signal?.aborted) break;
      // A failure outside the per-message try (a programming fault, not a provider rejection):
      // reported with the account, never as a stack trace, and the run moves on.
      result.failures += 1;
      logPort.error(errorLine(error), { accountId });
      continue;
    }
    if (outcome.failed) {
      // An account abandoned by an interrupt holds its cursor and is not a failed account.
      if (options.signal?.aborted) break;
      result.failures += 1;
      continue;
    }
    result.fetched += outcome.fetched;
    result.labeled += outcome.progress.labeled;
    result.skipped += outcome.progress.skipped;
    result.alreadyDone += outcome.progress.alreadyDone;
    result.errors += outcome.progress.errors;
    // The final line must not duplicate a `PROGRESS_INTERVAL` line; an empty account still needs its own zero-progress report.
    if (outcome.progress.processed === 0 || outcome.progress.processed % PROGRESS_INTERVAL !== 0) {
      logProgress(outcome.progress, accountId, logPort);
    }
  }
  return result;
}
