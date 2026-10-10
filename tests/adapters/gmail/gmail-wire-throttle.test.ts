import { expect, test } from "vitest";
import { GmailAdapter, GmailAdapterError } from "../../../src/adapters/gmail/GmailAdapter.js";
import { retryAfterSeconds } from "../../../src/adapters/gmail/gmailWire.js";
import type { ThrottleSleep } from "../../../src/adapters/gmail/gmailWire.js";
import {
  batchResponse,
  gmailDetail,
  jsonResponse,
  makeLogPort,
  scriptedFetch,
  tokenSource,
} from "./harness.js";

/** The throttle suites never really wait: a recorder stands in for the adapters' sleep seam. */
function sleepRecorder(): { sleeps: number[]; sleep: ThrottleSleep } {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

test("`Retry-After` parses to integer seconds; an HTTP-date or junk falls back to the ladder", () => {
  expect(retryAfterSeconds(jsonResponse({}, true, 200, { "retry-after": "7" }))).toBe(7);
  // A non-positive or empty header is not a usable wait — it falls back to the ladder.
  expect(retryAfterSeconds(jsonResponse({}, true, 200, { "retry-after": "0" }))).toBeUndefined();
  expect(retryAfterSeconds(jsonResponse({}, true, 200, { "retry-after": "" }))).toBeUndefined();
  expect(retryAfterSeconds(jsonResponse({}, true, 200, { "retry-after": "Fri, 31 Dec 2026 00:00:00 GMT" }))).toBeUndefined();
  expect(retryAfterSeconds(jsonResponse({}, true, 200, { "retry-after": "soon" }))).toBeUndefined();
  expect(retryAfterSeconds(jsonResponse({}, true, 200, { "retry-after": "-3" }))).toBeUndefined();
  // No headers at all (a JSON-only double, or an absent header) is exactly "no Retry-After".
  expect(retryAfterSeconds(jsonResponse({}))).toBeUndefined();
});

/** One list page that answers 429, then the same page unthrottled. */
function throttledThenOk(retryAfter?: string): ReturnType<typeof scriptedFetch> {
  return scriptedFetch([
    jsonResponse({ error: { code: 429, message: "Rate Limited" } }, false, 429, ...(retryAfter === undefined ? [] : [{ "retry-after": retryAfter }])),
    jsonResponse({ messages: [] }),
  ]);
}

test("a 429 with `Retry-After: 7` waits its seconds once and re-issues the same list call (THROTTLED_WITH_HEADER)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = throttledThenOk("7");
  const logPort = makeLogPort();
  const adapter = new GmailAdapter({
    logPort,
    fetchFn,
    getAccessToken: tokenSource().getAccessToken,
    sleep,
  });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(messages).toEqual([]);
  expect(sleeps).toEqual([7_000]);
  // The capped wait is logged naming the account and the wait — no silent sleeping.
  expect(logPort.warnings).toEqual([
    {
      message: 'Account "personal" is throttled by Gmail — waiting 7s before retry 1 of 5.',
      context: { accountId: "personal", waitSeconds: 7 },
    },
  ]);
  expect(requests).toHaveLength(2);
  expect(requests[0]?.url).toBe(requests[1]?.url);
});

test("a `Retry-After` longer than 60s is capped, and the walk continues with no error counted (CAP)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = throttledThenOk("120");
  const adapter = new GmailAdapter({
    logPort: makeLogPort(),
    fetchFn,
    getAccessToken: tokenSource().getAccessToken,
    sleep,
  });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(messages).toEqual([]);
  expect(sleeps).toEqual([60_000]);
  expect(requests).toHaveLength(2);
});

test("a 429 without a usable `Retry-After` climbs 2s, 4s, 8s rung per attempt (THROTTLED_LADDER)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  // Three throttled answers, then a good one: attempt 1 waits 2s, attempt 2 waits 4s, attempt 3 waits 8s.
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ error: { code: 429, message: "Rate Limited" } }, false, 429),
    jsonResponse({ error: { code: 429, message: "Rate Limited" } }, false, 429),
    jsonResponse({ error: { code: 429, message: "Rate Limited" } }, false, 429),
    jsonResponse({ messages: [] }),
  ]);
  const logPort = makeLogPort();
  const adapter = new GmailAdapter({
    logPort,
    fetchFn,
    getAccessToken: tokenSource().getAccessToken,
    sleep,
  });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(messages).toEqual([]);
  expect(sleeps).toEqual([2_000, 4_000, 8_000]);
  expect(logPort.warnings.map((entry) => entry.message)).toEqual([
    'Account "personal" is throttled by Gmail — waiting 2s before retry 1 of 5.',
    'Account "personal" is throttled by Gmail — waiting 4s before retry 2 of 5.',
    'Account "personal" is throttled by Gmail — waiting 8s before retry 3 of 5.',
  ]);
  // The same call is re-issued per attempt — one URL, four wire calls.
  expect(new Set(requests.map((request) => request.url)).size).toBe(1);
  expect(requests).toHaveLength(4);
});

