import { expect, test } from "vitest";
import { GmailAdapter, GmailAdapterError, type GmailHistoryOutcome } from "../../../src/adapters/gmail/GmailAdapter.js";
import { type FetchResponseLike } from "../../../src/adapters/gmail/GmailAuthAdapter.js";
import {
  batchResponse,
  BATCH_URL,
  gmailDetail,
  jsonResponse,
  makeLogPort,
  MultipartTestResponse,
  scriptedFetch,
  tokenSource,
} from "./harness.js";

const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const HISTORY_URL = "https://gmail.googleapis.com/gmail/v1/users/me/history";

/** A `users.history.list` record carrying the given `messagesAdded` message ids. */
function historyRecord(id: string, added: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, messagesAdded: added.map((messageId) => ({ message: { id: messageId } })), ...extra };
}

/** A `users.history.list` page: its records (absent when nothing changed) and the mailbox's history id. */
function historyPage(historyId: string, records?: unknown[], nextPageToken?: string): FetchResponseLike {
  return jsonResponse({
    ...(records === undefined ? {} : { history: records }),
    historyId,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  });
}

/** The successful half of a history walk; a test that expects anything else fails loudly. */
function historyOk(outcome: GmailHistoryOutcome): { messages: Array<{ id: string }>; historyId: string; skippedIds: string[] } {
  if (outcome.kind !== "ok") throw new Error("expected a successful history walk");
  return outcome;
}

test("reads the mailbox's current history id from the profile (HAPPY_HISTORY)", async () => {
  const { fetchFn, requests } = scriptedFetch([jsonResponse({ emailAddress: "a@example.com", historyId: "H1" })]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  expect(await adapter.fetchHistoryId("personal")).toBe("H1");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.url).toBe(PROFILE_URL);
  expect(requests[0]?.headers.authorization).toBe("Bearer access-1");
  expect(requests[0]?.body).toBeUndefined();
  expect(requests[0]?.signal).toBe(true);
});

test("a non-2xx profile is a typed error naming the account and status (PROFILE_FAIL)", async () => {
  const { fetchFn } = scriptedFetch([jsonResponse({ error: { message: "SECRET-PAYLOAD" } }, false, 500)]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.fetchHistoryId("personal").catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("GET_PROFILE_FAILED");
  expect(error.accountId).toBe("personal");
  expect(error.status).toBe(500);
  expect(error.message).toContain('account "personal"');
  expect(error.message).toContain("500");
  expect(error.message).not.toContain("SECRET-PAYLOAD");
});

test("a profile without a history id is a typed error, never a usable cursor (PROFILE_FAIL)", async () => {
  const { fetchFn } = scriptedFetch([jsonResponse({ emailAddress: "a@example.com" })]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.fetchHistoryId("personal").catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("GET_PROFILE_FAILED");
  expect(error.message).toContain("no history id");
});

test("walks history with the encoded startHistoryId and labelId, then hydrates the added ids (HAPPY_HISTORY, ADAPTER_URLS)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    historyPage("H2", [historyRecord("rec-1", ["m1"]), historyRecord("rec-2", ["m2"])]),
    batchResponse([{ body: gmailDetail("m1") }, { body: gmailDetail("m2") }], "batch_1"),
  ]);
  const token = tokenSource();
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: token.getAccessToken });

  const outcome = await adapter.fetchHistory({ accountId: "personal", historyId: "H1/2" });

  expect(historyOk(outcome).messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  // The id to store is the response's top-level history id, and `labelId` scopes the walk to INBOX.
  expect(historyOk(outcome).historyId).toBe("H2");
  expect(historyOk(outcome).skippedIds).toEqual([]);
  expect(requests).toHaveLength(2);
  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.url).toBe(`${HISTORY_URL}?startHistoryId=H1%2F2&labelId=INBOX`);
  expect(requests[0]?.headers.authorization).toBe("Bearer access-1");
  expect(requests[0]?.body).toBeUndefined();
  expect(requests[0]?.signal).toBe(true);
  // The hydration reuses the same multipart batch the label walk uses.
  expect(requests[1]?.method).toBe("POST");
  expect(requests[1]?.url).toBe(BATCH_URL);
  expect(requests[1]?.rawBody).toContain("/messages/m1?format=metadata");
  expect(token.calls).toEqual(["personal"]);
});

