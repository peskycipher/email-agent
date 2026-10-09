import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike, FetchResponseLike } from "../../src/adapters/m365/M365AuthAdapter.js";
import { runBackfill } from "../../src/cli/commands/backfill.js";
import type { TokenSet } from "../../src/core/dto/TokenSet.js";
import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";
import type { TokenPort } from "../../src/core/ports/TokenPort.js";

const FOLDER_MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/mailFolders";

interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | undefined;
}

function jsonResponse(body: unknown, ok = true, status = 200): FetchResponseLike {
  return { ok, status, json: async () => body };
}

function graphPage(ids: string[]): FetchResponseLike {
  return jsonResponse({
    value: ids.map((id) => ({
      id,
      internetMessageId: `<${id}@example.com>`,
      subject: `Subject ${id}`,
      bodyPreview: `Preview ${id}`,
      receivedDateTime: "2026-10-09T12:34:56Z",
      categories: [],
      isRead: false,
      from: { emailAddress: { address: `${id}@example.com`, name: `Sender ${id}` } },
    })),
  });
}

function recordingFetch(responses: FetchResponseLike[]): {
  fetchFn: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, authorization: init.headers["authorization"] });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetchFn, requests };
}

function cachedToken(accountId: string): TokenSet {
  return {
    accessToken: `access-m365-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 3_600_000,
    scopes: ["Mail.ReadWrite", "MailboxSettings.ReadWrite"],
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

function recordingLogPort(): {
  logPort: LogPort;
  entries: Array<{ level: string; message: string; context?: LogContext }>;
} {
  const entries: Array<{ level: string; message: string; context?: LogContext }> = [];
  const record = (level: string) => (message: string, context?: LogContext) => {
    entries.push({ level, message, ...(context === undefined ? {} : { context }) });
  };
  return {
    entries,
    logPort: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
  };
}

async function writeAccount(name: string, extra = ""): Promise<void> {
  const body = `name: ${name}\nenabled: true\ntenantId: tenant-1\nclientId: client-1\n${extra}`;
  await writeFile(join(configDir, "accounts", "m365", `${name}.yaml`), body, "utf8");
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "cli-backfill-"));
  await mkdir(join(configDir, "accounts", "m365"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
});

test("--backfill --account all fetches every enabled account, one count line each, exit 0", async () => {
  await writeAccount("work");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  expect(capturedLines(stdout)).toEqual([
    "info work: Fetched 2 messages.\n",
    "Fetched 2 message(s) from 1 account(s).\n",
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("GET");
  // The orchestrator always names a folder, so the default account fetches Inbox.
  expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Inbox/messages?`)).toBe(true);
  expect(requests[0]?.url).toContain("$top=50");
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
});

test("--account all keeps going after an account fails and exits 1 with a counted line (MULTI_ACCOUNT)", async () => {
  await writeAccount("alpha");
  await writeAccount("beta");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:beta": cachedToken("beta") }), configDir },
  );

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("alpha: ");
  expect(errors).toContain("--auth m365 --account alpha");
  expect(errors).toContain("1 of 2 m365 account(s) failed.");
  expect(capturedLines(stdout).join("")).toContain("info beta: Fetched 2 messages.");
  // The summary counts the account that fetched, not the two that were selected.
  expect(capturedLines(stdout).join("")).toContain("Fetched 2 message(s) from 1 account(s).");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-beta");
});

test("one account's folders and batchSize drive one request per folder (MULTI_FOLDER)", async () => {
  await writeAccount("work", "folders:\n  - Inbox\n  - Archive\nbatchSize: 100\n");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), graphPage(["m2", "m3"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir },
  );

  expect(code).toBe(0);
  expect(requests).toHaveLength(2);
  expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Inbox/messages?`)).toBe(true);
  expect(requests[1]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Archive/messages?`)).toBe(true);
  expect(requests.every((request) => request.url.includes("$top=100"))).toBe(true);
  expect(capturedLines(stdout).join("")).toContain("info work: Fetched 3 messages.");
  expect(capturedLines(stdout).join("")).toContain("Fetched 3 message(s) from 1 account(s).");
});

test("--account <name> fetches only the named account and logs through the injected LogPort", async () => {
  await writeAccount("work");
  await writeAccount("other");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
  const log = recordingLogPort();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "work" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, logPort: log.logPort },
  );

  expect(code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
  expect(log.entries).toEqual([
    { level: "info", message: "Fetched 1 messages.", context: { accountId: "work" } },
  ]);
  expect(capturedLines(stdout)).toEqual(["Fetched 1 message(s) from 1 account(s).\n"]);
});

test("--account all with no enabled m365 account exits 1 with the setup hint (NO_ACCOUNTS)", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill({ source: "m365", account: "all" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("No enabled m365 accounts found");
  expect(errors).toContain("~/.config/email-classify/accounts/m365/<name>.yaml");
});

test("--account <name> with no such account exits 1 with the named hint", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill({ source: "m365", account: "ghost" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain('No enabled m365 account named "ghost" found');
  expect(errors).toContain("accounts/m365/ghost.yaml");
});

test("--account all reports a malformed settings file and exits 1", async () => {
  await writeAccount("work");
  await writeFile(join(configDir, "accounts", "m365", "broken.yaml"), "name: [unclosed", "utf8");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir },
  );

  expect(code).toBe(1);
  expect(capturedLines(stderr).join("")).toContain("m365 broken:");
  expect(capturedLines(stderr).join("")).toContain("1 of 2 m365 account(s) failed.");
  expect(capturedLines(stdout).join("")).toContain("work: Fetched 1 messages.");
  expect(requests).toHaveLength(1);
});

test("--account all with only malformed settings exits 1 with the invalid-settings line", async () => {
  await writeFile(join(configDir, "accounts", "m365", "broken.yaml"), "name: [unclosed", "utf8");
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill({ source: "m365", account: "all" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("m365 broken:");
  expect(errors).toContain("invalid settings");
  // The file exists but is broken, so "add a file" would be the wrong guidance.
  expect(errors).not.toContain("No enabled m365 accounts found");
  expect(capturedLines(stdout)).toHaveLength(0);
});

test("a folder whose name needs encoding is percent-encoded in the request path", async () => {
  await writeAccount("work", "folders:\n  - Sent Items\n");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir },
  );

  expect(code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Sent%20Items/messages?`)).toBe(true);
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
});

test("--account <name> with that account's own malformed settings exits 1 with the invalid-settings line", async () => {
  await writeFile(join(configDir, "accounts", "m365", "work.yaml"), "name: [unclosed", "utf8");
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill({ source: "m365", account: "work" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("m365 work:");
  expect(errors).toContain("invalid settings");
  // The file is there but broken, so "no such account" would be the wrong guidance.
  expect(errors).not.toContain("No enabled m365 account named");
  expect(capturedLines(stdout)).toHaveLength(0);
});

test("an unreadable accounts directory exits 1 with the listing error, not a crash", async () => {
  await rm(join(configDir, "accounts", "m365"), { recursive: true, force: true });
  await writeFile(join(configDir, "accounts", "m365"), "not a directory", "utf8");
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill({ source: "m365", account: "all" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stderr).join("")).toContain("m365: ");
  expect(capturedLines(stdout)).toHaveLength(0);
});
