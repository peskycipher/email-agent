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

/** One account's backfill plan: the same fetch bounds the fetch loop takes, plus nothing new. */
export type BackfillAccount = FetchAccount;

/** The per-account counters the AC names; `processed = labeled + skipped`, with `errors` counted apart. */
export interface AccountProgress {
  processed: number;
  labeled: number;
  skipped: number;
  errors: number;
}

export interface BackfillOptions {
  accounts: BackfillAccount[];
  /** The fetch + write seam: one object carrying the two `MailPort` methods this loop needs. */
  mailPort: MessageFetchTarget & LabelWriteTarget;
  /** The active (merged, frozen) taxonomy every message is classified against. */
  taxonomy: Taxonomy;
  /** The configured model adapter; one `complete` call per attempt, owned by `classify`. */
  model: ModelPort;
  /** The run's model config, carried unchanged into `classify`. */
  config: ModelConfig;
  logPort: LogPort;
  /** The provider id stamped on every fetch; defaults to M365's (a Gmail run passes "gmail"). */
  source?: "m365" | "gmail";
}

export interface BackfillResult {
  /** Messages fetched and then classified, across accounts that fetched cleanly. */
  fetched: number;
  /** Messages classified and labelled, across every account. */
  labeled: number;
  /** Messages the classifier emptied — processed without a write (the "skipped" counter). */
  skipped: number;
  /** Messages whose classification or write failed; each was logged and did not stop the run. */
  errors: number;
  /** Accounts whose fetch failed outright; they are reported on stderr by the caller. */
  failures: number;
}

/** Renders one actionable line — never a stack trace or a raw payload (AD-4). */
function errorLine(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logProgress(progress: AccountProgress, accountId: string, logPort: LogPort): void {
  logPort.info(
    `Processed ${progress.processed} message(s): ${progress.labeled} labeled, ${progress.skipped} skipped, ${progress.errors} error(s).`,
    { accountId },
  );
}

/**
 * One account's fetch, then per-message classify → write. The fetch walks the account's
 * folders with the same `DEFAULT_FOLDERS`/`DEFAULT_BATCH_SIZE` defaults the fetch loop uses,
 * and — like that loop — one folder's failure does not stop the account's other folders. Every
 * fetched message is then classified and written individually: a single message's
 * classification rejection or write failure is logged with that message's id and never stops
 * the account's remaining messages.
 */
async function runAccount(
  account: BackfillAccount,
  options: BackfillOptions,
  logPort: LogPort,
): Promise<{ progress: AccountProgress; fetched: number; failed: boolean }> {
  const { mailPort, taxonomy, model, config, source = "m365" } = options;
  const accountId = account.accountId;
  const progress: AccountProgress = { processed: 0, labeled: 0, skipped: 0, errors: 0 };
  // An empty list is not "walk nothing" — it is a plan that never set folders, so it takes the default.
  const folders = account.folders === undefined || account.folders.length === 0 ? DEFAULT_FOLDERS : account.folders;
  const batchSize = account.batchSize ?? DEFAULT_BATCH_SIZE;

  const messages: MessageDTO[] = [];
  let accountFailed = false;
  // A settings file can list the same folder twice; walking the de-duplicated list keeps both the
  // work and the count honest.
  for (const folder of new Set(folders)) {
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
      logPort.error(errorLine(error), { accountId, folder });
    }
  }
  // A failure in one folder does not abandon the account's other folders, but the account's
  // partial fetch must never be reported as a clean one.
  if (accountFailed) return { progress, fetched: messages.length, failed: true };

  const context = { accountId };
  for (const message of messages) {
    let labels: LabelSet;
    try {
      labels = await classify({ message, taxonomy, model, config, logPort, context });
    } catch (error) {
      progress.errors += 1;
      logPort.error(errorLine(error), { accountId, messageId: message.id });
      continue;
    }
    if (labels.labels.length === 0) {
      // An empty set is a valid classification — no write is attempted, and the message is
      // counted as skipped, so the counters partition as processed = labeled + skipped.
      progress.skipped += 1;
      progress.processed += 1;
    } else {
      try {
        await mailPort.writeLabels(accountId, message.id, labels.labels);
        progress.labeled += 1;
        progress.processed += 1;
      } catch (error) {
        progress.errors += 1;
        logPort.error(errorLine(error), { accountId, messageId: message.id });
      }
    }
    if (progress.processed % PROGRESS_INTERVAL === 0) logProgress(progress, accountId, logPort);
  }
  return { progress, fetched: messages.length, failed: false };
}

/**
 * Runs a one-shot backfill across every account, sequentially and independently: each
 * account fetches, classifies and writes its own messages, and one account's failure is
 * logged with its `accountId` and never aborts the others (Epic 8's isolation rule). Returns
 * the run's totals so the caller can report them and set an exit code.
 */
export async function runBackfillAccounts(options: BackfillOptions): Promise<BackfillResult> {
  const { accounts, logPort } = options;
  const result: BackfillResult = { fetched: 0, labeled: 0, skipped: 0, errors: 0, failures: 0 };
  for (const account of accounts) {
    const accountId = account.accountId;
    let outcome: Awaited<ReturnType<typeof runAccount>>;
    try {
      outcome = await runAccount(account, options, logPort);
    } catch (error) {
      // A failure outside the per-message try (a programming fault, not a provider rejection):
      // reported with the account, never as a stack trace, and the run moves on.
      result.failures += 1;
      logPort.error(errorLine(error), { accountId });
      continue;
    }
    if (outcome.failed) {
      result.failures += 1;
      continue;
    }
    result.fetched += outcome.fetched;
    result.labeled += outcome.progress.labeled;
    result.skipped += outcome.progress.skipped;
    result.errors += outcome.progress.errors;
    // The final line must not duplicate a `PROGRESS_INTERVAL` line; an empty account still needs its own zero-progress report.
    if (outcome.progress.processed === 0 || outcome.progress.processed % PROGRESS_INTERVAL !== 0) {
      logProgress(outcome.progress, accountId, logPort);
    }
  }
  return result;
}
