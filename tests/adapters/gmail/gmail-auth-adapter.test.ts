import { expect, test, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authorizeWithLoopback,
  GmailAuthAdapter,
  GmailAuthError,
  GmailConsentError,
  GMAIL_SCOPES,
  type FetchLike,
  type FetchResponseLike,
} from "../../../src/adapters/gmail/GmailAuthAdapter.js";
import type { TokenSet } from "../../../src/core/dto/TokenSet.js";
import type { TokenPort } from "../../../src/core/ports/TokenPort.js";

const ENV = { GMAIL_PERSONAL_CLIENT_SECRET: "SECRET-CLIENT-SECRET" };
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

interface RecordedRequest {
  url: string;
  params: URLSearchParams;
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
    requests.push({ url, params: new URLSearchParams(init.body) });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetchFn, requests };
}

function storePort(initial?: TokenSet): {
  port: TokenPort;
  getCalls: Array<{ provider: string; accountId: string }>;
  setCalls: Array<{ provider: string; accountId: string; tokens: TokenSet }>;
} {
  let current = initial;
  const getCalls: Array<{ provider: string; accountId: string }> = [];
  const setCalls: Array<{ provider: string; accountId: string; tokens: TokenSet }> = [];
  const port: TokenPort = {
    async get(provider, accountId) {
      getCalls.push({ provider, accountId });
      if (current) return current;
      const notFound = new Error("No stored token.") as Error & { code: string };
      notFound.name = "TokenStoreError";
      notFound.code = "TOKEN_NOT_FOUND";
      throw notFound;
    },
    async set(provider, accountId, tokens) {
      current = tokens;
      setCalls.push({ provider, accountId, tokens });
    },
    async delete() {},
  };
  return { port, getCalls, setCalls };
}

function settingsReader(): ReturnType<typeof vi.fn> {
  return vi.fn(async (accountName: string) => ({
    name: accountName,
    enabled: true,
    clientId: "client-1",
    clientSecretEnvVar: "GMAIL_PERSONAL_CLIENT_SECRET",
  }));
}

function adapter(options: {
  store: ReturnType<typeof storePort>;
  fetchFn: FetchLike;
  authorize: (authUrl: string, redirectUri: string) => Promise<string>;
  read?: ReturnType<typeof vi.fn>;
  now?: () => number;
  env?: Record<string, string | undefined>;
}): GmailAuthAdapter {
  return new GmailAuthAdapter({
    fetchFn: options.fetchFn,
    tokenStore: options.store.port,
    accountSettings: { read: options.read ?? settingsReader() },
    authorize: options.authorize,
    now: options.now ?? (() => 1_000_000),
    env: options.env ?? ENV,
  });
}

function consentUrlParams(authUrl: string): URLSearchParams {
  return new URL(authUrl).searchParams;
}

test("happy path opens consent, exchanges the code and persists the three scopes (HAPPY_PATH)", async () => {
  const store = storePort();
  const read = settingsReader();
  const authorize = vi.fn(async () => "canned-code");
  const clock = 1_000_000;
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
  ]);
  const auth = adapter({ store, fetchFn, authorize, read, now: () => clock });

  const result = await auth.authenticate("personal");

  expect(result).toEqual({
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: clock + 3_600_000,
    scopes: [...GMAIL_SCOPES],
  });
  expect(store.setCalls).toHaveLength(1);
  expect(store.setCalls[0]?.provider).toBe("gmail");
  expect(store.setCalls[0]?.accountId).toBe("personal");
  expect(store.setCalls[0]?.tokens).toEqual(result);
  expect(read).toHaveBeenCalledWith("personal");

  expect(authorize).toHaveBeenCalledTimes(1);
  const [authUrl, redirectUri] = authorize.mock.calls[0] as [string, string];
  const params = consentUrlParams(authUrl);
  expect(params.get("response_type")).toBe("code");
  expect(params.get("client_id")).toBe("client-1");
  expect(params.get("scope")).toBe(
    GMAIL_SCOPES.map((scope) => `https://www.googleapis.com/auth/${scope}`).join(" "),
  );
  expect(params.get("access_type")).toBe("offline");
  expect(params.get("prompt")).toBe("consent");
  expect(params.get("redirect_uri")).toBe(redirectUri);
  expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(TOKEN_ENDPOINT);
  expect(requests[0]?.params.get("grant_type")).toBe("authorization_code");
  expect(requests[0]?.params.get("code")).toBe("canned-code");
  expect(requests[0]?.params.get("client_id")).toBe("client-1");
  expect(requests[0]?.params.get("client_secret")).toBe("SECRET-CLIENT-SECRET");
  expect(requests[0]?.params.get("redirect_uri")).toBe(redirectUri);
});

