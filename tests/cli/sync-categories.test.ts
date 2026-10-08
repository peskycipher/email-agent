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

const M365_LISTS_URL = "https://graph.microsoft.com/v1.0/me/outlook/masterCategories";
const GMAIL_LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";

interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | undefined;
  body: Record<string, unknown> | undefined;
}

function jsonResponse(body: unknown, ok = true, status = 200): FetchResponseLike {
  return { ok, status, json: async () => body };
}

/** Every create, either provider: one POST response carrying the new id. */
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

function cachedToken(provider: string, accountId: string): TokenSet {
  return {
    accessToken: `access-${provider}-${accountId}`,
    refreshToken: `refresh-${provider}-${accountId}`,
    expiresAt: Date.now() + 3_600_000,
    scopes:
      provider === "gmail" ? ["gmail.readonly", "gmail.labels", "gmail.modify"] : ["Mail.ReadWrite", "MailboxSettings.ReadWrite"],
  };
}

function memoryTokenStore(tokens: Record<string, TokenSet>): TokenPort {
  return {
    async get(provider, accountId) {
      const token = tokens[`${provider}:${accountId}`];
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

async function writeAccount(provider: "m365" | "gmail", name: string): Promise<void> {
  const body =
    provider === "m365"
      ? `name: ${name}\nenabled: true\ntenantId: tenant-1\nclientId: client-1\n`
      : `name: ${name}\nenabled: true\nclientId: client-1\nclientSecretEnvVar: GMAIL_SECRET\n`;
  await writeFile(join(configDir, "accounts", provider, `${name}.yaml`), body, "utf8");
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "cli-sync-categories-"));
  await mkdir(join(configDir, "accounts", "m365"), { recursive: true });
  await mkdir(join(configDir, "accounts", "gmail"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
});

test("--sync-categories --account all syncs an m365 and a gmail account, one line each, exit 0 (CLI_ALL)", async () => {
  await writeAccount("m365", "work");
  await writeAccount("gmail", "personal");
  const { fetchFn, requests } = recordingFetch([
    jsonResponse({ value: [] }),
    ...created(11),
    jsonResponse({ labels: [] }),
    ...created(11),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({
        "m365:work": cachedToken("m365", "work"),
        "gmail:personal": cachedToken("gmail", "personal"),
      }),
      configDir,
    },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  const lines = capturedLines(stdout);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe("info work: Ensured 11 categories.\n");
  expect(lines[1]).toBe("info personal: Ensured 11 labels.\n");
  expect(requests).toHaveLength(24);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(22);
  expect(requests[0]?.url).toBe(M365_LISTS_URL);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
  expect(requests[12]?.url).toBe(GMAIL_LABELS_URL);
  expect(requests[12]?.authorization).toBe("Bearer access-gmail-personal");

  const labels = await loadTaxonomy({ configDir });
  expect(requests.slice(1, 12).map((request) => request.body?.["displayName"])).toEqual(
    labels.map((label) => label.name),
  );
  expect(requests[1]?.body).toEqual({ displayName: "Action Needed", color: "preset0" });
  expect(requests.slice(13).map((request) => request.body?.["name"])).toEqual(labels.map((label) => label.name));
  expect(requests[13]?.body).toEqual({
    name: "Action Needed",
    color: { backgroundColor: "#e07798", textColor: "#000000" },
  });
});

test("--account all keeps going after an account fails and exits 1 with a per-provider counted line (ISOLATION)", async () => {
  await writeAccount("m365", "work");
  await writeAccount("gmail", "personal");
  const { fetchFn, requests } = recordingFetch([jsonResponse({ value: [] }), ...created(11)]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("m365", "work") }), configDir },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(12);
  expect(capturedLines(stdout).join("")).toContain("work: Ensured 11 categories.");
  expect(capturedLines(stdout).join("")).not.toContain("personal");
  expect(capturedLines(stderr).join("")).toContain("personal: ");
  expect(capturedLines(stderr).join("")).toContain("--auth gmail --account personal");
  expect(capturedLines(stderr).join("")).toContain("1 of 1 gmail account(s) failed.");
});

test("--account all reports a malformed settings file with its provider and exits 1", async () => {
  await writeAccount("m365", "work");
  await writeFile(join(configDir, "accounts", "m365", "b.yaml"), "name: [unclosed", "utf8");
  await writeAccount("gmail", "personal");
  const { fetchFn, requests } = recordingFetch([
    jsonResponse({ value: [] }),
    ...created(11),
    jsonResponse({ labels: [] }),
    ...created(11),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({
        "m365:work": cachedToken("m365", "work"),
        "gmail:personal": cachedToken("gmail", "personal"),
      }),
      configDir,
    },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(24);
  expect(capturedLines(stdout).join("")).toContain("work: Ensured 11 categories.");
  expect(capturedLines(stdout).join("")).toContain("personal: Ensured 11 labels.");
  expect(capturedLines(stderr).join("")).toContain("m365 b:");
  expect(capturedLines(stderr).join("")).toContain("1 of 2 m365 account(s) failed.");
});

test("--account all with no enabled accounts exits 1 with a hint naming both providers", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories({ account: "all" }, { fetchFn, tokenStore: memoryTokenStore({}), configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("No enabled m365 or gmail accounts found");
  expect(errors).toContain("~/.config/email-classify/accounts/m365/<name>.yaml");
  expect(errors).toContain("~/.config/email-classify/accounts/gmail/<name>.yaml");
});

test("--account <name> routes to the provider that has it and logs through the injected LogPort", async () => {
  await writeAccount("gmail", "personal");
  const { fetchFn, requests } = recordingFetch([jsonResponse({ labels: [] }), ...created(11)]);
  const log = recordingLogPort();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "personal" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedToken("gmail", "personal") }),
      configDir,
      logPort: log.logPort,
    },
  );

  expect(code).toBe(0);
  expect(requests).toHaveLength(12);
  expect(requests[0]?.url).toBe(GMAIL_LABELS_URL);
  expect(capturedLines(stdout)).toHaveLength(0);
  expect(log.entries).toEqual([
    { level: "info", message: "Ensured 11 labels.", context: { accountId: "personal" } },
  ]);
});

