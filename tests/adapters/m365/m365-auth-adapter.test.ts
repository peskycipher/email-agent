import { expect, test, vi } from "vitest";
import {
  M365AuthAdapter,
  M365AuthError,
  M365_SCOPES,
  type FetchLike,
  type FetchResponseLike,
} from "../../../src/adapters/m365/M365AuthAdapter.js";
import type { TokenSet } from "../../../src/core/dto/TokenSet.js";
import type { TokenPort } from "../../../src/core/ports/TokenPort.js";

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
  getCalls: string[];
  setCalls: Array<{ accountId: string; tokens: TokenSet }>;
} {
  let current = initial;
  const getCalls: string[] = [];
  const setCalls: Array<{ accountId: string; tokens: TokenSet }> = [];
  const port: TokenPort = {
    async get(_provider, accountId) {
      getCalls.push(accountId);
      if (current) return current;
      const notFound = new Error("No stored token.") as Error & { code: string };
      notFound.name = "TokenStoreError";
      notFound.code = "TOKEN_NOT_FOUND";
      throw notFound;
    },
    async set(_provider, accountId, tokens) {
      current = tokens;
      setCalls.push({ accountId, tokens });
    },
    async delete() {},
  };
  return { port, getCalls, setCalls };
}

function settingsReader(): ReturnType<typeof vi.fn> {
  return vi.fn(async (accountName: string) => ({
    name: accountName,
    enabled: true,
    tenantId: "tenant-1",
    clientId: "client-1",
  }));
}

const DEVICE_CODE = {
  device_code: "device-code-1",
  user_code: "USER-CODE",
  verification_uri: "https://microsoft.com/devicelogin",
  expires_in: 900,
  interval: 5,
};

test("happy path persists both AC scopes through TokenPort", async () => {
  const store = storePort();
  const read = settingsReader();
  const onDeviceCode = vi.fn();
  let clock = 1_000_000;
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse(DEVICE_CODE),
    jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    onDeviceCode,
  });

  const result = await adapter.authenticate("work");

  expect(result.scopes).toEqual(["Mail.ReadWrite", "MailboxSettings.ReadWrite"]);
  expect(result.accessToken).toBe("access-1");
  expect(result.refreshToken).toBe("refresh-1");
  expect(result.expiresAt).toBe(clock + 3_600_000);
  expect(store.setCalls).toHaveLength(1);
  expect(store.setCalls[0]?.accountId).toBe("work");
  expect(read).toHaveBeenCalledWith("work");
  expect(onDeviceCode).toHaveBeenCalledWith({
    accountName: "work",
    userCode: "USER-CODE",
    verificationUri: "https://microsoft.com/devicelogin",
  });
  expect(requests[0]?.url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/devicecode");
  expect(requests[0]?.params.get("client_id")).toBe("client-1");
  expect(requests[0]?.params.get("scope")).toBe(M365_SCOPES.join(" "));
  expect(requests[1]?.url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
  expect(requests[1]?.params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
});

test("times out after 5 minutes even when the device code says 15", async () => {
  const store = storePort();
  let clock = 0;
  const pending = () => jsonResponse({ error: "authorization_pending" }, false, 400);
  const { fetchFn } = scriptedFetch([
    jsonResponse(DEVICE_CODE),
    ...Array.from({ length: 200 }, pending),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read: settingsReader() },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  const error = await adapter.authenticate("work").catch((err: unknown) => err);

  expect(error).toBeInstanceOf(M365AuthError);
  expect((error as M365AuthError).code).toBe("DEVICE_CODE_TIMEOUT");
  expect((error as M365AuthError).verificationUri).toBe("https://microsoft.com/devicelogin");
  expect((error as Error).message).toContain("https://microsoft.com/devicelogin");
  expect(clock).toBe(300_000);
  expect(store.setCalls).toHaveLength(0);
});

test("rejects an invalid account name before touching the store or settings", async () => {
  const store = storePort();
  const read = settingsReader();
  const { fetchFn } = scriptedFetch([]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read },
  });

  const error = await adapter.authenticate("Work!").catch((err: unknown) => err);

  expect(error).toBeInstanceOf(M365AuthError);
  expect((error as M365AuthError).code).toBe("INVALID_ACCOUNT_NAME");
  expect((error as Error).message).toContain("^[a-z0-9]");
  expect(store.getCalls).toHaveLength(0);
  expect(read).not.toHaveBeenCalled();
});

