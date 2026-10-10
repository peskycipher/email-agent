import type { MessageDTO } from "../../core/dto/MessageDTO.js";
import { fetchBatchParts } from "./gmailMessageFetch.js";
import {
  authorizationHeader,
  getRequest,
  historyUrl,
  readField,
  readJsonObject,
  readString,
  send,
  GmailAdapterError,
  PROFILE_URL,
  clampBatchSize,
  type GmailAdapterServices,
} from "./gmailWire.js";

/** One history walk's arguments; the orchestrator's `GmailHistoryTarget` names the same shape. */
export interface GmailHistoryOpts {
  accountId: string;
  /** The stored `lastHistoryId` the walk resumes from. */
  historyId: string;
  /** Bounds each hydration batch (Gmail's 1..100), exactly as `FetchOpts.batchSize` does. */
  batchSize?: number;
}

/**
 * A history walk's outcome: the hydrated `messagesAdded` DTOs plus the response's top-level
 * `historyId` to store — or Gmail's expired 404, a normal result the caller falls back from.
 * `skippedIds` names the added ids Gmail answered 404 for (a message purged after it was
 * added): per-message answers, never the account's failure (Story 5.4 decision EC1).
 * Structurally the orchestrator's own `GmailHistoryOutcome` (AD-10: the adapter never imports `orch`).
 */
export type GmailHistoryOutcome =
  | { kind: "ok"; messages: MessageDTO[]; historyId: string; skippedIds: string[] }
  | { kind: "expired" };

interface GmailHistoryPage {
  ids: string[];
  historyId: string;
  nextPageToken: string | undefined;
}

/** One actionable line for a history response that cannot be read — never a dropped message (Story 5.4). */
function unreadableHistoryError(accountId: string, detail: string): GmailAdapterError {
  return new GmailAdapterError(
    "LIST_HISTORY_FAILED",
    accountId,
    `Gmail returned ${detail} for account "${accountId}".`,
  );
}

/**
 * One `users.history.list` page: the `messagesAdded` ids only — `labelsAdded`/`labelsRemoved`
 * records belong to Epic 7's write-back, not to fetch (Story 5.4) — plus its top-level history id
 * and page token. A page without a history id, a `history` that is not a list, or a record
 * without an id is a typed error, never "no new mail"; an absent `history` key is an empty page,
 * which is what Gmail returns when nothing changed.
 */
function parseHistoryPage(body: Record<string, unknown> | undefined, accountId: string): GmailHistoryPage {
  const historyId = readString(body, "historyId");
  if (historyId === undefined) {
    // Without the id the cycle could not record anything, so this page is not usable.
    throw unreadableHistoryError(accountId, "a history response without a history id");
  }
  const records = readField(body, "history");
  const ids: string[] = [];
  if (records !== undefined) {
    if (!Array.isArray(records)) {
      throw unreadableHistoryError(accountId, 'a history response whose "history" is not a list');
    }
    for (const record of records) {
      if (readString(record, "id") === undefined) {
        throw unreadableHistoryError(accountId, "a history record without an id");
      }
      const added = readField(record, "messagesAdded");
      if (added === undefined) continue;
      if (!Array.isArray(added)) {
        throw unreadableHistoryError(accountId, 'a history record whose "messagesAdded" is not a list');
      }
      for (const entry of added) {
        const id = readString(readField(entry, "message"), "id");
        if (id === undefined) {
          // An added message without an id cannot be hydrated; skipping it would drop it silently.
          throw unreadableHistoryError(accountId, "a messagesAdded entry without a message id");
        }
        ids.push(id);
      }
    }
  }
  const rawToken = readField(body, "nextPageToken");
  if (rawToken !== undefined && (typeof rawToken !== "string" || rawToken.length === 0)) {
    // A present-but-unusable token must not quietly end the walk: a truncated history walk and
    // an advanced cursor would drop the messages the unread pages carried.
    throw unreadableHistoryError(accountId, 'a history response whose "nextPageToken" is not a usable token');
  }
  return { ids, historyId, nextPageToken: typeof rawToken === "string" && rawToken.length > 0 ? rawToken : undefined };
}

