import { expect, test } from "vitest";
import {
  M365Adapter,
  M365AdapterError,
  type M365AdapterDeps,
} from "../../../src/adapters/m365/M365Adapter.js";
import type { FetchResponseLike } from "../../../src/adapters/m365/M365AuthAdapter.js";
import type { LogPort } from "../../../src/core/ports/LogPort.js";
import type { LabelDef } from "../../../src/core/dto/LabelDef.js";
import type { TokenSet } from "../../../src/core/dto/TokenSet.js";

const MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/messages";

const ACCESS_TOKEN: TokenSet = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 9_999_999_999,
  scopes: ["Mail.ReadWrite", "MailboxSettings.ReadWrite"],
};

/** One taxonomy label, enough for `ensureCategories` to create it. */
const LABEL: LabelDef = {
  name: "Action Needed",
  description: "Needs a reply from you.",
  m365Color: "preset0",
  gmailColor: "#3F51B5",
};

interface RecordedRequest {
  url: string;
  method: string;
}

/** The throttle suites never really wait: a recorder stands in for the adapters' sleep seam. */
function sleepRecorder(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

/** A JSON response; `headers` carries `Retry-After` for the throttle rows. */
function jsonResponse(body: unknown, ok = true, status = 200, headers?: Record<string, string>): FetchResponseLike {
  return {
    ok,
    status,
    ...(headers === undefined ? {} : { headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } }),
    json: async () => body,
  };
}

/** One Graph message list page. */
function graphPage(ids: string[]): FetchResponseLike {
  return jsonResponse({
    value: ids.map((id) => ({
      id,
      internetMessageId: `<${id}@example.com>`,
      subject: `Subject ${id}`,
      bodyPreview: `Preview ${id}`,
      receivedDateTime: "2026-10-10T12:34:56Z",
      categories: [],
      isRead: false,
      from: { emailAddress: { address: `${id}@example.com`, name: `Sender ${id}` } },
    })),
  });
}

function scriptedFetch(responses: FetchResponseLike[]): {
  fetchFn: M365AdapterDeps["fetchFn"];
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: M365AdapterDeps["fetchFn"] = async (url) => {
    requests.push({ url, method: "GET" });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetchFn, requests };
}

function tokenSource(): M365AdapterDeps["getAccessToken"] {
  return async () => ACCESS_TOKEN;
}

function logPortRecorder(): LogPort & { warnings: Array<{ message: string; context?: unknown }> } {
  const warnings: Array<{ message: string; context?: unknown }> = [];
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, context) => warnings.push({ message, context }),
    error: () => undefined,
    warnings,
  };
}

/** One throttled list page, then the same page unthrottled. */
function throttledThenOk(retryAfter?: string): ReturnType<typeof scriptedFetch> {
  return scriptedFetch([
    jsonResponse({ error: { code: "TooManyRequests", message: "Rate Limited" } }, false, 429, ...(retryAfter === undefined ? [] : [{ "retry-after": retryAfter }])),
    graphPage([]),
  ]);
}

test("a 429 with `Retry-After: 7` waits its seconds once and re-issues the same call (THROTTLED_WITH_HEADER)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = throttledThenOk("7");
  const logPort = logPortRecorder();
  const adapter = new M365Adapter({ fetchFn, logPort, getAccessToken: tokenSource(), sleep });

  const messages = await adapter.fetchMessages({ source: "m365", accountId: "work" });

  expect(messages).toEqual([]);
  expect(sleeps).toEqual([7_000]);
  // The capped wait is logged naming the account and the wait — no silent sleeping.
  expect(logPort.warnings).toEqual([
    {
      message: 'Account "work" is throttled by Microsoft Graph — waiting 7s before retry 1 of 5.',
      context: { accountId: "work", waitSeconds: 7 },
    },
  ]);
  expect(requests).toHaveLength(2);
  expect(requests[0]?.url).toBe(requests[1]?.url);
  expect(requests[0]?.url.startsWith(MESSAGES_URL)).toBe(true);
});

test("a `Retry-After` longer than 60s is capped (CAP)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = throttledThenOk("120");
  const adapter = new M365Adapter({
    fetchFn,
    logPort: logPortRecorder(),
    getAccessToken: tokenSource(),
    sleep,
  });

  await adapter.fetchMessages({ source: "m365", accountId: "work" });

  expect(sleeps).toEqual([60_000]);
  expect(requests).toHaveLength(2);
});

test("a header that does not parse — an HTTP-date — falls back to the ladder (THROTTLED_LADDER)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = throttledThenOk("Fri, 31 Dec 2026 00:00:00 GMT");
  const adapter = new M365Adapter({
    fetchFn,
    logPort: logPortRecorder(),
    getAccessToken: tokenSource(),
    sleep,
  });

  await adapter.fetchMessages({ source: "m365", accountId: "work" });

  expect(sleeps).toEqual([2_000]);
  expect(requests).toHaveLength(2);
});