test("reuses an unexpired cached token without any HTTP request", async () => {
  const cached: TokenSet = {
    accessToken: "cached-access",
    refreshToken: "cached-refresh",
    expiresAt: 2_000,
    scopes: [...M365_SCOPES],
  };
  const store = storePort(cached);
  const { fetchFn, requests } = scriptedFetch([]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read: settingsReader() },
    now: () => 1_000,
  });

  expect(await adapter.getAccessToken("work")).toEqual(cached);
  expect(await adapter.authenticate("work")).toEqual(cached);
  expect(requests).toHaveLength(0);
});

test("silently refreshes an expired token and re-persists it", async () => {
  const expired: TokenSet = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    scopes: [...M365_SCOPES],
  };
  const store = storePort(expired);
  const clock = 5_000;
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read: settingsReader() },
    now: () => clock,
  });

  const refreshed = await adapter.getAccessToken("work");

  expect(refreshed).toEqual({
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: clock + 3_600_000,
    scopes: ["Mail.ReadWrite", "MailboxSettings.ReadWrite"],
  });
  expect(store.setCalls).toHaveLength(1);
  expect(store.setCalls[0]?.tokens).toEqual(refreshed);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
  expect(requests[0]?.params.get("grant_type")).toBe("refresh_token");
  expect(requests[0]?.params.get("refresh_token")).toBe("old-refresh");
  expect(requests[0]?.params.get("client_id")).toBe("client-1");
});

test("authenticate refreshes an expired token instead of re-prompting", async () => {
  const expired: TokenSet = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    scopes: [...M365_SCOPES],
  };
  const store = storePort(expired);
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ access_token: "new-access", expires_in: 3600 }),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read: settingsReader() },
    now: () => 5_000,
  });

  const refreshed = await adapter.authenticate("work");

  expect(refreshed.accessToken).toBe("new-access");
  // The retained refresh token is carried over when Microsoft does not rotate it.
  expect(refreshed.refreshToken).toBe("old-refresh");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.params.get("grant_type")).toBe("refresh_token");
});

test("an invalid_grant tells the user to re-run auth for that account", async () => {
  const store = storePort({
    accessToken: "SECRET-ACCESS",
    refreshToken: "SECRET-REFRESH",
    expiresAt: 1,
    scopes: [...M365_SCOPES],
  });
  const { fetchFn } = scriptedFetch([jsonResponse({ error: "invalid_grant" }, false, 400)]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read: settingsReader() },
    now: () => 5_000,
  });

  const error = (await adapter.getAccessToken("work").catch((err: unknown) => err)) as M365AuthError;

  expect(error).toBeInstanceOf(M365AuthError);
  expect(error.code).toBe("AUTH_REQUIRED");
  expect(error.message).toContain("--auth m365 --account work");
});

test("no error message ever contains token material", async () => {
  const store = storePort({
    accessToken: "SECRET-ACCESS",
    refreshToken: "SECRET-REFRESH",
    expiresAt: 1,
    scopes: [...M365_SCOPES],
  });
  const { fetchFn } = scriptedFetch([
    jsonResponse({ error: "invalid_grant", error_description: "SECRET-REFRESH" }, false, 400),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read: settingsReader() },
    now: () => 5_000,
  });

  const error = (await adapter.getAccessToken("work").catch((err: unknown) => err)) as Error;

  expect(error.message).not.toContain("SECRET-ACCESS");
  expect(error.message).not.toContain("SECRET-REFRESH");
});

test("getAccessToken with no cached token requires a fresh sign-in", async () => {
  const store = storePort();
  const { fetchFn, requests } = scriptedFetch([]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read: settingsReader() },
  });

  const error = (await adapter.getAccessToken("work").catch((err: unknown) => err)) as M365AuthError;

  expect(error).toBeInstanceOf(M365AuthError);
  expect(error.code).toBe("AUTH_REQUIRED");
  expect(error.message).toContain("--auth m365 --account work");
  expect(requests).toHaveLength(0);
});

test("a rejected refresh token re-prompts with device code", async () => {
  const store = storePort({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    scopes: [...M365_SCOPES],
  });
  const onDeviceCode = vi.fn();
  let clock = 10_000;
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ error: "invalid_grant" }, false, 400),
    jsonResponse(DEVICE_CODE),
    jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read: settingsReader() },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    onDeviceCode,
  });

  const result = await adapter.authenticate("work");

  expect(result.accessToken).toBe("new-access");
  expect(onDeviceCode).toHaveBeenCalledTimes(1);
  expect(requests[0]?.params.get("grant_type")).toBe("refresh_token");
  expect(requests[1]?.url).toContain("/devicecode");
});