test("follows nextPageToken and hydrates every page's added ids exactly once (HISTORY_PAGED)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    historyPage("H2", [historyRecord("rec-1", ["m1"])], "PAGE 2"),
    historyPage("H3", [historyRecord("rec-2", ["m1", "m2"])]),
    batchResponse([{ body: gmailDetail("m1") }, { body: gmailDetail("m2") }], "batch_1"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const outcome = await adapter.fetchHistory({ accountId: "personal", historyId: "H1" });

  // m1 is reported on both pages but hydrated once; the last page's history id is the one to store.
  expect(historyOk(outcome).messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  expect(historyOk(outcome).historyId).toBe("H3");
  const historyGets = requests.filter((request) => request.url.startsWith(HISTORY_URL));
  expect(historyGets).toHaveLength(2);
  expect(historyGets[0]?.url).toBe(`${HISTORY_URL}?startHistoryId=H1&labelId=INBOX`);
  expect(historyGets[1]?.url).toBe(`${HISTORY_URL}?startHistoryId=H1&labelId=INBOX&pageToken=PAGE%202`);
});

test("a 200 whose history key is absent is an empty page, not an error (HISTORY_EMPTY)", async () => {
  const { fetchFn, requests } = scriptedFetch([historyPage("H7")]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const outcome = await adapter.fetchHistory({ accountId: "personal", historyId: "H1" });

  expect(outcome).toEqual({ kind: "ok", messages: [], historyId: "H7", skippedIds: [] });
  // No added ids, so there is nothing to hydrate.
  expect(requests).toHaveLength(1);
});

test("a 404 is the expired outcome, never an error and never no new mail (HISTORY_EXPIRED)", async () => {
  const { fetchFn, requests } = scriptedFetch([jsonResponse({ error: { message: "SECRET-PAYLOAD" } }, false, 404)]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const outcome = await adapter.fetchHistory({ accountId: "personal", historyId: "old" });

  expect(outcome).toEqual({ kind: "expired" });
  expect(requests).toHaveLength(1);
});

test("a non-2xx history other than 404 is a typed error naming account and status (API_ERROR)", async () => {
  const { fetchFn } = scriptedFetch([jsonResponse({ error: { message: "SECRET-PAYLOAD" } }, false, 403)]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchHistory({ accountId: "personal", historyId: "H1" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("LIST_HISTORY_FAILED");
  expect(error.status).toBe(403);
  expect(error.message).toContain('account "personal"');
  expect(error.message).not.toContain("SECRET-PAYLOAD");
});

test("a history response that is not a list, or a record without an id, fails the account (HISTORY_MALFORMED)", async () => {
  const malformed = [
    jsonResponse({ history: "nope", historyId: "H2" }),
    historyPage("H2", [{ messagesAdded: [{ message: { id: "m1" } }] }]),
    historyPage("H2", [historyRecord("rec-1", ["m1"], { messagesAdded: "nope" })]),
    historyPage("H2", [{ id: "rec-1", messagesAdded: [{ message: {} }] }]),
  ];
  for (const response of malformed) {
    const { fetchFn, requests } = scriptedFetch([response]);
    const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

    const error = (await adapter
      .fetchHistory({ accountId: "personal", historyId: "H1" })
      .catch((err: unknown) => err)) as GmailAdapterError;

    expect(error).toBeInstanceOf(GmailAdapterError);
    expect(error.code).toBe("LIST_HISTORY_FAILED");
    expect(error.message).toContain('account "personal"');
    // Nothing was hydrated and nothing was recorded.
    expect(requests).toHaveLength(1);
  }
});

test("a history page without a history id fails the account, never a usable cursor (HISTORY_MALFORMED)", async () => {
  const { fetchFn } = scriptedFetch([jsonResponse({ history: [historyRecord("rec-1", ["m1"])] })]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchHistory({ accountId: "personal", historyId: "H1" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("LIST_HISTORY_FAILED");
  expect(error.message).toContain("without a history id");
});

test("hydrates only messagesAdded ids, never labelsAdded records (HISTORY)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    historyPage("H2", [
      { id: "rec-1", labelsAdded: [{ message: { id: "ignored" }, labelIds: ["Label_5"] }] },
      { id: "rec-2", labelsRemoved: [{ message: { id: "ignored" }, labelIds: ["INBOX"] }] },
      historyRecord("rec-3", ["m1"]),
    ]),
    batchResponse([{ body: gmailDetail("m1") }], "batch_1"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const outcome = await adapter.fetchHistory({ accountId: "personal", historyId: "H1" });

  expect(historyOk(outcome).messages.map((message) => message.id)).toEqual(["m1"]);
  const batches = requests.filter((request) => request.method === "POST");
  expect(batches).toHaveLength(1);
  expect(batches[0]?.rawBody).not.toContain("ignored");
});

test("bounds each history hydration batch by the clamped batchSize (BATCH_SIZE)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    historyPage("H2", [historyRecord("rec-1", ["m1", "m2", "m3"])]),
    batchResponse([{ body: gmailDetail("m1") }, { body: gmailDetail("m2") }], "batch_1"),
    batchResponse([{ body: gmailDetail("m3") }], "batch_2"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const outcome = await adapter.fetchHistory({ accountId: "personal", historyId: "H1", batchSize: 2 });

  expect(historyOk(outcome).messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(2);
});

test("a failed detail batch fails the account with the batch error (BATCH_FAIL)", async () => {
  const { fetchFn } = scriptedFetch([
    historyPage("H2", [historyRecord("rec-1", ["m1"])]),
    jsonResponse({}, false, 500),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchHistory({ accountId: "personal", historyId: "H1" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
  expect(error.status).toBe(500);
});

test("a repeated history page token is a typed error, never unbounded paging (HISTORY_MALFORMED)", async () => {
  const { fetchFn } = scriptedFetch([
    historyPage("H2", [], "PAGE_2"),
    historyPage("H2", [], "PAGE_2"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchHistory({ accountId: "personal", historyId: "H1" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("LIST_HISTORY_FAILED");
});

test("a purged message's 404 part is skipped and named, and the walk still succeeds (PART_DELETED)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    historyPage("H2", [historyRecord("rec-1", ["m1", "purged"])]),
    batchResponse([
      { body: gmailDetail("m1") },
      { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } },
    ], "batch_1"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const outcome = await adapter.fetchHistory({ accountId: "personal", historyId: "H1" });

  // The surviving message is fetched; the purged id is named, not failed and not silently dropped.
  expect(historyOk(outcome).messages.map((message) => message.id)).toEqual(["m1"]);
  expect(historyOk(outcome).skippedIds).toEqual(["purged"]);
  expect(historyOk(outcome).historyId).toBe("H2");
  expect(requests).toHaveLength(2);
});

test("a history page with an unusable nextPageToken fails the account, never a quiet truncation (HISTORY_MALFORMED)", async () => {
  for (const badToken of ["", 7]) {
    const { fetchFn, requests } = scriptedFetch([
      jsonResponse({ history: [historyRecord("rec-1", ["m1"])], historyId: "H2", nextPageToken: badToken }),
    ]);
    const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

    const error = (await adapter
      .fetchHistory({ accountId: "personal", historyId: "H1" })
      .catch((err: unknown) => err)) as GmailAdapterError;

    expect(error).toBeInstanceOf(GmailAdapterError);
    expect(error.code).toBe("LIST_HISTORY_FAILED");
    expect(error.message).toContain("not a usable token");
    expect(requests).toHaveLength(1);
  }
});

test("a 404 part without a Content-ID is malformed, never an absorbable skip (HISTORY, PART_DELETED)", async () => {
  const boundary = "batch_abc";
  const text =
    `--${boundary}\r\nContent-Type: application/http\r\n\r\n` +
    `HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{}\r\n\r\n` +
    `--${boundary}--\r\n`;
  const response: MultipartTestResponse = {
    ok: true,
    status: 200,
    headers: { get: () => `multipart/mixed; boundary="${boundary}"` },
    json: async () => ({}),
    text: async () => text,
  };
  const { fetchFn, requests } = scriptedFetch([
    historyPage("H2", [historyRecord("rec-1", ["m1"])]),
    response,
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchHistory({ accountId: "personal", historyId: "H1" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  // The nameless 404 cannot prove which id it answers, so the cycle fails loudly instead of
  // skipping a possibly-wrong id.
  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
  expect(error.status).toBe(404);
  expect(requests).toHaveLength(2);
});
