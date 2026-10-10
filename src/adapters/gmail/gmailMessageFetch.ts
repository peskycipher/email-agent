import type { FetchOpts } from "../../core/dto/FetchOpts.js";
import type { MessageDTO } from "../../core/dto/MessageDTO.js";
import { mapGmailMessage } from "./messageMapper.js";
import {
  authorizationHeader,
  batchBoundary,
  batchRequestBody,
  contentIdIndexOf,
  getRequest,
  isRateLimitBody,
  messagesListUrl,
  parseBatchPart,
  readJsonObject,
  readResponseText,
  readString,
  sendThrottled,
  splitBatchParts,
  throttleGiveUpError,
  throttlePartBackoff,
  unreadableBatchError,
  BATCH_BOUNDARY,
  BATCH_URL,
  clampBatchSize,
  GmailAdapterError,
  type FetchInit,
  type GmailAdapterServices,
  type MultipartResponseLike,
} from "./gmailWire.js";

/**
 * Walks the account's message list page by page, following `nextPageToken` until it is
 * absent, and hydrates each page's ids through the multipart batch endpoint (Story 5.3).
 * A non-2xx or malformed page, an unreadable batch, or a network failure throws a typed
 * error and returns no partial array — a truncated backfill must never look finished.
 */
export async function fetchMessages(services: GmailAdapterServices, opts: FetchOpts): Promise<MessageDTO[]> {
  const token = (await services.getAccessToken(opts.accountId)).accessToken;
  const batchSize = clampBatchSize(opts.batchSize);
  const messages: MessageDTO[] = [];
  // A message can appear on two pages while mail arrives during a long backfill; each id is hydrated once.
  const seenIds = new Set<string>();
  // And on two labels — the account-scoped set from earlier walks in this run keeps the count honest.
  let accountSeen = services.returnedIdsByAccount.get(opts.accountId);
  if (accountSeen === undefined) {
    accountSeen = new Set<string>();
    services.returnedIdsByAccount.set(opts.accountId, accountSeen);
  }
  // A repeated page token would page forever; each token is followed once.
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const response = await sendThrottled(
      services,
      messagesListUrl(opts, pageToken),
      getRequest(authorizationHeader(token)),
      opts.accountId,
      "LIST_MESSAGES_FAILED",
    );
    if (!response.ok) {
      throw new GmailAdapterError(
        "LIST_MESSAGES_FAILED",
        opts.accountId,
        `Gmail refused to list messages for account "${opts.accountId}" (HTTP ${response.status}).`,
        response.status,
      );
    }
    const body = await readJsonObject(response);
    const page = body?.messages;
    if (!Array.isArray(page)) {
      // A page without its `messages` array is an error, never "no messages" — the
      // same rule the label-list read in `gmailLabelSync` applies.
      throw new GmailAdapterError(
        "LIST_MESSAGES_FAILED",
        opts.accountId,
        `Gmail returned no message list for account "${opts.accountId}".`,
      );
    }
    const ids: string[] = [];
    for (const entry of page) {
      const id = readString(entry, "id");
      if (id === undefined) {
        // A list entry without an id cannot be hydrated; treating it as "no messages" would drop it.
        throw new GmailAdapterError(
          "LIST_MESSAGES_FAILED",
          opts.accountId,
          `Gmail listed a message without an id for account "${opts.accountId}".`,
        );
      }
      if (seenIds.has(id) || accountSeen.has(id)) continue;
      seenIds.add(id);
      ids.push(id);
    }
    for (let start = 0; start < ids.length; start += batchSize) {
      // Each batch carries at most the clamped batch size; a failure in any batch fails the
      // account. The label-list path never tolerates a 404 part — that tolerance belongs only
      // to the history walk, whose ids can outlive their messages (Story 5.4, EC1).
      const { messages: batchMessages } = await fetchBatchParts(
        services,
        opts.accountId,
        token,
        ids.slice(start, start + batchSize),
        false,
      );
      messages.push(...batchMessages);
    }
    // The page's ids count as returned only once its batches succeeded.
    for (const id of ids) accountSeen.add(id);
    const rawToken = body?.nextPageToken;
    pageToken = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : undefined;
    if (rawToken !== undefined && pageToken === undefined) {
      // A present-but-unusable token must not quietly end the walk: a truncated backfill
      // may never look complete (the frozen partial-walk rule, kept from Story 5.3).
      throw new GmailAdapterError(
        "LIST_MESSAGES_FAILED",
        opts.accountId,
        `Gmail returned a malformed page token for account "${opts.accountId}".`,
      );
    }
    if (pageToken !== undefined) {
      if (seenTokens.has(pageToken)) {
        throw new GmailAdapterError(
          "LIST_MESSAGES_FAILED",
          opts.accountId,
          `Gmail repeated a page token for account "${opts.accountId}".`,
        );
      }
      seenTokens.add(pageToken);
    }
  } while (pageToken !== undefined);
  return messages;
}