test("reuses an unexpired cached token without opening consent or the network (ALREADY_VALID)", async () => {
  const cached: TokenSet = {
    accessToken: "cached-access",
    refreshToken: "cached-refresh",
    expiresAt: 9_999_999,
    scopes: [...GMAIL_SCOPES],
  };
  const store = storePort(cached);
  const authorize = vi.fn(async () => "canned-code");
  const { fetchFn, requests } = scriptedFetch([]);
  const auth = adapter({ store, fetchFn, authorize, now: () => 1_000_000 });

  expect(await auth.getAccessToken("personal")).toEqual(cached);
  expect(await auth.authenticate("personal")).toEqual(cached);
  expect(authorize).not.toHaveBeenCalled();
  expect(requests).toHaveLength(0);
});

test("silently refreshes an expired token and re-persists it (EXPIRED)", async () => {
  const store = storePort({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    scopes: [...GMAIL_SCOPES],
  });
  const clock = 5_000;
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
  ]);
  const auth = adapter({ store, fetchFn, authorize: vi.fn(async () => "canned-code"), now: () => clock });

  const refreshed = await auth.getAccessToken("personal");

  expect(refreshed).toEqual({
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: clock + 3_600_000,
    scopes: [...GMAIL_SCOPES],
  });
  expect(store.setCalls).toHaveLength(1);
  expect(store.setCalls[0]?.tokens).toEqual(refreshed);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(TOKEN_ENDPOINT);
  expect(requests[0]?.params.get("grant_type")).toBe("refresh_token");
  expect(requests[0]?.params.get("refresh_token")).toBe("old-refresh");
  expect(requests[0]?.params.get("client_id")).toBe("client-1");
  expect(requests[0]?.params.get("client_secret")).toBe("SECRET-CLIENT-SECRET");
});

test("carries the old refresh token over when Google does not rotate it", async () => {
  const store = storePort({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    scopes: [...GMAIL_SCOPES],
  });
  const { fetchFn } = scriptedFetch([jsonResponse({ access_token: "new-access", expires_in: 3600 })]);
  const auth = adapter({ store, fetchFn, authorize: vi.fn(async () => "canned-code"), now: () => 5_000 });

  const refreshed = await auth.authenticate("personal");

  expect(refreshed.refreshToken).toBe("old-refresh");
});

test("an invalid_grant reports AUTH_REQUIRED with the re-run remedy (REVOKED)", async () => {
  const store = storePort({
    accessToken: "SECRET-ACCESS",
    refreshToken: "SECRET-REFRESH",
    expiresAt: 1,
    scopes: [...GMAIL_SCOPES],
  });
  const { fetchFn } = scriptedFetch([jsonResponse({ error: "invalid_grant" }, false, 400)]);
  const auth = adapter({ store, fetchFn, authorize: vi.fn(async () => "canned-code"), now: () => 5_000 });

  const error = (await auth.getAccessToken("personal").catch((err: unknown) => err)) as GmailAuthError;

  expect(error).toBeInstanceOf(GmailAuthError);
  expect(error.code).toBe("AUTH_REQUIRED");
  expect(error.message).toContain("--auth gmail --account personal");
});

test("authenticate re-runs consent when the refresh token is revoked", async () => {
  const store = storePort({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    scopes: [...GMAIL_SCOPES],
  });
  const authorize = vi.fn(async () => "canned-code");
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ error: "invalid_grant" }, false, 400),
    jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
  ]);
  const auth = adapter({ store, fetchFn, authorize, now: () => 5_000 });

  const result = await auth.authenticate("personal");

  expect(result.accessToken).toBe("new-access");
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(requests[0]?.params.get("grant_type")).toBe("refresh_token");
  expect(requests[1]?.params.get("grant_type")).toBe("authorization_code");
});

