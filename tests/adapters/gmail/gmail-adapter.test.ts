import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaxonomy } from "../../../src/adapters/config/taxonomy.js";
import { GmailAdapter, GmailAdapterError, type GmailAdapterDeps } from "../../../src/adapters/gmail/GmailAdapter.js";
import { GmailAuthError, type FetchResponseLike } from "../../../src/adapters/gmail/GmailAuthAdapter.js";
import type { LabelDef } from "../../../src/core/dto/LabelDef.js";
import type { TokenSet } from "../../../src/core/dto/TokenSet.js";

const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";

const ACCESS_TOKEN: TokenSet = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 9_999_999_999,
  scopes: ["gmail.readonly", "gmail.labels", "gmail.modify"],
};

const LABELS: LabelDef[] = [
  { name: "Action Needed", description: "Needs a response.", m365Color: "preset0", gmailColor: "#E67C73" },
  { name: "Family/Friends", description: "Personal mail.", m365Color: "preset6", gmailColor: "#F9A8D4" },
  { name: "Real-estate", description: "Property mail.", m365Color: "preset10", gmailColor: "#A3A3A3" },
];

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  /** The verbatim request body — the batch POST is `multipart/mixed`, so it is never JSON-parsed. */
  rawBody: string | undefined;
  /** Every Gmail request must be bounded by an `AbortSignal`. */
  signal: boolean;
}

function jsonResponse(body: unknown, ok = true, status = 200): FetchResponseLike {
  return { ok, status, json: async () => body };
}

function scriptedFetch(responses: FetchResponseLike[]): {
  fetchFn: GmailAdapterDeps["fetchFn"];
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: GmailAdapterDeps["fetchFn"] = async (url, init) => {
    const rawBody = typeof init.body === "string" ? init.body : undefined;
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      body:
        rawBody === undefined || init.headers["content-type"] !== "application/json"
          ? undefined
          : (JSON.parse(rawBody) as Record<string, unknown>),
      rawBody,
      signal: init.signal !== undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetchFn, requests };
}

function labelList(entries: Array<{ id: string; name: string }>): FetchResponseLike {
  return jsonResponse({ labels: entries });
}

function created(id = "created"): FetchResponseLike {
  return jsonResponse({ id, name: "created" }, true, 200);
}

function tokenSource(tokens: TokenSet = ACCESS_TOKEN): {
  getAccessToken: GmailAdapterDeps["getAccessToken"];
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    getAccessToken: async (accountName) => {
      calls.push(accountName);
      return tokens;
    },
  };
}

function colorOf(request: RecordedRequest | undefined): Record<string, string> {
  return request?.body?.["color"] as Record<string, string>;
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "gmail-adapter-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
});

test("creates one POST per taxonomy label with its name (HAPPY)", async () => {
  const labels = await loadTaxonomy({ configDir });
  expect(labels).toHaveLength(11);
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([]),
    ...labels.map((label, index) => created(`id-${index}`)),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken });

  await adapter.ensureCategories("personal", labels);

  expect(requests).toHaveLength(12);
  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.url).toBe(LABELS_URL);
  expect(requests[0]?.headers.authorization).toBe("Bearer access-1");
  // A Gmail GET must carry no body at all, even though the auth adapter types one.
  expect(requests[0]?.body).toBeUndefined();
  // Every request is bounded, so a stalled connection cannot hang the sync.
  expect(requests.every((request) => request.signal)).toBe(true);
  const posts = requests.slice(1);
  expect(posts.map((request) => request.method)).toEqual(labels.map(() => "POST"));
  expect(posts.map((request) => request.body?.["name"])).toEqual(labels.map((label) => label.name));
  expect(posts[0]?.body).toEqual({
    name: "Action Needed",
    color: { backgroundColor: "#e07798", textColor: "#000000" },
  });
  expect(posts[0]?.headers["content-type"]).toBe("application/json");
  expect(token.calls).toEqual(["personal"]);
});

test("re-running against an already-synced account creates nothing (IDEMPOTENT)", async () => {
  const { fetchFn, requests } = scriptedFetch([labelList(LABELS.map((label) => ({ id: label.name, name: label.name })))]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", LABELS);

  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("GET");
});

test("creates only the absent labels and leaves the existing ones alone (PARTIAL)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    labelList([
      { id: "Label_1", name: "Action Needed" },
      { id: "Label_2", name: "Family/Friends" },
    ]),
    created("Label_3"),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", LABELS);

  const posts = requests.slice(1);
  expect(posts.map((request) => request.body?.["name"])).toEqual(["Real-estate"]);
  expect(posts.map((request) => colorOf(request)["backgroundColor"])).toEqual(["#999999"]);
});

