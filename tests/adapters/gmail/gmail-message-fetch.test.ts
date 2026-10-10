import { expect, test } from "vitest";
import { GmailAdapter, GmailAdapterError, type GmailAdapterDeps } from "../../../src/adapters/gmail/GmailAdapter.js";
import { GmailAuthError, type FetchResponseLike } from "../../../src/adapters/gmail/GmailAuthAdapter.js";
import {
  batchResponse,
  BATCH_BOUNDARY,
  gmailDetail,
  jsonResponse,
  makeLogPort,
  MultipartTestResponse,
  scriptedFetch,
  tokenSource,
} from "./harness.js";

const MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
/** Gmail's `messages.list` page: ids, optionally linked to the next page. */
function messageListPage(ids: string[], nextPageToken?: string): FetchResponseLike {
  return jsonResponse({
    messages: ids.map((id) => ({ id })),
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  });
}

test("a `since` lower bound becomes Gmail's `after:` filter, stepped back one second (BOUND)", async () => {
  const { fetchFn, requests } = scriptedFetch([messageListPage([])]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.fetchMessages({ source: "gmail", accountId: "personal", since: new Date("2026-10-08T08:00:00.000Z") });

  // 2026-10-08T08:00:00Z is epoch 1791446400; `after:` is exclusive, so the bound steps back to
  // 1791446399 — the message sitting exactly on the recorded instant is never dropped.
  expect(requests[0]?.url).toBe(`${MESSAGES_URL}?labelIds=INBOX&maxResults=50&q=after%3A1791446399`);
});

test("a list walk without a `since` carries no time filter, unchanged from Story 5.3 (BOUND)", async () => {
  const { fetchFn, requests } = scriptedFetch([messageListPage([])]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(requests[0]?.url).toBe(`${MESSAGES_URL}?labelIds=INBOX&maxResults=50`);
});


test("lists one page and hydrates it through one batch POST (HAPPY, BATCH_GET)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1", "m2"]),
    batchResponse([{ body: gmailDetail("m1") }, { body: gmailDetail("m2") }]),
  ]);
  const token = tokenSource();
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: token.getAccessToken });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  // Every fetched message carries a distinct, non-empty identity — the header the batch request
  // asked for, which is what Story 8.2's pre-classify lookup keys on.
  expect(messages.map((message) => message.internetMessageId)).toEqual(["<m1@example.com>", "<m2@example.com>"]);
  expect(requests).toHaveLength(2);
  // The list GET scopes to INBOX, caps at the default 50, is Bearer-bound and bounded.
  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.url).toBe(`${MESSAGES_URL}?labelIds=INBOX&maxResults=50`);
  expect(requests[0]?.headers.authorization).toBe("Bearer access-1");
  expect(requests[0]?.body).toBeUndefined();
  expect(requests[0]?.signal).toBe(true);
  // One multipart batch POST carries a metadata GET per id.
  expect(requests[1]?.method).toBe("POST");
  expect(requests[1]?.url).toBe(BATCH_URL);
  expect(requests[1]?.headers["content-type"]).toBe(`multipart/mixed; boundary=${BATCH_BOUNDARY}`);
  expect(requests[1]?.rawBody).toContain(
    "GET /gmail/v1/users/me/messages/m1?format=metadata&metadataHeaders=From,Subject,Message-ID",
  );
  expect(requests[1]?.rawBody).toContain(
    "GET /gmail/v1/users/me/messages/m2?format=metadata&metadataHeaders=From,Subject,Message-ID",
  );
  // The exact multipart frame: a delimiter line, an application/http part with a Content-ID, and a
  // request line carrying HTTP/1.1 — a frame Gmail would reject must fail this assertion.
  expect(requests[1]?.rawBody).toBe(
    `--${BATCH_BOUNDARY}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <message-1>\r\n` +
      `\r\n` +
      `GET /gmail/v1/users/me/messages/m1?format=metadata&metadataHeaders=From,Subject,Message-ID HTTP/1.1\r\n` +
      `\r\n` +
      `--${BATCH_BOUNDARY}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <message-2>\r\n` +
      `\r\n` +
      `GET /gmail/v1/users/me/messages/m2?format=metadata&metadataHeaders=From,Subject,Message-ID HTTP/1.1\r\n` +
      `\r\n` +
      `--${BATCH_BOUNDARY}--\r\n`,
  );
  expect(token.calls).toEqual(["personal"]);
});

