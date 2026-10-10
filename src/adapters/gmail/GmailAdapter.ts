import type { LabelDef } from "../../core/dto/LabelDef.js";
import type { FetchOpts } from "../../core/dto/FetchOpts.js";
import type { MessageDTO } from "../../core/dto/MessageDTO.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import { fetchHistoryId, fetchHistory, type GmailHistoryOpts, type GmailHistoryOutcome } from "./gmailHistory.js";
import { fetchMessages } from "./gmailMessageFetch.js";
import { ensureCategories } from "./gmailLabelSync.js";
import { writeLabels } from "./gmailLabelWrite.js";
import {
  GmailAdapterError,
  type GmailAdapterErrorCode,
  type GmailAdapterServices,
  type GmailFetchFn,
  type GmailGetAccessToken,
  type GmailLabelIds,
} from "./gmailWire.js";

export { GmailAdapterError, type GmailAdapterErrorCode, type GmailLabelIds, type GmailHistoryOpts, type GmailHistoryOutcome };

export interface GmailAdapterDeps {
  /**
   * Story 3.1's `FetchLike` shape, except `body` is optional: a Gmail label-list `GET`
   * must not carry a body, while `GmailAuthAdapter`'s shape requires one for its form
   * posts. The wider shape accepts that seam, so one injected `fetchFn` serves both.
   */
  fetchFn: GmailFetchFn;
  /** Story 3.1's silent-refresh seam (`GmailAuthAdapter.getAccessToken`); Gmail work never talks to Google's token endpoint directly. */
  getAccessToken: GmailGetAccessToken;
  /** Epic 7's 404 warning for moved messages; the caller supplies the orchestration log seam. */
  logPort: LogPort;
  /** Story 9.1's backoff seam, threaded from the CLI; defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Gmail adapter facade. One implementation of `MailPort`'s `ensureCategories`/`fetchMessages`/
 * `writeLabels`, plus the incremental orchestrator's `fetchHistoryId`/`fetchHistory`; it holds the
 * per-account caches and delegates each concern to a focused sibling module under
 * `src/adapters/gmail/` (Epic 6 retrospective split).
 */
export class GmailAdapter {
  private readonly services: GmailAdapterServices;
  /**
   * The AC's per-account cache, keyed by account id, read back through `labelIdsFor`. It is a
   * snapshot of the last *complete* sync: a mid-loop create failure leaves the previous snapshot
   * untouched, and the next successful run replaces it.
   */
  private readonly labelIdsByAccount = new Map<string, GmailLabelIds>();
  /** Gmail labels overlap by design, so a message this instance already returned for the account is not returned twice. */
  private readonly returnedIdsByAccount = new Map<string, Set<string>>();

  constructor(deps: GmailAdapterDeps) {
    this.services = {
      fetchFn: deps.fetchFn,
      getAccessToken: deps.getAccessToken,
      logPort: deps.logPort,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      labelIdsByAccount: this.labelIdsByAccount,
      returnedIdsByAccount: this.returnedIdsByAccount,
    };
  }

  /**
   * Idempotent: reads the account's labels, then creates only the labels whose `name` is
   * absent — an exact, case-sensitive match. A label that already exists keeps its name
   * and colour; nothing is ever renamed, re-coloured or deleted. Every taxonomy name ends
   * up in the account's name → id map, ids drawn from the list for the labels that existed
   * and from each create response for the rest.
   */
  async ensureCategories(accountId: string, labels: LabelDef[]): Promise<void> {
    return ensureCategories(this.services, accountId, labels);
  }

  /** The account's cached name → label-id map, or `undefined` before its first sync. Read-only: the cache is the adapter's. */
  labelIdsFor(accountId: string): GmailLabelIds | undefined {
    return this.labelIdsByAccount.get(accountId);
  }

  /**
   * Walks the account's message list page by page, following `nextPageToken` until it is
   * absent, and hydrates each page's ids through the multipart batch endpoint (Story 5.3).
   */
  async fetchMessages(opts: FetchOpts): Promise<MessageDTO[]> {
    return fetchMessages(this.services, opts);
  }

  /**
   * The mailbox's current `historyId` (`users.getProfile`). A list-path cycle reads it **before**
   * its walk, so the id predates everything the walk sees and a message arriving mid-cycle is
   * re-fetched next run rather than lost (Story 5.4).
   */
  async fetchHistoryId(accountId: string): Promise<string> {
    return fetchHistoryId(this.services, accountId);
  }

  /**
   * Walks `users.history.list` from a stored `startHistoryId`, page by page, scoped to `INBOX`
   * (the epic's cron window), and hydrates only the `messagesAdded` ids through the same batch
   * endpoint `fetchMessages` uses.
   */
  async fetchHistory(opts: GmailHistoryOpts): Promise<GmailHistoryOutcome> {
    return fetchHistory(this.services, opts);
  }

  /**
   * Add-only label write for a single message (Story 7.2). Resolves predicted label names
   * through the account's cached name → id map, reads the message's current `labelIds`, and
   * POSTs `addLabelIds` with only the missing ids. A 401 is force-refreshed once and the whole
   * operation replayed; a per-message 404 is logged as a warning and swallowed so one moved
   * message cannot fail a batch.
   */
  async writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void> {
    return writeLabels(this.services, accountId, messageId, labels);
  }
}