test("forceRefresh refreshes even an unexpired cached token", async () => {
  const cached: TokenSet = {
    accessToken: "cached-access",
    refreshToken: "cached-refresh",
    expiresAt: 9_999_999,
    scopes: [...M365_SCOPES],
  };
  const store = storePort(cached);
  const { fetchFn, requests } = scriptedFetch([
    jsonResponse({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read: settingsReader() },
    now: () => 5_000,
  });

  const token = await adapter.getAccessToken("work", { forceRefresh: true });

  expect(token.accessToken).toBe("rotated-access");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.params.get("grant_type")).toBe("refresh_token");
});

test("a transient refresh failure surfaces instead of re-prompting", async () => {
  const store = storePort({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    scopes: [...M365_SCOPES],
  });
  const onDeviceCode = vi.fn();
  const { fetchFn } = scriptedFetch([jsonResponse({ error: "temporarily_unavailable" }, false, 503)]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: store.port,
    accountSettings: { read: settingsReader() },
    now: () => 5_000,
    onDeviceCode,
  });

  const error = (await adapter.authenticate("work").catch((err: unknown) => err)) as M365AuthError;

  expect(error.code).toBe("TOKEN_REQUEST_FAILED");
  expect(onDeviceCode).not.toHaveBeenCalled();
});

test("slow_down increases the poll interval", async () => {
  const slept: number[] = [];
  const { fetchFn } = scriptedFetch([
    jsonResponse(DEVICE_CODE),
    jsonResponse({ error: "slow_down" }, false, 400),
    jsonResponse({ access_token: "access-1", expires_in: 3600 }),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: storePort().port,
    accountSettings: { read: settingsReader() },
    sleep: async (ms) => {
      slept.push(ms);
    },
  });

  await adapter.authenticate("work");

  expect(slept).toEqual([5_000, 10_000]);
});

test("an expired_token poll response produces a device-code timeout", async () => {
  const { fetchFn } = scriptedFetch([
    jsonResponse(DEVICE_CODE),
    jsonResponse({ error: "expired_token" }, false, 400),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: storePort().port,
    accountSettings: { read: settingsReader() },
    sleep: async () => {},
  });

  const error = (await adapter.authenticate("work").catch((err: unknown) => err)) as M365AuthError;

  expect(error.code).toBe("DEVICE_CODE_TIMEOUT");
});

test("a declined sign-in produces DEVICE_CODE_DENIED", async () => {
  const { fetchFn } = scriptedFetch([
    jsonResponse(DEVICE_CODE),
    jsonResponse({ error: "authorization_declined" }, false, 400),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: storePort().port,
    accountSettings: { read: settingsReader() },
    sleep: async () => {},
  });

  const error = (await adapter.authenticate("work").catch((err: unknown) => err)) as M365AuthError;

  expect(error.code).toBe("DEVICE_CODE_DENIED");
});

test("an unexpected poll error produces TOKEN_REQUEST_FAILED", async () => {
  const { fetchFn } = scriptedFetch([
    jsonResponse(DEVICE_CODE),
    jsonResponse({ error: "server_error" }, false, 500),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: storePort().port,
    accountSettings: { read: settingsReader() },
    sleep: async () => {},
  });

  const error = (await adapter.authenticate("work").catch((err: unknown) => err)) as M365AuthError;

  expect(error.code).toBe("TOKEN_REQUEST_FAILED");
});

test("a rejected device-code request produces DEVICE_CODE_REQUEST_FAILED", async () => {
  const { fetchFn } = scriptedFetch([jsonResponse({ error: "invalid_client" }, false, 400)]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: storePort().port,
    accountSettings: { read: settingsReader() },
  });

  const error = (await adapter.authenticate("work").catch((err: unknown) => err)) as M365AuthError;

  expect(error.code).toBe("DEVICE_CODE_REQUEST_FAILED");
});

test("a device-code response without a verification URL is rejected", async () => {
  const { fetchFn } = scriptedFetch([
    jsonResponse({ device_code: "device-code-1", user_code: "USER-CODE", expires_in: 900, interval: 5 }),
  ]);
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore: storePort().port,
    accountSettings: { read: settingsReader() },
  });

  const error = (await adapter.authenticate("work").catch((err: unknown) => err)) as M365AuthError;

  expect(error.code).toBe("DEVICE_CODE_REQUEST_FAILED");
});