test("scopes the list to the configured label instead of INBOX (LABEL)", async () => {
  const { fetchFn, requests } = scriptedFetch([messageListPage([])]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.fetchMessages({ source: "gmail", accountId: "personal", folder: "Label_5" });

  expect(requests[0]?.url).toBe(`${MESSAGES_URL}?labelIds=Label_5&maxResults=50`);
});

test("percent-encodes the configured label and the page token (LABEL)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1"], "A B/2"),
    batchResponse([{ body: gmailDetail("m1") }], "batch_1"),
    messageListPage([]),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.fetchMessages({ source: "gmail", accountId: "personal", folder: "Family/Friends" });

  const listGets = requests.filter((request) => request.method === "GET");
  expect(listGets[0]?.url).toBe(`${MESSAGES_URL}?labelIds=Family%2FFriends&maxResults=50`);
  expect(listGets[1]?.url).toBe(`${MESSAGES_URL}?labelIds=Family%2FFriends&maxResults=50&pageToken=A%20B%2F2`);
});

test("a repeated page token is a typed error, never unbounded paging (MALFORMED)", async () => {
  const { fetchFn } = scriptedFetch([messageListPage([], "PAGE_2"), messageListPage([], "PAGE_2")]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("LIST_MESSAGES_FAILED");
});

test("a 2xx batch part without a message id is a typed error, never an empty DTO (BATCH_MALFORMED)", async () => {
  const { fetchFn } = scriptedFetch([
    messageListPage(["m1"]),
    batchResponse([{ body: { snippet: "no id here" } }], "batch_1"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
});

test("correlates response parts by Content-ID, so a reordered batch cannot swap ids (BATCH_GET)", async () => {
  for (const prefix of ["", "response-"]) {
    const boundary = "batch_abc";
    const part = (n: number, body: unknown): string =>
      `--${boundary}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <${prefix}message-${n}>\r\n` +
      `\r\n` +
      `HTTP/1.1 200 OK\r\n` +
      `Content-Type: application/json\r\n` +
      `\r\n` +
      `${JSON.stringify(body)}\r\n\r\n`;
    const text = `${part(2, gmailDetail("m2"))}${part(1, gmailDetail("m1"))}--${boundary}--\r\n`;
    const response: MultipartTestResponse = {
      ok: true,
      status: 200,
      headers: { get: () => `multipart/mixed; boundary="${boundary}"` },
      json: async () => ({}),
      text: async () => text,
    };
    const { fetchFn } = scriptedFetch([messageListPage(["m1", "m2"]), response]);
    const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

    // The parts arrive reversed; the Content-ID still maps each DTO to its own id — in both
    // Google's documented `<response-message-N>` echo and the request-echo form.
    const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

    expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  }
});

const batchSizeCases: Array<[number, string]> = [
  [100, "100"],
  [250, "100"],
  [0, "1"],
];

test.each(batchSizeCases)("clamps batchSize %i to maxResults=%s (BATCH_SIZE)", async (batchSize, maxResults) => {
  const { fetchFn, requests } = scriptedFetch([messageListPage([])]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.fetchMessages({ source: "gmail", accountId: "personal", batchSize });

  expect(requests[0]?.url).toBe(`${MESSAGES_URL}?labelIds=INBOX&maxResults=${maxResults}`);
});

test("bounds each detail batch by the clamped batchSize (BATCH_SIZE)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1", "m2", "m3"]),
    batchResponse([{ body: gmailDetail("m1") }, { body: gmailDetail("m2") }], "batch_1"),
    batchResponse([{ body: gmailDetail("m3") }], "batch_2"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal", batchSize: 2 });

  expect(messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
  const batches = requests.filter((request) => request.method === "POST");
  expect(batches).toHaveLength(2);
  expect(batches[0]?.rawBody).toContain("/messages/m1?");
  expect(batches[0]?.rawBody).not.toContain("/messages/m3?");
  expect(batches[1]?.rawBody).toContain("/messages/m3?");
});

test("follows nextPageToken and hydrates every page's ids exactly once (PAGED)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1"], "PAGE_2"),
    batchResponse([{ body: gmailDetail("m1") }], "batch_1"),
    messageListPage(["m2"]),
    batchResponse([{ body: gmailDetail("m2") }], "batch_2"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  const listGets = requests.filter((request) => request.method === "GET");
  expect(listGets).toHaveLength(2);
  expect(listGets[0]?.url).toBe(`${MESSAGES_URL}?labelIds=INBOX&maxResults=50`);
  expect(listGets[1]?.url).toBe(`${MESSAGES_URL}?labelIds=INBOX&maxResults=50&pageToken=PAGE_2`);
});

test("an id repeated across pages is hydrated exactly once (PAGED)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1"], "PAGE_2"),
    batchResponse([{ body: gmailDetail("m1") }], "batch_1"),
    messageListPage(["m1", "m2"]),
    batchResponse([{ body: gmailDetail("m2") }], "batch_2"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  // Mail arriving mid-backfill can put one message on two pages; it is hydrated exactly once.
  expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(2);
});