test("caches every name → id, taken from the list and the create responses (CACHE)", async () => {
  const labels = await loadTaxonomy({ configDir });
  const existing = ["Action Needed", "Crypto", "Promos"];
  const { fetchFn } = scriptedFetch([
    labelList(existing.map((name, index) => ({ id: `existing-${index}`, name }))),
    ...labels
      .filter((label) => !existing.includes(label.name))
      .map((label) => created(`created-${label.name}`)),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  expect(adapter.labelIdsFor("personal")).toBeUndefined();
  await adapter.ensureCategories("personal", labels);

  const ids = adapter.labelIdsFor("personal");
  expect(ids?.size).toBe(11);
  expect([...(ids ?? new Map()).keys()]).toEqual(labels.map((label) => label.name));
  expect(ids?.get("Action Needed")).toBe("existing-0");
  expect(ids?.get("Crypto")).toBe("existing-1");
  expect(ids?.get("Promos")).toBe("existing-2");
  expect(ids?.get("Real-estate")).toBe("created-Real-estate");
});

test("keeps a separate cache per account (ISOLATION)", async () => {
  const { fetchFn } = scriptedFetch([labelList([]), created("id-work"), labelList([]), created("id-home")]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });
  const label = LABELS[0] as LabelDef;

  await adapter.ensureCategories("work", [label]);
  await adapter.ensureCategories("home", [label]);

  expect(adapter.labelIdsFor("work")?.get("Action Needed")).toBe("id-work");
  expect(adapter.labelIdsFor("home")?.get("Action Needed")).toBe("id-home");
});

test("creates slashed names verbatim, without a parent label (SLASH_NAME)", async () => {
  const labels = (await loadTaxonomy({ configDir })).filter((label) => label.name.includes("/"));
  expect(labels.map((label) => label.name)).toEqual(["Waiting/Follow-up", "Family/Friends"]);
  const { fetchFn, requests } = scriptedFetch([labelList([]), created("Label_9"), created("Label_10")]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", labels);

  const posts = requests.slice(1);
  expect(posts.map((request) => request.body?.["name"])).toEqual(["Waiting/Follow-up", "Family/Friends"]);
});

test("sends the nearest allowed colour plus a contrasting allowed text colour (COLOUR)", async () => {
  const { fetchFn, requests } = scriptedFetch([labelList([]), created()]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", [LABELS[0] as LabelDef]);

  // #E67C73 is not in Gmail's palette; #e07798 is the closest allowed background, and
  // #000000 the allowed text colour that contrasts with it.
  expect(colorOf(requests[1])).toEqual({ backgroundColor: "#e07798", textColor: "#000000" });
});

test("matches the label name exactly and case-sensitively", async () => {
  const { fetchFn, requests } = scriptedFetch([labelList([{ id: "Label_1", name: "action needed" }]), created()]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", [LABELS[0] as LabelDef]);

  expect(requests).toHaveLength(2);
  expect(requests[1]?.body?.["name"]).toBe("Action Needed");
});

test("the same name given twice is created only once", async () => {
  const label = LABELS[0] as LabelDef;
  const { fetchFn, requests } = scriptedFetch([labelList([]), created()]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", [label, label]);

  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("a non-2xx list response is a typed error naming the account and status (API_ERROR)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ error: { code: 403, message: "SECRET-PAYLOAD" } }, false, 403),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("personal", LABELS).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("LIST_LABELS_FAILED");
  expect(error.accountId).toBe("personal");
  expect(error.status).toBe(403);
  expect(error.message).toContain('account "personal"');
  expect(error.message).toContain("403");
  expect(error.message).not.toContain("SECRET-PAYLOAD");
  expect(requests).toHaveLength(1);
});

test("a non-2xx create is a typed error naming the label and status, with the existing labels intact (API_ERROR)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "Label_1", name: "Action Needed" }]),
    jsonResponse({ error: { message: "SECRET-PAYLOAD" } }, false, 500),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("personal", LABELS).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("CREATE_LABEL_FAILED");
  expect(error.status).toBe(500);
  expect(error.message).toContain('"Family/Friends"');
  expect(error.message).not.toContain("SECRET-PAYLOAD");
  expect(requests).toHaveLength(2);
});

test("a throttled create surfaces as a typed error with no retry (THROTTLED)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    labelList([]),
    jsonResponse({ error: { message: "SECRET-PAYLOAD" } }, false, 429),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("personal", [LABELS[0] as LabelDef]).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("CREATE_LABEL_FAILED");
  expect(error.status).toBe(429);
  expect(requests).toHaveLength(2);
});

test("a list response without a label list is a typed error, never a mass-create", async () => {
  const { fetchFn, requests } = scriptedFetch([jsonResponse({})]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("personal", LABELS).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("LIST_LABELS_FAILED");
  expect(requests).toHaveLength(1);
});

test("a created label without an id is a typed error, since the label could never be written back to", async () => {
  const { fetchFn } = scriptedFetch([labelList([]), jsonResponse({ name: "Action Needed" })]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("personal", [LABELS[0] as LabelDef]).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("CREATE_LABEL_FAILED");
  expect(error.message).toContain("no label id");
});

test("an unreachable Gmail is reported without the thrown cause (network)", async () => {
  const fetchFn: GmailAdapterDeps["fetchFn"] = async () => {
    throw new TypeError("fetch failed: connect ECONNREFUSED");
  };
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("personal", LABELS).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("LIST_LABELS_FAILED");
  expect(error.message).toBe('Gmail could not be reached for account "personal".');
});

test("the token seam's typed error propagates unchanged without any Gmail call (AUTH)", async () => {
  const authError = new GmailAuthError(
    "AUTH_REQUIRED",
    "personal",
    'No valid token for account "personal" — run `--auth gmail --account personal` to sign in.',
  );
  const { fetchFn, requests } = scriptedFetch([]);
  const adapter = new GmailAdapter({
    fetchFn,
    getAccessToken: async () => {
      throw authError;
    },
  });

  const error = await adapter.ensureCategories("personal", LABELS).catch((err: unknown) => err);

  expect(error).toBe(authError);
  expect(requests).toHaveLength(0);
});

test("a mid-loop create failure leaves the previous cache snapshot untouched (CACHE)", async () => {
  const labels = LABELS.slice(0, 2);
  const { fetchFn } = scriptedFetch([
    // First run: both labels created, so the cache holds a complete snapshot.
    labelList([]),
    created("id-1"),
    created("id-2"),
    // Second run: the first label already exists, the second create fails.
    labelList([{ id: "id-1", name: "Action Needed" }]),
    jsonResponse({}, false, 500),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", labels);
  expect(adapter.labelIdsFor("personal")?.get("Family/Friends")).toBe("id-2");

  const error = await adapter.ensureCategories("personal", labels).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(GmailAdapterError);
  // The run never completed, so the last complete snapshot is what remains.
  const ids = adapter.labelIdsFor("personal");
  expect(ids?.size).toBe(2);
  expect(ids?.get("Family/Friends")).toBe("id-2");
});

const MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
const BATCH_BOUNDARY = "email_classify_batch";

/** Gmail's `messages.list` page: ids, optionally linked to the next page. */
function messageListPage(ids: string[], nextPageToken?: string): FetchResponseLike {
  return jsonResponse({
    messages: ids.map((id) => ({ id })),
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  });
}

/** One `format=metadata` detail as the batch parser sees it. */
function gmailDetail(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    threadId: id,
    internetMessageId: `<${id}@example.com>`,
    labelIds: ["INBOX"],
    snippet: `Preview ${id}`,
    internalDate: "1759999999000",
    payload: {
      headers: [
        { name: "From", value: `Sender ${id} <${id}@example.com>` },
        { name: "Subject", value: `Subject ${id}` },
      ],
    },
    ...overrides,
  };
}

/** A `multipart/mixed` response, which is what the adapter's `fetchFn` seam must model for the batch POST. */
interface MultipartTestResponse extends FetchResponseLike {
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** A `multipart/mixed` batch response with one embedded HTTP response per part. */
function batchResponse(
  parts: Array<{ status?: number; body?: unknown }>,
  boundary = "batch_abc",
): MultipartTestResponse {
  const chunks = parts.map(
    (part) =>
      `--${boundary}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <response-message-1>\r\n` +
      `\r\n` +
      `HTTP/1.1 ${part.status ?? 200} OK\r\n` +
      `Content-Type: application/json\r\n` +
      `\r\n` +
      `${part.body === undefined ? "" : JSON.stringify(part.body)}\r\n\r\n`,
  );
  chunks.push(`--${boundary}--\r\n`);
  const text = chunks.join("");
  return {
    ok: true,
    status: 200,
    headers: { get: () => `multipart/mixed; boundary="${boundary}"` },
    json: async () => ({}),
    text: async () => text,
  };
}

test("lists one page and hydrates it through one batch POST (HAPPY, BATCH_GET)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1", "m2"]),
    batchResponse([{ body: gmailDetail("m1") }, { body: gmailDetail("m2") }]),
  ]);
  const token = tokenSource();
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
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
    "GET /gmail/v1/users/me/messages/m1?format=metadata&metadataHeaders=From,Subject",
  );
  expect(requests[1]?.rawBody).toContain(
    "GET /gmail/v1/users/me/messages/m2?format=metadata&metadataHeaders=From,Subject",
  );
  // The exact multipart frame: a delimiter line, an application/http part with a Content-ID, and a
  // request line carrying HTTP/1.1 — a frame Gmail would reject must fail this assertion.
  expect(requests[1]?.rawBody).toBe(
    `--${BATCH_BOUNDARY}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <message-1>\r\n` +
      `\r\n` +
      `GET /gmail/v1/users/me/messages/m1?format=metadata&metadataHeaders=From,Subject HTTP/1.1\r\n` +
      `\r\n` +
      `--${BATCH_BOUNDARY}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <message-2>\r\n` +
      `\r\n` +
      `GET /gmail/v1/users/me/messages/m2?format=metadata&metadataHeaders=From,Subject HTTP/1.1\r\n` +
      `\r\n` +
      `--${BATCH_BOUNDARY}--\r\n`,
  );
  expect(token.calls).toEqual(["personal"]);
});

test("scopes the list to the configured label instead of INBOX (LABEL)", async () => {
  const { fetchFn, requests } = scriptedFetch([messageListPage([])]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.fetchMessages({ source: "gmail", accountId: "personal", folder: "Label_5" });

  expect(requests[0]?.url).toBe(`${MESSAGES_URL}?labelIds=Label_5&maxResults=50`);
});

test("percent-encodes the configured label and the page token (LABEL)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1"], "A B/2"),
    batchResponse([{ body: gmailDetail("m1") }], "batch_1"),
    messageListPage([]),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.fetchMessages({ source: "gmail", accountId: "personal", folder: "Family/Friends" });

  const listGets = requests.filter((request) => request.method === "GET");
  expect(listGets[0]?.url).toBe(`${MESSAGES_URL}?labelIds=Family%2FFriends&maxResults=50`);
  expect(listGets[1]?.url).toBe(`${MESSAGES_URL}?labelIds=Family%2FFriends&maxResults=50&pageToken=A%20B%2F2`);
});

