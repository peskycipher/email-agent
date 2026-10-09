import { expect, test } from "vitest";
import { GmailAdapter, GmailAdapterError, type GmailAdapterDeps } from "../../../src/adapters/gmail/GmailAdapter.js";
import {
  jsonResponse,
  labelList,
  makeLogPort,
  scriptedFetch,
  tokenSource,
} from "./harness.js";

const MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

const CRYPTO_LABEL = {
  name: "Crypto",
  description: "Crypto mail.",
  m365Color: "preset0" as const,
  gmailColor: "#000000",
};

async function syncLabel(adapter: GmailAdapter, name: string): Promise<void> {
  await adapter.ensureCategories("personal", [
    { name, description: "", m365Color: "preset0" as const, gmailColor: "#000000" },
  ]);
}

async function syncCrypto(adapter: GmailAdapter, _fetchFn: GmailAdapterDeps["fetchFn"]): Promise<void> {
  // Seed the account's label cache with Crypto → L2 via a complete sync.
  await adapter.ensureCategories("personal", [CRYPTO_LABEL]);
}

test("writes missing label ids with addLabelIds only (HAPPY)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ id: "msg1", labelIds: ["L1"] }),
    jsonResponse({ id: "msg1", labelIds: ["L1", "L2"] }),
  ]);
  const logPort = makeLogPort();
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort });

  await syncCrypto(adapter, fetchFn);
  await adapter.writeLabels("personal", "msg1", ["Crypto"]);

  const modify = requests.find((request) => request.method === "POST" && request.url.endsWith("/modify"));
  expect(modify).toBeDefined();
  expect(modify?.url).toBe(`${MESSAGES_URL}/msg1/modify`);
  expect(modify?.body).toEqual({ addLabelIds: ["L2"] });
  expect(modify?.body).not.toHaveProperty("removeLabelIds");
  expect(requests[1]?.url).toBe(`${MESSAGES_URL}/msg1?format=minimal&fields=labelIds`);
  expect(token.calls.filter((call) => call === "personal")).toHaveLength(2);
});

const PARTIAL_LABELS = [
  { name: "Crypto", description: "Crypto mail.", m365Color: "preset0" as const, gmailColor: "#000000" },
  { name: "Promos", description: "Promos mail.", m365Color: "preset0" as const, gmailColor: "#000000" },
];

test("adds only the predicted ids the message is missing (PARTIAL)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([
      { id: "L2", name: "Crypto" },
      { id: "L3", name: "Promos" },
    ]),
    jsonResponse({ id: "msg1", labelIds: ["L1", "L2"] }),
    jsonResponse({ id: "msg1", labelIds: ["L1", "L2", "L3"] }),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await adapter.ensureCategories("personal", PARTIAL_LABELS);
  await adapter.writeLabels("personal", "msg1", ["Crypto", "Promos"]);

  const modify = requests.find((request) => request.url.endsWith("/modify"));
  expect(modify?.body).toEqual({ addLabelIds: ["L3"] });
});

test("does not POST modify when every predicted id is already present (IDEMPOTENT)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ id: "msg1", labelIds: ["L1", "L2"] }),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncCrypto(adapter, fetchFn);
  await adapter.writeLabels("personal", "msg1", ["Crypto"]);

  expect(requests.filter((request) => request.method === "POST" && request.url.endsWith("/modify"))).toHaveLength(0);
  expect(requests[1]?.url).toBe(`${MESSAGES_URL}/msg1?format=minimal&fields=labelIds`);
});

test("returns early for an empty label set without touching the token or network (EMPTY_SET)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await adapter.writeLabels("personal", "msg1", []);

  expect(requests).toHaveLength(0);
  expect(token.calls).toHaveLength(0);
});

test("leaves unrelated existing labels untouched and skips the modify call (SUBSUMED)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ id: "msg1", labelIds: ["L2", "L3", "L4"] }),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncCrypto(adapter, fetchFn);
  await adapter.writeLabels("personal", "msg1", ["Crypto"]);

  expect(requests.filter((request) => request.method === "POST" && request.url.endsWith("/modify"))).toHaveLength(0);
});

