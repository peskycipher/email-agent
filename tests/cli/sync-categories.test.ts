import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaxonomy } from "../../src/adapters/config/taxonomy.js";
import type { FetchLike, FetchResponseLike } from "../../src/adapters/m365/M365AuthAdapter.js";
import { runSyncCategories } from "../../src/cli/commands/sync-categories.js";
import type { TokenSet } from "../../src/core/dto/TokenSet.js";
import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";
import type { TokenPort } from "../../src/core/ports/TokenPort.js";

const LISTS_URL = "https://graph.microsoft.com/v1.0/me/outlook/masterCategories";

interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | undefined;
  body: Record<string, unknown> | undefined;
}

function jsonResponse(body: unknown, ok = true, status = 200): FetchResponseLike {
  return { ok, status, json: async () => body };
}

function created(count: number): FetchResponseLike[] {
  return Array.from({ length: count }, () => jsonResponse({ id: "created" }, true, 201));
}

function recordingFetch(responses: FetchResponseLike[]): {
  fetchFn: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      authorization: init.headers["authorization"],
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetchFn, requests };
}

function cachedToken(accountId: string): TokenSet {
  return {
    accessToken: `access-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 3_600_000,
    scopes: ["Mail.ReadWrite", "MailboxSettings.ReadWrite"],
  };
}

function memoryTokenStore(tokens: Record<string, TokenSet>): TokenPort {
  return {
    async get(_provider, accountId) {
      const token = tokens[accountId];
      if (token) return token;
      const error = new Error(`No stored token for account "${accountId}".`) as Error & { code: string };
      error.name = "TokenStoreError";
      error.code = "TOKEN_NOT_FOUND";
      throw error;
    },
    async set() {},
    async delete() {},
  };
}

function capturedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

function recordingLogPort(): { logPort: LogPort; entries: Array<{ level: string; message: string; context?: LogContext }> } {
  const entries: Array<{ level: string; message: string; context?: LogContext }> = [];
  const record = (level: string) => (message: string, context?: LogContext) => {
    entries.push({ level, message, ...(context === undefined ? {} : { context }) });
  };
  return {
    entries,
    logPort: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
  };
}

async function writeAccount(name: string): Promise<void> {
  await writeFile(
    join(configDir, "accounts", "m365", `${name}.yaml`),
    `name: ${name}\nenabled: true\ntenantId: tenant-1\nclientId: client-1\n`,
    "utf8",
  );
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "cli-sync-categories-"));
  await mkdir(join(configDir, "accounts", "m365"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
});

test("--sync-categories --account all syncs both accounts, one line each, exit 0 (CLI_ALL)", async () => {
  await writeAccount("work");
  await writeAccount("home");
  const { fetchFn, requests } = recordingFetch([
    jsonResponse({ value: [] }),
    ...created(11),
    jsonResponse({ value: [] }),
    ...created(11),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ home: cachedToken("home"), work: cachedToken("work") }), configDir },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  const lines = capturedLines(stdout);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe("info home: Ensured 11 categories.\n");
  expect(lines[1]).toBe("info work: Ensured 11 categories.\n");
  expect(requests).toHaveLength(24);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(22);
  expect(requests[0]?.authorization).toBe("Bearer access-home");
  expect(requests[12]?.authorization).toBe("Bearer access-work");
  const labels = await loadTaxonomy({ configDir });
  expect(requests.slice(1, 12).map((request) => request.body?.["displayName"])).toEqual(
    labels.map((label) => label.name),
  );
  expect(requests[1]?.body).toEqual({ displayName: "Action Needed", color: "preset0" });
});

test("--account all keeps going after an account fails and exits 1 with a counted line (ISOLATION)", async () => {
  await writeAccount("work");
  await writeAccount("home");
  const { fetchFn, requests } = recordingFetch([jsonResponse({ value: [] }), ...created(11)]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ work: cachedToken("work") }), configDir },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(12);
  expect(capturedLines(stdout).join("")).toContain("work: Ensured 11 categories.");
  expect(capturedLines(stderr).join("")).toContain("home: ");
  expect(capturedLines(stderr).join("")).toContain("--auth m365 --account home");
  expect(capturedLines(stderr).join("")).toContain("1 of 2 m365 account(s) failed.");
});

test("--account all reports a malformed settings file and exits 1", async () => {
  await writeAccount("work");
  await writeFile(join(configDir, "accounts", "m365", "b.yaml"), "name: [unclosed", "utf8");
  const { fetchFn, requests } = recordingFetch([jsonResponse({ value: [] }), ...created(11)]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ work: cachedToken("work") }), configDir },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(12);
  expect(capturedLines(stdout).join("")).toContain("work: Ensured 11 categories.");
  expect(capturedLines(stderr).join("")).toContain("m365 b:");
  expect(capturedLines(stderr).join("")).toContain("1 of 2 m365 account(s) failed.");
});

test("--account all with no enabled accounts exits 1 with the setup hint", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories({ account: "all" }, { fetchFn, tokenStore: memoryTokenStore({}), configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  expect(capturedLines(stderr).join("")).toContain("No enabled m365 accounts found");
  expect(capturedLines(stderr).join("")).toContain("~/.config/email-classify/accounts/m365/<name>.yaml");
});

test("--account <name> logs through the injected LogPort and exits 0", async () => {
  const { fetchFn, requests } = recordingFetch([jsonResponse({ value: [] }), ...created(11)]);
  const log = recordingLogPort();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "work" },
    { fetchFn, tokenStore: memoryTokenStore({ work: cachedToken("work") }), configDir, logPort: log.logPort },
  );

  expect(code).toBe(0);
  expect(requests).toHaveLength(12);
  expect(requests[0]?.url).toBe(LISTS_URL);
  expect(capturedLines(stdout)).toHaveLength(0);
  expect(log.entries).toEqual([
    { level: "info", message: "Ensured 11 categories.", context: { accountId: "work" } },
  ]);
});

test("--account <name> with no stored token exits 1 and names the account", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "work" },
    { fetchFn, tokenStore: memoryTokenStore({}), configDir },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stderr).join("")).toContain("work: ");
  expect(capturedLines(stderr).join("")).toContain("--auth m365 --account work");
});

test("a taxonomy load failure exits 1 before any network call", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ work: cachedToken("work") }),
      configDir,
      taxonomyPath: join(configDir, "missing-taxonomy.yaml"),
    },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stderr).join("")).toContain("missing-taxonomy.yaml");
});