/**
 * The batch parser and mapper, shared by the label walk's `fetchMessages` and the history walk's
 * hydration. A part that answers 404 is a purged message's answer (Story 5.4 decision EC1):
 * only in a history walk (`allowPurged`) that id is skipped and named in the outcome — failing
 * the whole cycle instead would re-fail every run until history expiry — while a POST-level
 * failure of any other kind, or a malformed part, still fails the account. A part that is *throttled*
 * while the envelope answers 200 (Story 9.1, RATE_LIMIT_BODY) re-issues the whole batch through the
 * ladder instead of failing, so an unattended backfill survives a mid-batch 429.
 */
export async function fetchBatchParts(
  services: GmailAdapterServices,
  accountId: string,
  token: string,
  ids: string[],
  allowPurged: boolean,
): Promise<{ messages: MessageDTO[]; skippedIds: string[] }> {
  let parts: string[] = [];
  let throttleRetries = 0;
  // Re-issue the whole batch while a part is throttled (an envelope-level 429 is already retried by
  // `sendThrottled`); the budget is the same five rungs, and exhausting it gives up typed.
  for (;;) {
    const response: MultipartResponseLike = await sendThrottled(
      services,
      BATCH_URL,
      {
        method: "POST",
        headers: {
          ...authorizationHeader(token),
          "content-type": `multipart/mixed; boundary=${BATCH_BOUNDARY}`,
        },
        body: batchRequestBody(ids),
      } as FetchInit,
      accountId,
      "BATCH_GET_MESSAGES_FAILED",
    );
    if (!response.ok) {
      throw new GmailAdapterError(
        "BATCH_GET_MESSAGES_FAILED",
        accountId,
        `Gmail refused to fetch message details for account "${accountId}" (HTTP ${response.status}).`,
        response.status,
      );
    }
    const body = await readResponseText(response);
    const boundary = batchBoundary(response.headers?.get("content-type"));
    const split = body === undefined || boundary === undefined ? undefined : splitBatchParts(body, boundary);
    if (split === undefined || split.length !== ids.length) {
      // Without one parseable part per id, some message's details would be silently dropped.
      throw unreadableBatchError(accountId);
    }
    const throttled = split
      .map((part) => parseBatchPart(part))
      .find((parsed) => parsed !== undefined && (parsed.status === 429 || isRateLimitBody(parsed.body)));
    if (throttled === undefined) {
      parts = split;
      break;
    }
    if (!(await throttlePartBackoff(services, accountId, throttleRetries))) {
      throw throttleGiveUpError("Gmail", accountId, throttled.status);
    }
    throttleRetries += 1;
  }
  const messages: Array<MessageDTO | undefined> = Array.from({ length: ids.length }, () => undefined);
  // Which ids the parts have answered for, filled or skipped: every index needs exactly one answer.
  const settled = Array.from({ length: ids.length }, () => false);
  const skippedIds: string[] = [];
  parts.forEach((part, position) => {
    const parsed = parseBatchPart(part);
    if (parsed === undefined) throw unreadableBatchError(accountId);
    if (parsed.status < 200 || parsed.status >= 300) {
      if (allowPurged && parsed.status === 404) {
        // The request names each part; only a Content-ID naming this part's own slot is a purged
        // message's answer — a nameless or duplicate 404 part is malformed, never an absorbable
        // skip. (The success path has the same settled guard.)
        const index = contentIdIndexOf(part);
        if (index !== undefined && index < ids.length && !settled[index]) {
          settled[index] = true;
          skippedIds.push(ids[index]);
          return;
        }
      }
      throw new GmailAdapterError(
        "BATCH_GET_MESSAGES_FAILED",
        accountId,
        `Gmail refused to fetch message details for account "${accountId}" (HTTP ${parsed.status}).`,
        parsed.status,
      );
    }
    // The request names each part; prefer that Content-ID so a reordered response cannot swap ids.
    const index = contentIdIndexOf(part) ?? position;
    if (index >= ids.length || settled[index]) throw unreadableBatchError(accountId);
    const message = mapGmailMessage(parsed.body, accountId);
    // A part that is not the message the request named — an empty id, or another
    // message's payload — is misattribution, never a silent swap or drop.
    if (message.id !== ids[index]) throw unreadableBatchError(accountId);
    messages[index] = message;
    settled[index] = true;
  });
  if (!settled.every((answered) => answered)) throw unreadableBatchError(accountId);
  return { messages: messages.filter((message): message is MessageDTO => message !== undefined), skippedIds };
}