test("a transient refresh failure surfaces as TOKEN_REQUEST_FAILED and never re-prompts (TRANSIENT)", async () => {
  const store = storePort({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    scopes: [...GMAIL_SCOPES],
  });
  const authorize = vi.fn(async () => "canned-code");
  const { fetchFn } = scriptedFetch([jsonResponse({ error: "backend_error" }, false, 503)]);
  const auth = adapter({ store, fetchFn, authorize, now: () => 5_000 });

  const error = (await auth.authenticate("personal").catch((err: unknown) => err)) as GmailAuthError;

  expect(error.code).toBe("TOKEN_REQUEST_FAILED");
  expect(authorize).not.toHaveBeenCalled();
});

test("an unreachable token endpoint is TOKEN_REQUEST_FAILED, not a re-consent prompt", async () => {
  const store = storePort({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    scopes: [...GMAIL_SCOPES],
  });
  const authorize = vi.fn(async () => "canned-code");
  const fetchFn: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };
  const auth = adapter({ store, fetchFn, authorize, now: () => 5_000 });

  const error = (await auth.authenticate("personal").catch((err: unknown) => err)) as GmailAuthError;

  expect(error.code).toBe("TOKEN_REQUEST_FAILED");
  expect(authorize).not.toHaveBeenCalled();
});

test("a declined consent is CONSENT_DENIED naming the account (DENIED)", async () => {
  const store = storePort();
  const authorize = vi.fn(async () => {
    throw new GmailConsentError("CONSENT_DENIED", "Google declined the consent (access_denied).");
  });
  const { fetchFn } = scriptedFetch([]);
  const auth = adapter({ store, fetchFn, authorize });

  const error = (await auth.authenticate("personal").catch((err: unknown) => err)) as GmailAuthError;

  expect(error).toBeInstanceOf(GmailAuthError);
  expect(error.code).toBe("CONSENT_DENIED");
  expect(error.message).toContain("personal");
  expect(store.setCalls).toHaveLength(0);
});

test("an uncompleted consent is CONSENT_TIMEOUT printing the consent URL (NO_CODE)", async () => {
  const store = storePort();
  const authorize = vi.fn(async () => {
    throw new GmailConsentError(
      "CONSENT_TIMEOUT",
      "Google consent was not completed within 300 seconds.",
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-1",
    );
  });
  const { fetchFn } = scriptedFetch([]);
  const auth = adapter({ store, fetchFn, authorize });

  const error = (await auth.authenticate("personal").catch((err: unknown) => err)) as GmailAuthError;

  expect(error.code).toBe("CONSENT_TIMEOUT");
  expect(error.message).toContain("https://accounts.google.com/o/oauth2/v2/auth?client_id=client-1");
  expect(error.message).toContain("personal");
});

test("rejects an invalid account name before touching the store, settings or consent (BAD_NAME)", async () => {
  const store = storePort();
  const read = settingsReader();
  const authorize = vi.fn(async () => "canned-code");
  const { fetchFn } = scriptedFetch([]);
  const auth = adapter({ store, fetchFn, authorize, read });

  const error = (await auth.authenticate("Bad_Name").catch((err: unknown) => err)) as GmailAuthError;

  expect(error).toBeInstanceOf(GmailAuthError);
  expect(error.code).toBe("INVALID_ACCOUNT_NAME");
  expect(error.message).toContain("^[a-z0-9]");
  expect(store.getCalls).toHaveLength(0);
  expect(read).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
});

test("a missing client secret names the env var and never opens consent (MISSING_SECRET)", async () => {
  const store = storePort();
  const authorize = vi.fn(async () => "canned-code");
  const { fetchFn, requests } = scriptedFetch([]);
  const auth = adapter({ store, fetchFn, authorize, env: {} });

  const error = (await auth.authenticate("personal").catch((err: unknown) => err)) as GmailAuthError;

  expect(error).toBeInstanceOf(GmailAuthError);
  expect(error.code).toBe("MISSING_CLIENT_SECRET");
  expect(error.message).toContain("GMAIL_PERSONAL_CLIENT_SECRET");
  expect(authorize).not.toHaveBeenCalled();
  expect(requests).toHaveLength(0);
});

test("a rejected code exchange is TOKEN_REQUEST_FAILED and stores nothing", async () => {
  const store = storePort();
  const { fetchFn } = scriptedFetch([jsonResponse({ error: "redirect_uri_mismatch" }, false, 400)]);
  const auth = adapter({ store, fetchFn, authorize: vi.fn(async () => "canned-code") });

  const error = (await auth.authenticate("personal").catch((err: unknown) => err)) as GmailAuthError;

  expect(error.code).toBe("TOKEN_REQUEST_FAILED");
  expect(error.message).toContain("redirect_uri_mismatch");
  expect(store.setCalls).toHaveLength(0);
});

