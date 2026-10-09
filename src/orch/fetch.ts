import type { FetchOpts } from "../core/dto/FetchOpts.js";
import type { MessageDTO } from "../core/dto/MessageDTO.js";
import type { LogPort } from "../core/ports/LogPort.js";

/** The one `MailPort` method this loop needs; both provider adapters implement it (AD-8). */
export interface MessageFetchTarget {
  fetchMessages(opts: FetchOpts): Promise<MessageDTO[]>;
}

/** One account's fetch plan; the caller folds the provider's settings into these fields. */
export interface FetchAccount {
  accountId: string;
  folders?: string[];
  batchSize?: number;
  /** The incremental lower bound (Story 5.2); absent on the backfill path, so no `$filter` is issued. */
  since?: Date;
}

/** The folder walk's default, written once here so the orchestrator and Story 5.3 agree on it. */
export const DEFAULT_FOLDERS = ["Inbox"];

/** The `$top`/`maxResults` default, written once here so the orchestrator and Story 5.3 agree on it. */
export const DEFAULT_BATCH_SIZE = 50;

export interface FetchAllMessagesOptions {
  accounts: FetchAccount[];
  mailPort: MessageFetchTarget;
  logPort: LogPort;
  /** The provider id stamped on every request; defaults to M365's (Story 5.3 passes "gmail"). */
  source?: FetchOpts["source"];
}

export interface FetchAllMessagesResult {
  fetched: number;
  failures: number;
}

/** Renders one actionable line — never a stack trace or a raw payload (AD-4). */
function errorLine(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetches every account's messages sequentially, one folder at a time, and independently:
 * one account's failure (auth, non-2xx, network) is logged with its `accountId` and never
 * aborts the others, while a failure in one folder does not stop that account's other
 * folders. Each account's folders use the `DEFAULT_FOLDERS`/`DEFAULT_BATCH_SIZE` defaults
 * unless its plan overrides them, and an account's `since` (Story 5.2) bounds each of its
 * folders' fetches while an absent `since` leaves the walk filterless. Returns the total fetched
 * and the count of failed accounts so the caller can set an exit code. Story 5.3 reuses this loop for Gmail.
 */
export async function fetchAllMessages(options: FetchAllMessagesOptions): Promise<FetchAllMessagesResult> {
  const { accounts, mailPort, logPort, source = "m365" } = options;
  let fetched = 0;
  let failures = 0;
  for (const account of accounts) {
    // An empty list is not "walk nothing" — it is a plan that never set folders, so it takes the default.
    const folders =
      account.folders === undefined || account.folders.length === 0 ? DEFAULT_FOLDERS : account.folders;
    const batchSize = account.batchSize ?? DEFAULT_BATCH_SIZE;
    let accountFetched = 0;
    let accountFailed = false;
    // A settings file can list the same folder twice; walking the de-duplicated list keeps both the
    // work and the count honest.
    for (const folder of new Set(folders)) {
      try {
        const messages = await mailPort.fetchMessages({
          source,
          accountId: account.accountId,
          folder,
          batchSize,
          ...(account.since === undefined ? {} : { since: account.since }),
        });
        accountFetched += messages.length;
      } catch (error) {
        if (!accountFailed) failures += 1;
        accountFailed = true;
        logPort.error(errorLine(error), { accountId: account.accountId, folder });
      }
    }
    fetched += accountFetched;
    if (!accountFailed) {
      logPort.info(`Fetched ${accountFetched} messages.`, { accountId: account.accountId });
    }
  }
  return { fetched, failures };
}