test("a 429 without a usable `Retry-After` climbs 2s, 4s, 8s, 16s rung per attempt (THROTTLED_LADDER)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const throttled = jsonResponse({ error: { code: "TooManyRequests" } }, false, 429);
  const { fetchFn, requests } = scriptedFetch([throttled, throttled, throttled, throttled, graphPage([])]);
  const logPort = logPortRecorder();
  const adapter = new M365Adapter({ fetchFn, logPort, getAccessToken: tokenSource(), sleep });

  await adapter.fetchMessages({ source: "m365", accountId: "work" });

  expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000]);
  expect(logPort.warnings.map((entry) => entry.message)).toContain(
    'Account "work" is throttled by Microsoft Graph — waiting 16s before retry 4 of 5.',
  );
  // The same call is re-issued per attempt.
  expect(new Set(requests.map((request) => request.url)).size).toBe(1);
  expect(requests).toHaveLength(5);
});

test("a `Retry-After` present on some attempts and absent on others mixes header and ladder (HEADER_OVERRIDES_LADDER)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const rateLimited = { error: { code: "TooManyRequests" } };
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse(rateLimited, false, 429, { "retry-after": "9" }), // attempt 1: header's 9s
    jsonResponse(rateLimited, false, 429), // attempt 2: no header, the ladder's second rung
    jsonResponse(rateLimited, false, 429, { "retry-after": "120" }), // attempt 3: header capped 60s
    graphPage([]),
  ]);
  const adapter = new M365Adapter({
    fetchFn,
    logPort: logPortRecorder(),
    getAccessToken: tokenSource(),
    sleep,
  });

  await adapter.fetchMessages({ source: "m365", accountId: "work" });

  // The ladder is indexed by attempt, so a header wait never advances it.
  expect(sleeps).toEqual([9_000, 4_000, 60_000]);
  expect(requests).toHaveLength(4);
});

test("five throttled retries exhaust the ladder and give up with a distinct typed error naming the account (GIVE_UP)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  // The initial call plus all five retries are still throttled — the ladder's every rung is spent.
  const { fetchFn, requests } = scriptedFetch(
    Array.from({ length: 6 }, () => jsonResponse({ error: { code: "TooManyRequests" } }, false, 429)),
  );
  const logPort = logPortRecorder();
  const adapter = new M365Adapter({ fetchFn, logPort, getAccessToken: tokenSource(), sleep });

  const error = (await adapter
    .fetchMessages({ source: "m365", accountId: "work" })
    .catch((err: unknown) => err)) as M365AdapterError;

  expect(error).toBeInstanceOf(M365AdapterError);
  expect(error.code).toBe("RATE_LIMIT_GAVE_UP");
  expect(error.accountId).toBe("work");
  expect(error.status).toBe(429);
  // One actionable line: account and exhaustion, never a stack trace (AD-4).
  expect(error.message).toBe(
    'Microsoft Graph kept throttling account "work" — the call was abandoned after 5 backoff retries (HTTP 429).',
  );
  // The ladder's every rung was waited and logged before the give-up.
  expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
  expect(logPort.warnings).toHaveLength(5);
  expect(requests).toHaveLength(6);
});

test("a non-429 failure never waits, unchanged from Story 7.1 (FLAT_KEEP)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = scriptedFetch([jsonResponse({ error: { code: "InternalServerError" } }, false, 500)]);
  const adapter = new M365Adapter({
    fetchFn,
    logPort: logPortRecorder(),
    getAccessToken: tokenSource(),
    sleep,
  });

  const error = (await adapter
    .fetchMessages({ source: "m365", accountId: "work" })
    .catch((err: unknown) => err)) as M365AdapterError;

  expect(error.code).toBe("LIST_MESSAGES_FAILED");
  expect(error.status).toBe(500);
  expect(sleeps).toEqual([]);
  expect(requests).toHaveLength(1);
});

test("the throttled label write uses the same seam: a 429 write is retried inside the run", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ error: { code: "TooManyRequests" } }, false, 429), // the write's read: throttled, then retried
    jsonResponse({ id: "m1", categories: [] }),
    jsonResponse({ id: "m1", categories: ["Action Needed"] }),
  ]);
  const logPort = logPortRecorder();
  const adapter = new M365Adapter({ fetchFn, logPort, getAccessToken: tokenSource(), sleep });

  await adapter.writeLabels("work", "m1", ["Action Needed"]);

  expect(sleeps).toEqual([2_000]);
  expect(logPort.warnings).toHaveLength(1);
  expect(requests).toHaveLength(3);
});

test("a 429 on create walks the ladder and then creates (THROTTLED_CREATE)", async () => {
  const { sleeps, sleep } = sleepRecorder();
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ value: [] }),
    jsonResponse({ error: { code: "TooManyRequests", message: "Rate Limited" } }, false, 429),
    jsonResponse({ id: "created" }, true, 201),
  ]);
  const adapter = new M365Adapter({ fetchFn, logPort: logPortRecorder(), getAccessToken: tokenSource(), sleep });

  await adapter.ensureCategories("work", [LABEL]);

  expect(sleeps).toEqual([2_000]);
  expect(requests).toHaveLength(3);
});