/**
 * The mailbox's current `historyId` (`users.getProfile`). A list-path cycle reads it **before**
 * its walk, so the id predates everything the walk sees and a message arriving mid-cycle is
 * re-fetched next run rather than lost (Story 5.4).
 */
export async function fetchHistoryId(services: GmailAdapterServices, accountId: string): Promise<string> {
  const token = (await services.getAccessToken(accountId)).accessToken;
  const response = await send(
    services.fetchFn,
    PROFILE_URL,
    getRequest(authorizationHeader(token)),
    accountId,
    "GET_PROFILE_FAILED",
  );
  if (!response.ok) {
    throw new GmailAdapterError(
      "GET_PROFILE_FAILED",
      accountId,
      `Gmail refused to read the profile for account "${accountId}" (HTTP ${response.status}).`,
      response.status,
    );
  }
  const historyId = readString(await readJsonObject(response), "historyId");
  if (historyId === undefined) {
    // Without the id this cycle could record nothing, so the profile is not usable.
    throw new GmailAdapterError(
      "GET_PROFILE_FAILED",
      accountId,
      `Gmail returned no history id for account "${accountId}".`,
    );
  }
  return historyId;
}

/**
 * Walks `users.history.list` from a stored `startHistoryId`, page by page, scoped to `INBOX`
 * (the epic's cron window), and hydrates only the `messagesAdded` ids through the same batch
 * endpoint `fetchMessages` uses. Gmail's 404 — a `startHistoryId` that has aged out — is the
 * `{ kind: "expired" }` outcome, not an error and never "no new mail"; every other non-2xx is a
 * typed error. The returned `historyId` is the response's top-level id.
 */
export async function fetchHistory(services: GmailAdapterServices, opts: GmailHistoryOpts): Promise<GmailHistoryOutcome> {
  const token = (await services.getAccessToken(opts.accountId)).accessToken;
  const batchSize = clampBatchSize(opts.batchSize);
  // A message added once can be reported on two pages; each id is hydrated exactly once.
  const ids: string[] = [];
  const seenIds = new Set<string>();
  const skippedIds: string[] = [];
  // A repeated page token would page forever; each token is followed once.
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (;;) {
    const response = await send(
      services.fetchFn,
      historyUrl(opts.historyId, pageToken),
      getRequest(authorizationHeader(token)),
      opts.accountId,
      "LIST_HISTORY_FAILED",
    );
    if (response.status === 404) {
      // Gmail's documented answer for a history id older than it keeps; a normal outcome the
      // caller falls back from — never an error and never "no new mail" (Story 5.4).
      return { kind: "expired" };
    }
    if (!response.ok) {
      throw new GmailAdapterError(
        "LIST_HISTORY_FAILED",
        opts.accountId,
        `Gmail refused to list history for account "${opts.accountId}" (HTTP ${response.status}).`,
        response.status,
      );
    }
    const page = parseHistoryPage(await readJsonObject(response), opts.accountId);
    for (const id of page.ids) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      ids.push(id);
    }
    if (page.nextPageToken === undefined) {
      // Each batch carries at most the clamped batch size; the history hydration tolerates only
      // a purged message's 404 part (EC1) — every other failure still fails the account.
      const messages: MessageDTO[] = [];
      for (let start = 0; start < ids.length; start += batchSize) {
        const batch = await fetchBatchParts(services, opts.accountId, token, ids.slice(start, start + batchSize), true);
        messages.push(...batch.messages);
        skippedIds.push(...batch.skippedIds);
      }
      return { kind: "ok", messages, historyId: page.historyId, skippedIds };
    }
    if (seenTokens.has(page.nextPageToken)) {
      throw new GmailAdapterError(
        "LIST_HISTORY_FAILED",
        opts.accountId,
        `Gmail repeated a page token for account "${opts.accountId}".`,
      );
    }
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
}