test("collapses duplicate input names into one addLabelIds entry (DUPLICATE_INPUT)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ id: "msg1", labelIds: ["L1"] }),
    jsonResponse({ id: "msg1", labelIds: ["L1", "L2"] }),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncCrypto(adapter, fetchFn);
  await adapter.writeLabels("personal", "msg1", ["Crypto", "Crypto"]);

  const modify = requests.find((request) => request.url.endsWith("/modify"));
  expect(modify?.body).toEqual({ addLabelIds: ["L2"] });
});

test("a cached name in different case is a typed error, never a second label (CASE_MISMATCH)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([labelList([{ id: "L9", name: "crypto" }])]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncLabel(adapter, "crypto");

  const error = (await adapter.writeLabels("personal", "msg1", ["Crypto"]).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("WRITE_LABELS_FAILED");
  expect(error.message).toContain("Crypto");
  expect(error.message).toContain("personal");
  // Only the label list: the case-sensitive lookup fails before any message call.
  expect(requests).toHaveLength(1);
});

test("percent-encodes a message id carrying reserved characters (ENCODED_ID)", async () => {
  const token = tokenSource();
  const messageId = "18c+1/2=";
  const encodedId = encodeURIComponent(messageId);
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ id: messageId, labelIds: ["L1"] }),
    jsonResponse({ id: messageId, labelIds: ["L1", "L2"] }),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncCrypto(adapter, fetchFn);
  await adapter.writeLabels("personal", messageId, ["Crypto"]);

  expect(requests[1]?.url).toBe(`${MESSAGES_URL}/${encodedId}?format=minimal&fields=labelIds`);
  expect(requests[2]?.url).toBe(`${MESSAGES_URL}/${encodedId}/modify`);
});

test("an account with no complete sync is a typed error naming the account (UNCACHED_ACCOUNT)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  const error = (await adapter.writeLabels("personal", "msg1", ["Crypto"]).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("WRITE_LABELS_FAILED");
  expect(error.accountId).toBe("personal");
  expect(error.message).toContain("personal");
  expect(requests).toHaveLength(0);
});

test("a 404 from the read is absorbed as a warning and returns (NOT_FOUND)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ error: { code: 404, message: "Not found" } }, false, 404),
  ]);
  const logPort = makeLogPort();
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort });

  await syncCrypto(adapter, fetchFn);
  await adapter.writeLabels("personal", "msg1", ["Crypto"]);

  expect(logPort.warnings).toHaveLength(1);
  expect(logPort.warnings[0]?.message).toContain("msg1");
  expect(logPort.warnings[0]?.message).toContain("personal");
  expect(logPort.warnings[0]?.context).toMatchObject({ accountId: "personal", messageId: "msg1" });
  expect(requests.filter((request) => request.url.endsWith("/modify"))).toHaveLength(0);
});

test("a 404 from the modify is absorbed as a warning and returns (NOT_FOUND)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ id: "msg1", labelIds: ["L1"] }),
    jsonResponse({ error: { code: 404, message: "Not found" } }, false, 404),
  ]);
  const logPort = makeLogPort();
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort });

  await syncCrypto(adapter, fetchFn);
  await adapter.writeLabels("personal", "msg1", ["Crypto"]);

  expect(logPort.warnings).toHaveLength(1);
  expect(logPort.warnings[0]?.context).toMatchObject({ accountId: "personal", messageId: "msg1" });
  expect(requests.filter((request) => request.url.endsWith("/modify"))).toHaveLength(1);
});