test("no error message ever contains token or secret material", async () => {
  const store = storePort({
    accessToken: "SECRET-ACCESS",
    refreshToken: "SECRET-REFRESH",
    expiresAt: 1,
    scopes: [...GMAIL_SCOPES],
  });
  const { fetchFn } = scriptedFetch([
    jsonResponse({ error: "invalid_grant", error_description: "SECRET-REFRESH" }, false, 400),
  ]);
  const auth = adapter({ store, fetchFn, authorize: vi.fn(async () => "canned-code"), now: () => 5_000 });

  const refreshError = (await auth.getAccessToken("personal").catch((err: unknown) => err)) as Error;
  expect(refreshError.message).not.toContain("SECRET-ACCESS");
  expect(refreshError.message).not.toContain("SECRET-REFRESH");
  expect(refreshError.message).not.toContain("SECRET-CLIENT-SECRET");

  const missingSecret = adapter({
    store: storePort(),
    fetchFn,
    authorize: vi.fn(async () => "canned-code"),
    env: {},
  });
  const secretError = (await missingSecret.authenticate("personal").catch((err: unknown) => err)) as Error;
  expect(secretError.message).not.toContain("SECRET-CLIENT-SECRET");
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

test("the loopback seam resolves with the code Google redirects back", async () => {
  const redirectUri = `http://127.0.0.1:${await freePort()}`;
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-1";
  let listening: () => void = () => {};
  const listened = new Promise<void>((resolve) => {
    listening = resolve;
  });
  const pending = authorizeWithLoopback(authUrl, redirectUri, {
    open: () => listening(),
    // Generous: the consent cap must not fire while this test is starved by a
    // loaded parallel run, or the server closes mid-`fetch`.
    timeoutMs: 60_000,
  });
  await listened;

  // An unrelated request (e.g. a favicon probe) must not resolve the flow.
  await fetch(`${redirectUri}/favicon.ico`);
  const response = await fetch(`${redirectUri}/?code=abc-123&scope=${encodeURIComponent(GMAIL_SCOPES.join(" "))}`);

  expect(response.status).toBe(200);
  await expect(pending).resolves.toBe("abc-123");
});

test("the loopback seam rejects CONSENT_DENIED when Google redirects an error", async () => {
  const redirectUri = `http://127.0.0.1:${await freePort()}`;
  let listening: () => void = () => {};
  const listened = new Promise<void>((resolve) => {
    listening = resolve;
  });
  const pending = authorizeWithLoopback("https://accounts.google.com/o/oauth2/v2/auth", redirectUri, {
    open: () => listening(),
    timeoutMs: 60_000,
  });
  const settled = pending.catch((err: unknown) => err);
  await listened;

  await fetch(`${redirectUri}/?error=access_denied`);

  const error = await settled;
  expect(error).toBeInstanceOf(GmailConsentError);
  expect((error as GmailConsentError).code).toBe("CONSENT_DENIED");
});

test("the loopback seam times out with the consent URL when nothing arrives", async () => {
  const redirectUri = `http://127.0.0.1:${await freePort()}`;
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-1";
  const pending = authorizeWithLoopback(authUrl, redirectUri, { open: () => {}, timeoutMs: 20 });
  const settled = pending.catch((err: unknown) => err);

  const error = await settled;

  expect(error).toBeInstanceOf(GmailConsentError);
  expect((error as GmailConsentError).code).toBe("CONSENT_TIMEOUT");
  expect((error as GmailConsentError).consentUrl).toBe(authUrl);
});

test("a loopback listener failure is a typed CONSENT_UNAVAILABLE, not a raw socket error", async () => {
  const occupied = createServer();
  const port = await new Promise<number>((resolve) => {
    occupied.listen(0, "127.0.0.1", () => resolve((occupied.address() as AddressInfo).port));
  });

  const pending = authorizeWithLoopback("https://accounts.google.com/o/oauth2/v2/auth", `http://127.0.0.1:${port}`, {
    open: () => {},
    timeoutMs: 500,
  });
  const error = await pending.catch((err: unknown) => err);
  await new Promise<void>((resolve) => occupied.close(() => resolve()));

  expect(error).toBeInstanceOf(GmailConsentError);
  expect((error as GmailConsentError).code).toBe("CONSENT_UNAVAILABLE");
});

test("any loopback failure reaches the caller as a typed GmailAuthError naming the account", async () => {
  const store = storePort();
  const { fetchFn } = scriptedFetch([]);
  const auth = adapter({
    store,
    fetchFn,
    authorize: async () => {
      throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:45967");
    },
  });

  const error = (await auth.authenticate("personal").catch((err: unknown) => err)) as GmailAuthError;

  expect(error).toBeInstanceOf(GmailAuthError);
  expect(error.code).toBe("CONSENT_UNAVAILABLE");
  expect(error.message).toContain("personal");
  expect(store.setCalls).toHaveLength(0);
});

test("getAccessToken on an empty store requires a sign-in and issues no request (AUTH_REQUIRED)", async () => {
  const store = storePort();
  const { fetchFn, requests } = scriptedFetch([]);
  const auth = adapter({ store, fetchFn, authorize: vi.fn(async () => "canned-code") });

  const error = (await auth.getAccessToken("personal").catch((err: unknown) => err)) as GmailAuthError;

  expect(error).toBeInstanceOf(GmailAuthError);
  expect(error.code).toBe("AUTH_REQUIRED");
  expect(error.message).toContain("--auth gmail --account personal");
  expect(requests).toHaveLength(0);
});

test("forceRefresh refreshes even an unexpired cached token", async () => {
  const store = storePort({
    accessToken: "cached-access",
    refreshToken: "cached-refresh",
    expiresAt: 9_999_999,
    scopes: [...GMAIL_SCOPES],
  });
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ access_token: "forced-access", expires_in: 3600 }),
  ]);
  const auth = adapter({ store, fetchFn, authorize: vi.fn(async () => "canned-code"), now: () => 1_000_000 });

  const tokens = await auth.getAccessToken("personal", { forceRefresh: true });

  expect(tokens.accessToken).toBe("forced-access");
  expect(tokens.refreshToken).toBe("cached-refresh");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.params.get("grant_type")).toBe("refresh_token");
  expect(store.setCalls).toHaveLength(1);
});

