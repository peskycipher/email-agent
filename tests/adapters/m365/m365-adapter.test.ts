import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaxonomy } from "../../../src/adapters/config/taxonomy.js";
import {
  M365Adapter,
  M365AdapterError,
  type M365AdapterDeps,
} from "../../../src/adapters/m365/M365Adapter.js";
import {
  M365AuthError,
  type FetchLike,
  type FetchResponseLike,
} from "../../../src/adapters/m365/M365AuthAdapter.js";
import type { LabelDef } from "../../../src/core/dto/LabelDef.js";
import type { TokenSet } from "../../../src/core/dto/TokenSet.js";

const LISTS_URL = "https://graph.microsoft.com/v1.0/me/outlook/masterCategories";

const ACCESS_TOKEN: TokenSet = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 9_999_999_999,
  scopes: ["Mail.ReadWrite", "MailboxSettings.ReadWrite"],
};

const LABELS: LabelDef[] = [
  { name: "Action Needed", description: "Needs a response.", m365Color: "preset0", gmailColor: "#E67C73" },
  { name: "Crypto", description: "Crypto mail.", m365Color: "preset4", gmailColor: "#3ECCE9" },
  { name: "Real-estate", description: "Property mail.", m365Color: "preset10", gmailColor: "#A3A3A3" },
];

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  /** Every Graph request must be bounded by an `AbortSignal`. */
  signal: boolean;
}

function jsonResponse(body: unknown, ok = true, status = 200): FetchResponseLike {
  return { ok, status, json: async () => body };
}

function scriptedFetch(responses: FetchResponseLike[]): {
  fetchFn: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      signal: init.signal !== undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetchFn, requests };
}

function tokenSource(tokens: TokenSet = ACCESS_TOKEN): {
  getAccessToken: M365AdapterDeps["getAccessToken"];
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

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "m365-adapter-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
});

test("creates one POST per taxonomy label with its displayName and preset colour (HAPPY)", async () => {
  const labels = await loadTaxonomy({ configDir });
  expect(labels).toHaveLength(11);
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ value: [] }),
    ...labels.map(() => jsonResponse({ id: "created" }, true, 201)),
    jsonResponse({ value: labels.map((label) => ({ id: label.name, displayName: label.name })) }),
  ]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: token.getAccessToken });

  await adapter.ensureCategories("work", labels);

  expect(requests).toHaveLength(12);
  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.url).toBe(LISTS_URL);
  expect(requests[0]?.headers.authorization).toBe("Bearer access-1");
  // A Graph GET must carry no body at all, even though FetchLike types one.
  expect(requests[0]?.body).toBeUndefined();
  // Every request is bounded, so a stalled connection cannot hang the sync.
  expect(requests.every((request) => request.signal)).toBe(true);
  const posts = requests.slice(1);
  expect(posts.map((request) => request.method)).toEqual(labels.map(() => "POST"));
  expect(posts.map((request) => request.body?.["displayName"])).toEqual(labels.map((label) => label.name));
  expect(posts.map((request) => request.body?.["color"])).toEqual(labels.map((label) => label.m365Color));
  expect(posts[0]?.body).toEqual({ displayName: "Action Needed", color: "preset0" });
  expect(posts[0]?.headers["content-type"]).toBe("application/json");
  expect(token.calls).toEqual(["work"]);

  // Second run against the already-synced account: one GET, no further POSTs.
  await adapter.ensureCategories("work", labels);

  expect(requests).toHaveLength(13);
  expect(requests[12]?.method).toBe("GET");
});

test("re-running against an already-synced account creates nothing (IDEMPOTENT)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ value: LABELS.map((label) => ({ id: label.name, displayName: label.name })) }),
  ]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("work", LABELS);

  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("GET");
});

test("creates only the absent labels and leaves the existing ones alone (PARTIAL)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({
      value: [
        { id: "c1", displayName: "Action Needed", color: "preset0" },
        { id: "c2", displayName: "Crypto", color: "preset4" },
      ],
    }),
    jsonResponse({ id: "created" }, true, 201),
  ]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("work", LABELS);

  const posts = requests.slice(1);
  expect(posts.map((request) => request.body?.["displayName"])).toEqual(["Real-estate"]);
  expect(posts.map((request) => request.body?.["color"])).toEqual(["preset10"]);
});

test("follows @odata.nextLink to exhaustion before deciding what is missing (PAGED)", async () => {
  const nextLink = `${LISTS_URL}?$skiptoken=page-2`;
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ value: [{ id: "c1", displayName: "Action Needed" }], "@odata.nextLink": nextLink }),
    jsonResponse({ value: [{ id: "c2", displayName: "Crypto" }] }),
    jsonResponse({ id: "created" }, true, 201),
  ]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("work", LABELS);

  expect(requests.map((request) => request.url)).toEqual([LISTS_URL, nextLink, LISTS_URL]);
  expect(requests[1]?.method).toBe("GET");
  expect(requests[2]?.body).toEqual({ displayName: "Real-estate", color: "preset10" });
});