test("a 401 on the read refreshes the token once and replays the whole operation (UNAUTHORIZED)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ error: { code: 401, message: "Unauthorized" } }, false, 401),
    jsonResponse({ id: "msg1", labelIds: ["L1"] }),
    jsonResponse({ id: "msg1", labelIds: ["L1", "L2"] }),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncCrypto(adapter, fetchFn);
  await adapter.writeLabels("personal", "msg1", ["Crypto"]);

  const modify = requests.find((request) => request.url.endsWith("/modify"));
  expect(modify?.body).toEqual({ addLabelIds: ["L2"] });
  // ensureCategories + initial write + forced refresh
  expect(token.calls.filter((call) => call === "personal")).toHaveLength(3);
  // The second write-path fetch must ask for a refresh; without the flag the real seam
  // hands back the token Gmail just rejected.
  expect(token.options.at(-1)).toEqual({ forceRefresh: true });
  expect(token.options.at(-2)).toBeUndefined();
  // The replay carries the token the forced refresh issued, not the rejected one.
  expect(requests.at(-2)?.headers.authorization).toBe("Bearer access-2");
});

test("a 401 on the modify also refreshes once and replays (UNAUTHORIZED_MODIFY)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ id: "msg1", labelIds: ["L1"] }),
    jsonResponse({ error: { code: 401, message: "Unauthorized" } }, false, 401),
    jsonResponse({ id: "msg1", labelIds: ["L1"] }),
    jsonResponse({ id: "msg1", labelIds: ["L1", "L2"] }),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncCrypto(adapter, fetchFn);
  await adapter.writeLabels("personal", "msg1", ["Crypto"]);

  expect(requests.filter((request) => request.url.endsWith("/modify"))).toHaveLength(2);
  expect(token.options.at(-1)).toEqual({ forceRefresh: true });
});

test("a 401 that persists after the force refresh is a typed failure (UNAUTHORIZED_RETRY_FAILS)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ error: { code: 401, message: "Unauthorized" } }, false, 401),
    jsonResponse({ error: { code: 401, message: "Unauthorized" } }, false, 401),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncCrypto(adapter, fetchFn);
  const error = (await adapter.writeLabels("personal", "msg1", ["Crypto"]).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("WRITE_LABELS_FAILED");
  expect(error.status).toBe(401);
  // The label list, the rejected read, and exactly one replay.
  expect(requests).toHaveLength(3);
  expect(token.options.filter((options) => options?.forceRefresh)).toHaveLength(1);
});

test("a non-2xx other than 401/404 is a typed error naming account and status (API_ERROR)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ error: { code: 500, message: "SECRET-PAYLOAD" } }, false, 500),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncCrypto(adapter, fetchFn);
  const error = (await adapter.writeLabels("personal", "msg1", ["Crypto"]).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("WRITE_LABELS_FAILED");
  expect(error.status).toBe(500);
  expect(error.message).toContain("500");
  expect(error.message).not.toContain("SECRET-PAYLOAD");
  expect(requests.filter((request) => request.url.endsWith("/modify"))).toHaveLength(0);
});

test("a network failure is a typed error without the thrown cause (NETWORK)", async () => {
  const token = tokenSource();
  let calls = 0;
  const fetchFn: GmailAdapterDeps["fetchFn"] = async (_url, _init) => {
    if (calls++ === 0) {
      return labelList([{ id: "L2", name: "Crypto" }]);
    }
    throw new TypeError("fetch failed: connect ECONNREFUSED");
  };
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncCrypto(adapter, fetchFn);
  const error = (await adapter.writeLabels("personal", "msg1", ["Crypto"]).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("WRITE_LABELS_FAILED");
  expect(error.message).toBe('Gmail could not be reached for account "personal".');
});

test("a read response without a labelIds array is a typed error and no modify POST (MALFORMED)", async () => {
  const token = tokenSource();
  const { fetchFn, requests } = scriptedFetch([
    labelList([{ id: "L2", name: "Crypto" }]),
    jsonResponse({ id: "msg1" }),
  ]);
  const adapter = new GmailAdapter({ fetchFn, getAccessToken: token.getAccessToken, logPort: makeLogPort() });

  await syncCrypto(adapter, fetchFn);
  const error = (await adapter.writeLabels("personal", "msg1", ["Crypto"]).catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("WRITE_LABELS_FAILED");
  expect(error.message).toContain("labelIds");
  expect(requests.filter((request) => request.url.endsWith("/modify"))).toHaveLength(0);
});