test("a message already returned for the account is not returned by a second label walk (LABEL)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1"]),
    batchResponse([{ body: gmailDetail("m1") }], "batch_1"),
    messageListPage(["m1", "m2"]),
    batchResponse([{ body: gmailDetail("m2") }], "batch_2"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const first = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });
  // Gmail labels overlap by design: m1 is listed again under Label_5.
  const second = await adapter.fetchMessages({ source: "gmail", accountId: "personal", folder: "Label_5" });

  expect(first.map((message) => message.id)).toEqual(["m1"]);
  // The second walk returns only the message the first did not — no duplicate DTO, no double count.
  expect(second.map((message) => message.id)).toEqual(["m2"]);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(2);
});

test("a list entry without an id fails the account, never a silent drop (LIST_MALFORMED)", async () => {
  const { fetchFn } = scriptedFetch([jsonResponse({ messages: [{}] })]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(error.message).toContain("without an id");
});

test("a present-but-malformed page token fails the account, never a quiet truncated finish (PAGED)", async () => {
  for (const badToken of ["", 7]) {
    const { fetchFn, requests } = scriptedFetch([
      jsonResponse({ messages: [{ id: "m1" }], nextPageToken: badToken }),
      batchResponse([{ body: gmailDetail("m1") }], "batch_1"),
    ]);
    const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

    const error = (await adapter
      .fetchMessages({ source: "gmail", accountId: "personal" })
      .catch((err: unknown) => err)) as GmailAdapterError;

    expect(error).toBeInstanceOf(GmailAdapterError);
    expect(error.code).toBe("LIST_MESSAGES_FAILED");
    expect(error.message).toContain("malformed page token");
    // The page's one list GET and its batch went out; the unusable token was never followed.
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(1);
  }
});

test("the token seam's rejection fails the fetch with no Gmail call (AUTH)", async () => {
  const authError = new GmailAuthError(
    "AUTH_REQUIRED",
    "personal",
    'No valid token for account "personal" — run `--auth gmail --account personal` to sign in.',
  );
  const { fetchFn, requests } = scriptedFetch([]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(),
    fetchFn,
    getAccessToken: async () => {
      throw authError;
    },
  });

  const error = await adapter.fetchMessages({ source: "gmail", accountId: "personal" }).catch((err: unknown) => err);

  expect(error).toBe(authError);
  expect(requests).toHaveLength(0);
});

test("a 403 on the list is a typed error naming account and status (API_ERROR)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ error: { code: 403, message: "SECRET-PAYLOAD" } }, false, 403),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(error.accountId).toBe("personal");
  expect(error.status).toBe(403);
  expect(error.message).toContain('account "personal"');
  expect(error.message).toContain("403");
  expect(error.message).not.toContain("SECRET-PAYLOAD");
  expect(requests).toHaveLength(1);
});

test("a 500 on the second page rejects the whole fetch, never a partial array (MID_PAGE_ERROR)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1"], "PAGE_2"),
    batchResponse([{ body: gmailDetail("m1") }], "batch_1"),
    jsonResponse({}, false, 500),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(error.status).toBe(500);
  expect(requests).toHaveLength(3);
});