test("a `Retry-After` present on some attempts and absent on others mixes header and ladder (HEADER_OVERRIDES_LADDER)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const rateLimited = { error: { code: 429, message: "Rate Limited" } };
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse(rateLimited, false, 429, { "retry-after": "9" }), // attempt 1: header's 9s
    jsonResponse(rateLimited, false, 429), // attempt 2: no header, ladder's next rung...
    jsonResponse(rateLimited, false, 429, { "retry-after": "120" }), // attempt 3: header capped 60s
    jsonResponse({ messages: [] }),
  ]);
  const adapter = new GmailAdapter({
    logPort: makeLogPort(),
    fetchFn,
    getAccessToken: tokenSource().getAccessToken,
    sleep,
  });

  await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  // The ladder is indexed by attempt, so a header wait never advances it: the headerless
  // second attempt takes the ladder's second rung (4s), not the next unconsumed one.
  expect(sleeps).toEqual([9_000, 4_000, 60_000]);
  expect(requests).toHaveLength(4);
});

test("Gmail's `rateLimitExceeded` error body is detected like a 429 (RATE_LIMIT_BODY)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = scriptedFetch([
    // A non-429 status whose body carries Gmail's throttling reason — detected from the body.
    jsonResponse(
      { error: { code: 403, message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded", domain: "gmail" }] } },
      false,
      403,
    ),
    jsonResponse({ messages: [] }),
  ]);
  const logPort = makeLogPort();
  const adapter = new GmailAdapter({
    logPort,
    fetchFn,
    getAccessToken: tokenSource().getAccessToken,
    sleep,
  });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(messages).toEqual([]);
  expect(sleeps).toEqual([2_000]);
  expect(logPort.warnings).toHaveLength(1);
  expect(requests).toHaveLength(2);
});

test("a non-429 failure without the throttle body never waits, unchanged from Stories 5.3/5.4 (FLAT_KEEP)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = scriptedFetch([jsonResponse({ error: { message: "boom" } }, false, 500)]);
  const adapter = new GmailAdapter({
    logPort: makeLogPort(),
    fetchFn,
    getAccessToken: tokenSource().getAccessToken,
    sleep,
  });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(error.status).toBe(500);
  expect(sleeps).toEqual([]);
  expect(requests).toHaveLength(1);
});

test("five throttled retries exhaust the ladder and give up with a distinct typed error naming the account (GIVE_UP)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  // The initial call plus all five retries are still throttled — the ladder's every rung is spent.
  const throttled = () => jsonResponse({ error: { code: 429, message: "Rate Limited" } }, false, 429);
  const { fetchFn, requests } = scriptedFetch(Array.from({ length: 6 }, throttled));
  const logPort = makeLogPort();
  const adapter = new GmailAdapter({
    logPort,
    fetchFn,
    getAccessToken: tokenSource().getAccessToken,
    sleep,
  });

  const error = (await adapter
    .fetchMessages({ source: "gmail", accountId: "personal" })
    .catch((err: unknown) => err)) as GmailAdapterError;

  expect(error).toBeInstanceOf(GmailAdapterError);
  expect(error.code).toBe("RATE_LIMIT_GAVE_UP");
  expect(error.accountId).toBe("personal");
  expect(error.status).toBe(429);
  // One actionable line: account and exhaustion, never a stack trace (AD-4).
  expect(error.message).toBe(
    'Gmail kept throttling account "personal" — the call was abandoned after 5 backoff retries (HTTP 429).',
  );
  // The ladder's every rung was waited and logged before the give-up.
  expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
  expect(logPort.warnings).toHaveLength(5);
  expect(requests).toHaveLength(6);
});

test("the throttled batch POST uses the same seam: a 429 batch is retried inside the walk", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ messages: [{ id: "m1" }] }),
    jsonResponse({ error: { code: 429, message: "Rate Limited" } }, false, 429),
    batchResponse([{ body: gmailDetail("m1") }]),
  ]);
  const adapter = new GmailAdapter({
    logPort: makeLogPort(),
    fetchFn,
    getAccessToken: tokenSource().getAccessToken,
    sleep,
  });

  const messages = await adapter.fetchMessages({ source: "gmail", accountId: "personal" });

  expect(messages.map((message) => message.id)).toEqual(["m1"]);
  expect(sleeps).toEqual([2_000]);
  expect(requests).toHaveLength(3);
  expect(requests[1]?.method).toBe("POST");
});
