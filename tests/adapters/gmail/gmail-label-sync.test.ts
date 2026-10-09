import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaxonomy } from "../../../src/adapters/config/taxonomy.js";
import { GmailAdapter, GmailAdapterError, type GmailAdapterDeps } from "../../../src/adapters/gmail/GmailAdapter.js";
import { GmailAuthError } from "../../../src/adapters/gmail/GmailAuthAdapter.js";
import type { LabelDef } from "../../../src/core/dto/LabelDef.js";
import {
  LABELS,
  colorOf,
  created,
  jsonResponse,
  labelList,
  makeLogPort,
  scriptedFetch,
  tokenSource,
} from "./harness.js";

const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";

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
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: token.getAccessToken });

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
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });
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
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", labels);

  const posts = requests.slice(1);
  expect(posts.map((request) => request.body?.["name"])).toEqual(["Waiting/Follow-up", "Family/Friends"]);
});

test("sends the nearest allowed colour plus a contrasting allowed text colour (COLOUR)", async () => {
  const { fetchFn, requests } = scriptedFetch([labelList([]), created()]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", [LABELS[0] as LabelDef]);

  // #E67C73 is not in Gmail's palette; #e07798 is the closest allowed background, and
  // #000000 the allowed text colour that contrasts with it.
  expect(colorOf(requests[1])).toEqual({ backgroundColor: "#e07798", textColor: "#000000" });
});

test("matches the label name exactly and case-sensitively", async () => {
  const { fetchFn, requests } = scriptedFetch([labelList([{ id: "Label_1", name: "action needed" }]), created()]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", [LABELS[0] as LabelDef]);

  expect(requests).toHaveLength(2);
  expect(requests[1]?.body?.["name"]).toBe("Action Needed");
});

test("the same name given twice is created only once", async () => {
  const label = LABELS[0] as LabelDef;
  const { fetchFn, requests } = scriptedFetch([labelList([]), created()]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", [label, label]);

  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("a non-2xx list response is a typed error naming the account and status (API_ERROR)", async () => {
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ error: { code: 403, message: "SECRET-PAYLOAD" } }, false, 403),
  ]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("personal", [LABELS[0] as LabelDef]).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("CREATE_LABEL_FAILED");
  expect(error.status).toBe(429);
  expect(requests).toHaveLength(2);
});

test("a list response without a label list is a typed error, never a mass-create", async () => {
  const { fetchFn, requests } = scriptedFetch([jsonResponse({})]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("personal", LABELS).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("LIST_LABELS_FAILED");
  expect(requests).toHaveLength(1);
});

test("a created label without an id is a typed error, since the label could never be written back to", async () => {
  const { fetchFn } = scriptedFetch([labelList([]), jsonResponse({ name: "Action Needed" })]);
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  const error = (await adapter.ensureCategories("personal", [LABELS[0] as LabelDef]).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("CREATE_LABEL_FAILED");
  expect(error.message).toContain("no label id");
});

test("an unreachable Gmail is reported without the thrown cause (network)", async () => {
  const fetchFn: GmailAdapterDeps["fetchFn"] = async () => {
    throw new TypeError("fetch failed: connect ECONNREFUSED");
  };
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

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
  const adapter = new GmailAdapter({ logPort: makeLogPort(),
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
  const adapter = new GmailAdapter({ logPort: makeLogPort(), fetchFn, getAccessToken: tokenSource().getAccessToken });

  await adapter.ensureCategories("personal", labels);
  expect(adapter.labelIdsFor("personal")?.get("Family/Friends")).toBe("id-2");

  const error = await adapter.ensureCategories("personal", labels).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(GmailAdapterError);
  // The run never completed, so the last complete snapshot is what remains.
  const ids = adapter.labelIdsFor("personal");
  expect(ids?.size).toBe(2);
  expect(ids?.get("Family/Friends")).toBe("id-2");
});