test("a label carrying preset12 is POSTed with that exact colour (COLOUR)", async () => {
  const label: LabelDef = {
    name: "Notifications",
    description: "Automated mail.",
    m365Color: "preset12",
    gmailColor: "#D1D5DB",
  };
  const { fetchFn, requests } = scriptedFetch([jsonResponse({ value: [] }), jsonResponse({}, true, 201)]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("work", [label]);

  expect(requests[1]?.body).toEqual({ displayName: "Notifications", color: "preset12" });
});

test("matches displayName exactly and case-sensitively", async () => {
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ value: [{ id: "c1", displayName: "action needed" }] }),
    jsonResponse({}, true, 201),
  ]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("work", [LABELS[0] as LabelDef]);

  expect(requests).toHaveLength(2);
  expect(requests[1]?.body).toEqual({ displayName: "Action Needed", color: "preset0" });
});

test("a non-2xx list response is a typed error naming the account and status (API_ERROR)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ error: { code: "Forbidden", message: "SECRET-PAYLOAD" } }, false, 403),
  ]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("work", LABELS).catch((err: unknown) => err)) as M365AdapterError;

  expect(error).toBeInstanceOf(M365AdapterError);
  expect(error.code).toBe("LIST_CATEGORIES_FAILED");
  expect(error.accountId).toBe("work");
  expect(error.status).toBe(403);
  expect(error.message).toContain('account "work"');
  expect(error.message).toContain("403");
  expect(error.message).not.toContain("SECRET-PAYLOAD");
  expect(requests).toHaveLength(1);
});

test("a throttled create surfaces as a typed error with no retry (THROTTLED)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ value: [] }),
    jsonResponse({ error: { code: "TooManyRequests", message: "SECRET-PAYLOAD" } }, false, 429),
  ]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("work", [LABELS[0] as LabelDef]).catch((err: unknown) => err)) as
    M365AdapterError;

  expect(error).toBeInstanceOf(M365AdapterError);
  expect(error.code).toBe("CREATE_CATEGORY_FAILED");
  expect(error.accountId).toBe("work");
  expect(error.status).toBe(429);
  expect(error.message).toContain("Action Needed");
  expect(error.message).not.toContain("SECRET-PAYLOAD");
  expect(requests).toHaveLength(2);
});

test("a list response without a category list is a typed error, never a mass-create", async () => {
  const { fetchFn, requests } = scriptedFetch([jsonResponse({ "@odata.context": "..." })]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("work", LABELS).catch((err: unknown) => err)) as M365AdapterError;

  expect(error.code).toBe("LIST_CATEGORIES_FAILED");
  expect(requests).toHaveLength(1);
});

test("an unreachable Graph is reported without the thrown cause (network)", async () => {
  const fetchFn: FetchLike = async () => {
    throw new TypeError("fetch failed: connect ECONNREFUSED");
  };
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("work", LABELS).catch((err: unknown) => err)) as M365AdapterError;

  expect(error.code).toBe("LIST_CATEGORIES_FAILED");
  expect(error.message).toBe('Microsoft Graph could not be reached for account "work".');
});

test("the token seam's typed error propagates unchanged without any Graph call (AUTH)", async () => {
  const authError = new M365AuthError(
    "AUTH_REQUIRED",
    "work",
    'No valid token for account "work" — run `--auth m365 --account work` to sign in.',
  );
  const { fetchFn, requests } = scriptedFetch([]);
  const adapter = new M365Adapter({
    fetchFn,
    getAccessToken: async () => {
      throw authError;
    },
  });

  const error = await adapter.ensureCategories("work", LABELS).catch((err: unknown) => err);

  expect(error).toBe(authError);
  expect(requests).toHaveLength(0);
});

test("a create POST returning a generic non-2xx is a typed error carrying its status (API_ERROR)", async () => {
  const { fetchFn } = scriptedFetch([jsonResponse({ value: [] }), jsonResponse({}, false, 500)]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("work", [LABELS[0] as LabelDef]).catch((err: unknown) => err)) as
    M365AdapterError;

  expect(error).toBeInstanceOf(M365AdapterError);
  expect(error.code).toBe("CREATE_CATEGORY_FAILED");
  expect(error.status).toBe(500);
  expect(error.message).toContain("Action Needed");
});

test("a non-2xx on a later page fails the list before anything is created (PAGED)", async () => {
  const nextLink = `${LISTS_URL}?$skiptoken=page-2`;
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ value: [{ id: "c1", displayName: "Action Needed" }], "@odata.nextLink": nextLink }),
    jsonResponse({}, false, 503),
  ]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("work", LABELS).catch((err: unknown) => err)) as M365AdapterError;

  expect(error.code).toBe("LIST_CATEGORIES_FAILED");
  expect(error.status).toBe(503);
  expect(requests).toHaveLength(2);
  // The half-read list must not have produced a single create.
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("the same name given twice is created only once", async () => {
  const label = LABELS[0] as LabelDef;
  const { fetchFn, requests } = scriptedFetch([jsonResponse({ value: [] }), jsonResponse({}, true, 201)]);
  const adapter = new M365Adapter({ fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("work", [label, label]);

  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
});