test("a 200 without a messages array is a typed error, never an empty result (MALFORMED)", async () => {
  const { fetchFn, requests } = scriptedFetch([jsonResponse({ resultSizeEstimate: 0 })]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(requests).toHaveLength(1);
});

test("a 503 on a list page is a typed failure with the ladder untouched (FLAT_KEEP)", async () => {
  const { fetchFn, requests } = scriptedFetch([jsonResponse({}, false, 503)]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(error.status).toBe(503);
  // No retry: exactly one request, the failed one.
  expect(requests).toHaveLength(1);
});

test("a 503 on a detail batch is a typed failure with the ladder untouched (FLAT_KEEP)", async () => {
  const { fetchFn, requests } = scriptedFetch([messageListPage(["m1"]), jsonResponse({}, false, 503)]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
  expect(error.status).toBe(503);
  expect(requests).toHaveLength(2);
});

test("a throttled part inside a 200 batch re-issues the batch through the ladder (PART_THROTTLED)", async () => {
  const sleeps: number[] = [];
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1"]),
    batchResponse([{ status: 429, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } }]),
    batchResponse([{ body: gmailDetail("m1") }]),
  ]);
  const adapter = new GmailAdapter({
    logPort: makeLogPort(),
    fetchFn,
    getAccessToken: tokenSource().getAccessToken,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(messages.map((message) => message.id)).toEqual(["m1"]);
  expect(sleeps).toEqual([2_000]);
  expect(requests).toHaveLength(3);
});

test("five throttled parts exhaust the ladder and give up with a typed RATE_LIMIT_GAVE_UP (PART_GIVE_UP)", async () => {
  const sleeps: number[] = [];
  const throttledPart = { status: 429, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } };
  const { fetchFn } = scriptedFetch([
    messageListPage(["m1"]),
    ...Array.from({ length: 6 }, () => batchResponse([throttledPart])),
  ]);
  const adapter = new GmailAdapter({
    logPort: makeLogPort(),
    fetchFn,
    getAccessToken: tokenSource().getAccessToken,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("RATE_LIMIT_GAVE_UP");
  expect(error.status).toBe(429);
  expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
});

test("a batch whose body has no parseable parts fails the account (BATCH_MALFORMED)", async () => {
  const unreadable: MultipartTestResponse = {
    ok: true,
    status: 200,
    headers: { get: () => 'multipart/mixed; boundary="batch_abc"' },
    json: async () => ({}),
    text: async () => "this is not multipart\r\n",
  };
  const { fetchFn, requests } = scriptedFetch([messageListPage(["m1", "m2"]), unreadable]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
  expect(error.message).toContain('account "personal"');
  expect(requests).toHaveLength(2);
});

test("a batch response without a multipart content-type fails the account (BATCH_MALFORMED)", async () => {
  const notMultipart: MultipartTestResponse = {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({}),
    text: async () => "{}",
  };
  const { fetchFn } = scriptedFetch([messageListPage(["m1"]), notMultipart]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
});

test("a batch part that is not an embedded HTTP response fails the account (BATCH_MALFORMED)", async () => {
  const boundary = "batch_abc";
  const garbage = `--${boundary}\r\nContent-Type: application/http\r\n\r\nnot-http\r\n--${boundary}--\r\n`;
  const malformed: MultipartTestResponse = {
    ok: true,
    status: 200,
    headers: { get: () => `multipart/mixed; boundary="${boundary}"` },
    json: async () => ({}),
    text: async () => garbage,
  };
  const { fetchFn } = scriptedFetch([messageListPage(["m1"]), malformed]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
});

test("a batch part with a non-2xx status names the status without the payload (BATCH_GET)", async () => {
  const { fetchFn } = scriptedFetch([
    messageListPage(["m1"]),
    batchResponse([{ status: 403, body: { error: { message: "SECRET-PAYLOAD" } } }]),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
  expect(error.status).toBe(403);
  expect(error.message).toContain("403");
  expect(error.message).not.toContain("SECRET-PAYLOAD");
});

test("an unreachable Gmail is a typed error without the thrown cause (network)", async () => {
  const fetchFn: GmailAdapterDeps["fetchFn"] = async () => {
    throw new TypeError("fetch failed: connect ECONNREFUSED");
  };
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(error.message).toBe('Gmail could not be reached for account "personal".');
});

test("on the label-list path a 404 part still fails the account — the tolerance is history-only (EC1)", async () => {
  const { fetchFn } = scriptedFetch([
    messageListPage(["m1"]),
    batchResponse([{ status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } }], "batch_1"),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
  expect(error.status).toBe(404);
});

