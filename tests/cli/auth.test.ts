import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticateAccounts, runAuth, type AccountAuthOutcome } from "../../src/cli/commands/auth.js";
import { GMAIL_SCOPES, type FetchLike, type FetchResponseLike } from "../../src/adapters/gmail/GmailAuthAdapter.js";
import type { TokenSet } from "../../src/core/dto/TokenSet.js";
import type { TokenPort } from "../../src/core/ports/TokenPort.js";

function jsonResponse(body: unknown, ok = true, status = 200): FetchResponseLike {
  return { ok, status, json: async () => body };
}

function scriptedFetch(responses: FetchResponseLike[]): FetchLike {
  return async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
}

function memoryStore(): {
  port: TokenPort;
  setCalls: Array<{ provider: string; accountId: string; tokens: TokenSet }>;
} {
  const setCalls: Array<{ provider: string; accountId: string; tokens: TokenSet }> = [];
  const port: TokenPort = {
    async get() {
      const notFound = new Error("No stored token.") as Error & { code: string };
      notFound.name = "TokenStoreError";
      notFound.code = "TOKEN_NOT_FOUND";
      throw notFound;
    },
    async set(provider, accountId, tokens) {
      setCalls.push({ provider, accountId, tokens });
    },
    async delete() {},
  };
  return { port, setCalls };
}

function capturedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "cli-auth-"));
  await mkdir(join(configDir, "accounts", "gmail"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
});

test("a failing account does not abort a multi-account run (I/O matrix row 8)", async () => {
  const attempted: string[] = [];
  const adapter = {
    async authenticate(account: string) {
      attempted.push(account);
      if (account === "b") throw new Error("token store unavailable");
      return { scopes: ["gmail.readonly", "gmail.labels", "gmail.modify"] };
    },
  };
  const outcomes: AccountAuthOutcome[] = [];

  const failures = await authenticateAccounts(adapter, "gmail", ["a", "b", "c"], (outcome) =>
    outcomes.push(outcome),
  );

  expect(attempted).toEqual(["a", "b", "c"]);
  expect(failures).toBe(1);
  expect(outcomes).toHaveLength(3);
  expect(outcomes.map((outcome) => [outcome.account, outcome.ok])).toEqual([
    ["a", true],
    ["b", false],
    ["c", true],
  ]);
  expect(outcomes[0]?.line).toContain("gmail a: authenticated");
  expect(outcomes[1]?.line).toContain("gmail b: FAILED");
});

test("runAuth rejects an unknown provider", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runAuth({ provider: "yahoo", account: "work" });

  expect(code).toBe(1);
  expect(capturedLines(stderr)[0]).toContain('Unknown auth provider "yahoo"');
});

test("runAuth dispatches gmail, exchanges a canned code and prints exactly one success line (HAPPY_PATH)", async () => {
  await writeFile(
    join(configDir, "accounts", "gmail", "personal.yaml"),
    "name: personal\nenabled: true\nclientId: client-1\nclientSecretEnvVar: GMAIL_SECRET\n",
    "utf8",
  );
  const store = memoryStore();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runAuth(
    { provider: "gmail", account: "personal" },
    {
      fetchFn: scriptedFetch([
        jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
      ]),
      authorize: async () => "canned-code",
      tokenStore: store.port,
      env: { GMAIL_SECRET: "client-secret" },
      configDir,
    },
  );

  expect(code).toBe(0);
  expect(store.setCalls).toHaveLength(1);
  expect(store.setCalls[0]?.provider).toBe("gmail");
  expect(store.setCalls[0]?.accountId).toBe("personal");
  expect(store.setCalls[0]?.tokens.accessToken).toBe("access-1");
  expect(store.setCalls[0]?.tokens.refreshToken).toBe("refresh-1");
  expect(store.setCalls[0]?.tokens.scopes).toEqual([...GMAIL_SCOPES]);
  const successLines = capturedLines(stdout).filter((line) => line.includes("authenticated"));
  expect(successLines).toHaveLength(1);
  expect(successLines[0]).toContain("gmail personal: authenticated");
  expect(successLines[0]).toContain(GMAIL_SCOPES.join(", "));
  expect(capturedLines(stderr)).toHaveLength(0);
});

test("--account all keeps going after a malformed gmail file and exits 1 (ALL_ENABLED)", async () => {
  await writeFile(
    join(configDir, "accounts", "gmail", "a.yaml"),
    "name: a\nenabled: true\nclientId: client-1\nclientSecretEnvVar: GMAIL_SECRET\n",
    "utf8",
  );
  await writeFile(join(configDir, "accounts", "gmail", "b.yaml"), "name: [unclosed", "utf8");
  const store = memoryStore();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runAuth(
    { provider: "gmail", account: "all" },
    {
      fetchFn: scriptedFetch([
        jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
      ]),
      authorize: async () => "canned-code",
      tokenStore: store.port,
      env: { GMAIL_SECRET: "client-secret" },
      configDir,
    },
  );

  expect(code).toBe(1);
  expect(store.setCalls.map((call) => call.accountId)).toEqual(["a"]);
  expect(capturedLines(stdout).join("")).toContain("gmail a: authenticated");
  expect(capturedLines(stderr).join("")).toContain("gmail b:");
  expect(capturedLines(stderr).join("")).toContain("1 of 2 gmail account(s) failed.");
});

test("--account all with only invalid files reports them and exits 1", async () => {
  await writeFile(join(configDir, "accounts", "gmail", "b.yaml"), "name: [unclosed", "utf8");
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runAuth(
    { provider: "gmail", account: "all" },
    {
      fetchFn: scriptedFetch([]),
      authorize: async () => "canned-code",
      tokenStore: memoryStore().port,
      env: { GMAIL_SECRET: "client-secret" },
      configDir,
    },
  );

  expect(code).toBe(1);
  expect(capturedLines(stderr).join("")).toContain("gmail b:");
  expect(capturedLines(stderr).join("")).toContain("1 gmail account(s) have invalid settings");
  expect(capturedLines(stdout)).toHaveLength(0);
});

test("--account all reports a directory that cannot be listed and exits 1", async () => {
  await rm(join(configDir, "accounts", "gmail"), { recursive: true, force: true });
  await writeFile(join(configDir, "accounts", "gmail"), "not a directory", "utf8");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runAuth(
    { provider: "gmail", account: "all" },
    { fetchFn: scriptedFetch([]), tokenStore: memoryStore().port, configDir },
  );

  expect(code).toBe(1);
  expect(capturedLines(stderr).join("")).toContain("gmail:");
});

test("runAuth still dispatches m365 and keeps the m365 prefix", async () => {
  await mkdir(join(configDir, "accounts", "m365"), { recursive: true });
  await writeFile(
    join(configDir, "accounts", "m365", "work.yaml"),
    "name: work\nenabled: true\ntenantId: tenant-1\nclientId: client-1\n",
    "utf8",
  );
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const store = memoryStore();

  const code = await runAuth(
    { provider: "m365", account: "work" },
    {
      tokenStore: store.port,
      configDir,
      fetchFn: scriptedFetch([
        jsonResponse({
          device_code: "dev-1",
          user_code: "CODE-1",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 900,
          interval: 1,
        }),
        jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
      ]),
    },
  );

  expect(code).toBe(0);
  expect(store.setCalls.map((call) => [call.provider, call.accountId])).toContainEqual(["m365", "work"]);
  expect(capturedLines(stdout).join("")).toContain("m365 work: authenticated");
});