test("--account <name> enabled in both providers is synced through both adapters", async () => {
  await writeAccount("m365", "work");
  await writeAccount("gmail", "work");
  const { fetchFn, requests } = recordingFetch([
    jsonResponse({ value: [] }),
    ...created(11),
    jsonResponse({ labels: [] }),
    ...created(11),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "work" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({
        "m365:work": cachedToken("m365", "work"),
        "gmail:work": cachedToken("gmail", "work"),
      }),
      configDir,
    },
  );

  expect(code).toBe(0);
  expect(requests.slice(0, 12).every((request) => request.url === M365_LISTS_URL)).toBe(true);
  expect(requests.slice(12).every((request) => request.url === GMAIL_LABELS_URL)).toBe(true);
  expect(capturedLines(stdout)).toEqual([
    "info work: Ensured 11 categories.\n",
    "info work: Ensured 11 labels.\n",
  ]);
});

test("--account <name> in neither provider's listing exits 1 with the setup hint", async () => {
  await writeAccount("m365", "work");
  const { fetchFn, requests } = recordingFetch([]);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "ghost" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("m365", "work") }), configDir },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain('No enabled m365 or gmail account named "ghost" found');
  expect(errors).toContain("accounts/m365/ghost.yaml");
  expect(errors).toContain("accounts/gmail/ghost.yaml");
});

test("--account <name> with no stored token exits 1 and names the account and its provider", async () => {
  await writeAccount("m365", "work");
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
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("m365", "work") }),
      configDir,
      taxonomyPath: join(configDir, "missing-taxonomy.yaml"),
    },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stderr).join("")).toContain("missing-taxonomy.yaml");
});

test("--account all still syncs the other provider when one listing throws", async () => {
  // A file where the m365 accounts directory belongs makes its listing throw ENOTDIR.
  await rm(join(configDir, "accounts", "m365"), { recursive: true, force: true });
  await writeFile(join(configDir, "accounts", "m365"), "not a directory", "utf8");
  await writeAccount("gmail", "personal");
  const { fetchFn, requests } = recordingFetch([jsonResponse({ labels: [] }), ...created(11)]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "gmail:personal": cachedToken("gmail", "personal") }), configDir },
  );

  expect(code).toBe(1);
  expect(capturedLines(stderr).join("")).toContain("m365:");
  expect(capturedLines(stdout).join("")).toContain("personal: Ensured 11 labels.");
  expect(requests).toHaveLength(12);
  expect(requests[0]?.url).toBe(GMAIL_LABELS_URL);
});

test("--account <name> syncs the healthy provider when the other reports a settings error", async () => {
  await writeAccount("m365", "work");
  // The same name exists under gmail but its settings file is malformed.
  await writeFile(join(configDir, "accounts", "gmail", "work.yaml"), "name: [unclosed", "utf8");
  const { fetchFn, requests } = recordingFetch([jsonResponse({ value: [] }), ...created(11)]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runSyncCategories(
    { account: "work" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("m365", "work") }), configDir },
  );

  expect(code).toBe(1);
  expect(capturedLines(stderr).join("")).toContain("gmail work:");
  expect(capturedLines(stdout).join("")).toContain("work: Ensured 11 categories.");
  expect(requests).toHaveLength(12);
  expect(requests[0]?.url).toBe(M365_LISTS_URL);
});