test("an expired cached token without a refresh token falls through to consent", async () => {
  const store = storePort({ accessToken: "stale-access", expiresAt: 1, scopes: [...GMAIL_SCOPES] });
  const authorize = vi.fn(async () => "canned-code");
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
  ]);
  const auth = adapter({ store, fetchFn, authorize, now: () => 5_000 });

  const tokens = await auth.authenticate("personal");

  expect(authorize).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.params.get("grant_type")).toBe("authorization_code");
  expect(tokens.refreshToken).toBe("new-refresh");
});

test("a CONSENT_UNAVAILABLE from the seam keeps its specific cause and names the account", async () => {
  const store = storePort();
  const { fetchFn } = scriptedFetch([]);
  const auth = adapter({
    store,
    fetchFn,
    authorize: async () => {
      throw new GmailConsentError(
        "CONSENT_UNAVAILABLE",
        "The local sign-in callback could not listen on http://127.0.0.1:45967.",
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-1",
      );
    },
  });

  const error = (await auth.authenticate("personal").catch((err: unknown) => err)) as GmailAuthError;

  expect(error).toBeInstanceOf(GmailAuthError);
  expect(error.code).toBe("CONSENT_UNAVAILABLE");
  expect(error.message).toContain("could not listen on http://127.0.0.1:45967");
  expect(error.message).toContain("personal");
  expect(error.message).toContain("Retry");
  expect(store.setCalls).toHaveLength(0);
});

test("a synchronous throw from the open hook settles the promise instead of escaping", async () => {
  const redirectUri = `http://127.0.0.1:${await freePort()}`;
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-1";
  const pending = authorizeWithLoopback(authUrl, redirectUri, {
    open: () => {
      throw new Error("no browser available");
    },
    timeoutMs: 60_000,
  });

  const error = await pending.catch((err: unknown) => err);

  expect(error).toBeInstanceOf(GmailConsentError);
  expect((error as GmailConsentError).code).toBe("CONSENT_UNAVAILABLE");
  expect((error as GmailConsentError).consentUrl).toBe(authUrl);
});