test("a repeated page token is a typed error, never unbounded paging (MALFORMED)", async () => {
  const { fetchFn } = scriptedFetch([messageListPage([], "PAGE_2"), messageListPage([], "PAGE_2")]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
});

test("correlates response parts by Content-ID, so a reordered batch cannot swap ids (BATCH_GET)", async () => {
  const boundary = "batch_abc";
  const part = (n: number, body: unknown): string =>
    `--${boundary}\r\n` +
    `Content-Type: application/http\r\n` +
    `Content-ID: <message-${n}>\r\n` +
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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  // The parts arrive reversed; the Content-ID still maps each DTO to its own id.
  expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
});

const batchSizeCases: Array<[number, string]> = [
  [100, "100"],
  [250, "100"],
  [0, "1"],
];

test.each(batchSizeCases)("clamps batchSize %i to maxResults=%s (BATCH_SIZE)", async (batchSize, maxResults) => {
  const { fetchFn, requests } = scriptedFetch([messageListPage([])]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.fetchMessages({ source: "gmail", accountId: "personal", batchSize });

  expect(requests[0]?.url).toBe(`${MESSAGES_URL}?labelIds=INBOX&maxResults=${maxResults}`);
});

test("bounds each detail batch by the clamped batchSize (BATCH_SIZE)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    messageListPage(["m1", "m2", "m3"]),
    batchResponse([{ body: gmailDetail("m1") }, { body: gmailDetail("m2") }], "batch_1"),
    batchResponse([{ body: gmailDetail("m3") }], "batch_2"),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  const listGets = requests.filter((request) => request.method === "GET");
  expect(listGets).toHaveLength(2);
  expect(listGets[0]?.url).toBe(`${MESSAGES_URL}?labelIds=INBOX&maxResults=50`);
  expect(listGets[1]?.url).toBe(`${MESSAGES_URL}?labelIds=INBOX&maxResults=50&pageToken=PAGE_2`);
});

test("the token seam's rejection fails the fetch with no Gmail call (AUTH)", async () => {
  const authError = new GmailAuthError(
    "AUTH_REQUIRED",
    "personal",
    'No valid token for account "personal" — run `--auth gmail --account personal` to sign in.',
  );
  const { fetchFn, requests } = scriptedFetch([]);
  const adapter = new GmailAdapter({
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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(requests).toHaveLength(1);
});

test("a 429 on a list page is a typed failure with no retry (THROTTLED)", async () => {
  const { fetchFn, requests } = scriptedFetch([jsonResponse({}, false, 429)]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(error.status).toBe(429);
  // No retry: exactly one request, the throttled one.
  expect(requests).toHaveLength(1);
});

test("a 429 on a detail batch is a typed failure with no retry (THROTTLED)", async () => {
  const { fetchFn, requests } = scriptedFetch([messageListPage(["m1"]), jsonResponse({}, false, 429)]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("BATCH_GET_MESSAGES_FAILED");
  expect(error.status).toBe(429);
  expect(requests).toHaveLength(2);
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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(error.message).toBe('Gmail could not be reached for account "personal".');
});
