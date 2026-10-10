import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idempotencyKey } from "../../src/adapters/idempotency/key.js";
import { IdempotencyStore } from "../../src/adapters/idempotency/sqliteIdempotencyStore.js";
import { acquireRunLock } from "../../src/adapters/lock/runLock.js";
import type { FetchLike, FetchResponseLike } from "../../src/adapters/m365/M365AuthAdapter.js";
import { runBackfill } from "../../src/cli/commands/backfill.js";
import { createShutdown, type ShutdownTarget } from "../../src/cli/shutdown.js";
import type { TokenSet } from "../../src/core/dto/TokenSet.js";
import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";
import type { ModelPort } from "../../src/core/ports/ModelPort.js";
import type { TokenPort } from "../../src/core/ports/TokenPort.js";

const FOLDER_MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/mailFolders";

interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | undefined;
}

function jsonResponse(body: unknown, ok = true, status = 200, headers?: Record<string, string>): FetchResponseLike {
  return {
    ok,
    status,
    ...(headers === undefined ? {} : { headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } }),
    json: async () => body,
  };
}

/** Only the fetch calls, so a test's request-count assertions stay about fetching, not write-back. */
function fetchRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter(
    (request) => request.method === "GET" && (request.url.includes("/mailFolders/") || request.url === `${GMAIL_MESSAGES_URL}?labelIds=INBOX&maxResults=50`),
  );
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

/** The M365 label write: a categories read, then the PATCH that applies the union. */
function m365WriteResponses(ids: string[]): FetchResponseLike[] {
  return ids.flatMap((id) => [
    jsonResponse({ id, categories: [] }),
    jsonResponse({ id, categories: ["Crypto"] }),
  ]);
}

/** The Gmail label write: a `format=minimal` read, then the `modify` POST. */
function gmailWriteResponses(ids: string[]): FetchResponseLike[] {
  return ids.flatMap((id) => [jsonResponse({ id, labelIds: ["INBOX"] }), jsonResponse({ id, labelIds: ["INBOX", "Label_1"] })]);
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

/** A `ShutdownTarget` recorder, so a test can fire the signal itself. */
function signalTarget(): { target: ShutdownTarget; fire: (signal: "SIGINT" | "SIGTERM") => void } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    target: {
      on: (signal, listener) => {
        const forSignal = listeners.get(signal) ?? [];
        forSignal.push(listener);
        listeners.set(signal, forSignal);
      },
    },
    fire: (signal) => {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
  };
}

function recordingLogPort(): {
  logPort: LogPort;
  entries: Array<{ level: string; message: string; context?: LogContext }>;
  flushes: number;
} {
  const entries: Array<{ level: string; message: string; context?: LogContext }> = [];
  const record = (level: string) => (message: string, context?: LogContext) => {
    entries.push({ level, message, ...(context === undefined ? {} : { context }) });
  };
  let flushes = 0;
  const logPort: LogPort = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    flush: async () => {
      flushes += 1;
    },
  };
  return {
    entries,
    logPort,
    get flushes(): number {
      return flushes;
    },
  };
}

/**
 * A `ModelPort` double for a CLI run: `classify` validates the reply against the taxonomy, so the
 * double answers the one label every seeded subject maps to — a labelled run with no provider call.
 */
function modelDouble(labels: string[] = ["Crypto"]): ModelPort {
  return {
    async complete(): Promise<unknown> {
      return { labels };
    },
  };
}

/** A model double that counts its calls, so "was this message classified?" is observable. */
function countingModel(labels: string[] = ["Crypto"]): { model: ModelPort; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    model: {
      async complete(): Promise<unknown> {
        calls += 1;
        return { labels };
      },
    },
  };
}

/** A pid no process holds: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("the probe child did not report a pid");
  return child.pid;
}

async function writeAccount(name: string, extra = ""): Promise<void> {
  const body = `name: ${name}\nenabled: true\ntenantId: tenant-1\nclientId: client-1\n${extra}`;
  await writeFile(join(configDir, "accounts", "m365", `${name}.yaml`), body, "utf8");
}

async function writeGmailAccount(name: string, extra = ""): Promise<void> {
  const body = `name: ${name}\nenabled: true\nclientId: client-1\nclientSecretEnvVar: GMAIL_SECRET\n${extra}`;
  await writeFile(join(configDir, "accounts", "gmail", `${name}.yaml`), body, "utf8");
}

const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";

function cachedGmailToken(accountId: string): TokenSet {
  return {
    accessToken: `access-gmail-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 3_600_000,
    scopes: ["gmail.readonly", "gmail.labels", "gmail.modify"],
  };
}

/** Gmail's `messages.list` page: ids only. */
function gmailListPage(ids: string[]): FetchResponseLike {
  return jsonResponse({ messages: ids.map((id) => ({ id })) });
}

/**
 * A `multipart/mixed` batch response, one metadata detail per id. The identity is the
 * `Message-ID` header the batch request asks for — a real Gmail detail carries no top-level
 * `internetMessageId`, which is what made the pre-classify lookup collapse (Story 8.2).
 */
function gmailBatchResponse(ids: string[], boundary = "batch_cli"): FetchResponseLike {
  const parts = ids.map(
    (id, index) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-message-${index + 1}>\r\n\r\n` +
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n` +
      `${JSON.stringify({
        id,
        labelIds: ["INBOX"],
        snippet: `Preview ${id}`,
        internalDate: "1759999999000",
        payload: {
          headers: [
            { name: "From", value: `Sender ${id} <${id}@example.com>` },
            { name: "Subject", value: `Subject ${id}` },
            { name: "Message-ID", value: `<${id}@example.com>` },
          ],
        },
      })}\r\n\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  return {
    ok: true,
    status: 200,
    headers: { get: () => `multipart/mixed; boundary="${boundary}"` },
    json: async () => ({}),
    text: async () => parts.join(""),
  } as FetchResponseLike;
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "cli-backfill-"));
  await mkdir(join(configDir, "accounts", "m365"), { recursive: true });
  await mkdir(join(configDir, "accounts", "gmail"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
});

test("--backfill --account all fetches every enabled account, one count line each, exit 0", async () => {
  await writeAccount("work");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"]), ...m365WriteResponses(["m1", "m2"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  expect(capturedLines(stdout)).toEqual([
    "info work: Processed 2 message(s): 2 labeled, 0 skipped, 0 already done, 0 error(s).\n",
    "Fetched 2 message(s) from 1 account(s): 2 labeled, 0 skipped, 0 already done, 0 error(s).\n",
  ]);
  expect(fetchRequests(requests)).toHaveLength(1);
  expect(requests[0]?.method).toBe("GET");
  // The orchestrator always names a folder, so the default account fetches Inbox.
  expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Inbox/messages?`)).toBe(true);
  expect(requests[0]?.url).toContain("$top=50");
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
});

test("a throttled backfill fetch waits through the adapters' injected sleep and still completes (THROTTLED)", async () => {
  await writeAccount("work");
  const { fetchFn, requests } = recordingFetch([
    jsonResponse({ error: { code: "TooManyRequests" } }, false, 429, { "retry-after": "2" }),
    graphPage(["m1", "m2"]),
    ...m365WriteResponses(["m1", "m2"]),
  ]);
  const sleeps: number[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      model: modelDouble(),
      sleep: async (ms) => { sleeps.push(ms); },
    },
  );

  expect(code).toBe(0);
  // The adapter's backoff wait arrived through the command's seam — recorded, never really waited.
  expect(sleeps).toEqual([2_000]);
  // The wait is logged naming the account (no silent sleeping) and there is no failure line:
  // the throttled fetch is not an error (THROTTLED row).
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain('is throttled by Microsoft Graph — waiting 2s before retry 1 of 5');
  expect(errors).not.toContain("failed");
  expect(capturedLines(stdout).join("")).toContain("2 labeled, 0 skipped, 0 already done, 0 error(s)");
  // The throttled page and its re-issue: same URL, two wire calls. Two messages then cost one
  // read + one PATCH each.
  expect(requests[0]?.url).toBe(requests[1]?.url);
  expect(requests).toHaveLength(6);
});

test("--account all keeps going after an account fails and exits 1 with a counted line (MULTI_ACCOUNT)", async () => {
  await writeAccount("alpha");
  await writeAccount("beta");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"]), ...m365WriteResponses(["m1", "m2"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:beta": cachedToken("beta") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("alpha: ");
  expect(errors).toContain("--auth m365 --account alpha");
  expect(errors).toContain("1 of 2 m365 account(s) failed.");
  expect(capturedLines(stdout).join("")).toContain("info beta: Processed 2 message(s): 2 labeled, 0 skipped, 0 already done, 0 error(s).");
  // The summary counts the account that fetched, not the two that were selected.
  expect(capturedLines(stdout).join("")).toContain("Fetched 2 message(s) from 1 account(s): 2 labeled, 0 skipped, 0 already done, 0 error(s).");
  expect(fetchRequests(requests)).toHaveLength(1);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-beta");
});

test("one account's folders and batchSize drive one request per folder (MULTI_FOLDER)", async () => {
  await writeAccount("work", "folders:\n  - Inbox\n  - Archive\nbatchSize: 100\n");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), graphPage(["m2", "m3"]), ...m365WriteResponses(["m1", "m2", "m3"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(0);
  expect(fetchRequests(requests)).toHaveLength(2);
  expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Inbox/messages?`)).toBe(true);
  expect(requests[1]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Archive/messages?`)).toBe(true);
  expect(fetchRequests(requests).every((request) => request.url.includes("$top=100"))).toBe(true);
  expect(capturedLines(stdout).join("")).toContain("info work: Processed 3 message(s): 3 labeled, 0 skipped, 0 already done, 0 error(s).");
  expect(capturedLines(stdout).join("")).toContain("Fetched 3 message(s) from 1 account(s): 3 labeled, 0 skipped, 0 already done, 0 error(s).");
});

test("--account <name> fetches only the named account and logs through the injected LogPort", async () => {
  await writeAccount("work");
  await writeAccount("other");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
  const log = recordingLogPort();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "work" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, logPort: log.logPort, model: modelDouble() },
  );

  expect(code).toBe(0);
  expect(fetchRequests(requests)).toHaveLength(1);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
  expect(log.entries).toEqual([
    { level: "info", message: "Processed 1 message(s): 1 labeled, 0 skipped, 0 already done, 0 error(s).", context: { accountId: "work" } },
  ]);
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s): 1 labeled, 0 skipped, 0 already done, 0 error(s).");
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
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(1);
  expect(capturedLines(stderr).join("")).toContain("m365 broken:");
  expect(capturedLines(stderr).join("")).toContain("1 of 2 m365 account(s) failed.");
  expect(capturedLines(stdout).join("")).toContain("work: Processed 1 message(s): 1 labeled, 0 skipped, 0 already done, 0 error(s).");
  expect(fetchRequests(requests)).toHaveLength(1);
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
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(0);
  expect(fetchRequests(requests)).toHaveLength(1);
  expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Sent%20Items/messages?`)).toBe(true);
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s): 1 labeled, 0 skipped, 0 already done, 0 error(s).");
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

test("--backfill --source gmail --account all fetches through the list+batch path, never Graph (CLI_SOURCE)", async () => {
  await writeGmailAccount("personal");
  const { fetchFn, requests } = recordingFetch([
    gmailListPage(["m1", "m2"]),
    gmailBatchResponse(["m1", "m2"]),
    ...gmailWriteResponses(["m1", "m2"]),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "gmail", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(1);
  expect(capturedLines(stderr)).toHaveLength(2);
  expect(capturedLines(stdout).join("")).toContain("info personal: Processed 0 message(s): 0 labeled, 0 skipped, 0 already done, 2 error(s).");
  expect(capturedLines(stdout).join("")).toContain("Fetched 2 message(s) from 1 account(s): 0 labeled, 0 skipped, 0 already done, 2 error(s).");
  expect(requests.filter((request) => request.url === GMAIL_BATCH_URL)).toHaveLength(1);
  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.url).toBe(`${GMAIL_MESSAGES_URL}?labelIds=INBOX&maxResults=50`);
  expect(requests[0]?.authorization).toBe("Bearer access-gmail-personal");
  expect(requests[1]?.method).toBe("POST");
  expect(requests[1]?.url).toBe(GMAIL_BATCH_URL);
  // Not a single request reached Microsoft Graph.
  expect(requests.every((request) => request.url.startsWith("https://gmail.googleapis.com/"))).toBe(true);
});

test("--backfill --source gmail --account all keeps going after an account fails (MULTI_ACCOUNT)", async () => {
  await writeGmailAccount("alpha");
  await writeGmailAccount("beta");
  const { fetchFn, requests } = recordingFetch([gmailListPage(["m1"]), gmailBatchResponse(["m1"]), ...gmailWriteResponses(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "gmail", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "gmail:beta": cachedGmailToken("beta") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("alpha: ");
  expect(errors).toContain("--auth gmail --account alpha");
  expect(errors).toContain("1 of 2 gmail account(s) failed.");
  expect(capturedLines(stdout).join("")).toContain("info beta: Processed 0 message(s): 0 labeled, 0 skipped, 0 already done, 1 error(s).");
  expect(fetchRequests(requests)).toHaveLength(1);
  expect(requests[0]?.authorization).toBe("Bearer access-gmail-beta");
});

test("--backfill --source gmail --account all with no enabled gmail account exits 1 with the setup hint (NO_ACCOUNTS)", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill({ source: "gmail", account: "all" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("No enabled gmail accounts found");
  expect(errors).toContain("~/.config/email-classify/accounts/gmail/<name>.yaml");
});

test("a gmail account's configured labels drive the list's labelIds (LABEL)", async () => {
  await writeGmailAccount("personal", "labels: [Label_5]\nbatchSize: 100\n");
  const { fetchFn, requests } = recordingFetch([gmailListPage([])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "gmail", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(`${GMAIL_MESSAGES_URL}?labelIds=Label_5&maxResults=100`);
  expect(capturedLines(stdout).join("")).toContain("Fetched 0 message(s) from 1 account(s): 0 labeled, 0 skipped, 0 already done, 0 error(s).");
});

test("--backfill --source gmail --account all with only malformed settings exits 1 with the gmail invalid-settings line", async () => {
  await writeFile(join(configDir, "accounts", "gmail", "broken.yaml"), "name: [unclosed", "utf8");
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill({ source: "gmail", account: "all" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("gmail broken:");
  expect(errors).toContain("invalid settings");
  // The file exists but is broken, so "add a file" would be the wrong guidance.
  expect(errors).not.toContain("No enabled gmail accounts found");
  expect(capturedLines(stdout)).toHaveLength(0);
});

test("--backfill --source gmail --account <name> with no such account exits 1 with the named hint", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill({ source: "gmail", account: "nobody" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("No enabled gmail account named");
  expect(capturedLines(stdout)).toHaveLength(0);
});

test("--since and --batch-size drive the per-account plan (CLI_FLAGS)", async () => {
  await writeAccount("work");
  const { fetchFn, requests } = recordingFetch([graphPage([])]);

  const code = await runBackfill(
    { source: "m365", account: "work", since: new Date("2026-01-01T00:00:00Z"), batchSize: 150 },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(0);
  const url = requests[0]?.url ?? "";
  expect(url.startsWith(`${FOLDER_MESSAGES_URL}/Inbox/messages?`)).toBe(true);
  expect(url).toContain("$top=100");
  expect(url).toContain("receivedDateTime");
});

test("a second --backfill with identical args classifies nothing and reports alreadyDone (RESUME)", async () => {
  await writeAccount("work");
  const { fetchFn, requests } = recordingFetch([
    // The first run fetches, classifies and writes both messages.
    graphPage(["m1", "m2"]),
    ...m365WriteResponses(["m1", "m2"]),
    // The second run refetches the same messages; the script has no write responses left, so an
    // attempted write would fail the account rather than pass unnoticed.
    graphPage(["m1", "m2"]),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { model, calls } = countingModel();
  const runtime = {
    fetchFn,
    tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
    configDir,
    model,
  };

  expect(await runBackfill({ source: "m365", account: "all" }, runtime)).toBe(0);
  expect(calls()).toBe(2);
  expect(await runBackfill({ source: "m365", account: "all" }, runtime)).toBe(0);

  // The model ran for the first run only: the second found both pairs recorded and skipped them
  // before classifying.
  expect(calls()).toBe(2);
  expect(capturedLines(stderr)).toHaveLength(0);
  expect(capturedLines(stdout).join("")).toContain(
    "Fetched 2 message(s) from 1 account(s): 0 labeled, 0 skipped, 2 already done, 0 error(s).",
  );
  expect(fetchRequests(requests)).toHaveLength(2);

  // Each outcome is stored under the AC's exact key, in the one shared store.
  const store = new IdempotencyStore({ configDir });
  expect(await store.has(idempotencyKey("work", "<m1@example.com>", ["Crypto"]))).toBe(true);
  expect(await store.has(idempotencyKey("work", "<m2@example.com>", ["Crypto"]))).toBe(true);
  expect(await store.labelsFor("work", "<m1@example.com>")).toEqual(["Crypto"]);
  store.close();
});

test("a second --backfill --source gmail reads each Message-ID and resumes (GMAIL_RESUME)", async () => {
  await writeGmailAccount("personal");
  // The empty label set makes the Gmail write path unreachable, and that is one of the outcomes
  // the store must record: the resume is what this test is about.
  const { fetchFn, requests } = recordingFetch([
    gmailListPage(["m1", "m2"]),
    gmailBatchResponse(["m1", "m2"]),
    gmailListPage(["m1", "m2"]),
    gmailBatchResponse(["m1", "m2"]),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { model, calls } = countingModel([]);
  const runtime = {
    fetchFn,
    tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
    configDir,
    model,
  };

  expect(await runBackfill({ source: "gmail", account: "all" }, runtime)).toBe(0);
  expect(await runBackfill({ source: "gmail", account: "all" }, runtime)).toBe(0);

  // Both messages were classified on the first run and neither on the second — which only holds
  // because each detail carried its own `Message-ID`; a top-level `internetMessageId` would leave
  // both identities empty and this run would classify them again.
  expect(calls()).toBe(2);
  expect(capturedLines(stderr)).toHaveLength(0);
  const lines = capturedLines(stdout).join("");
  expect(lines).toContain("Fetched 2 message(s) from 1 account(s): 0 labeled, 2 skipped, 0 already done, 0 error(s).");
  expect(lines).toContain("Fetched 2 message(s) from 1 account(s): 0 labeled, 0 skipped, 2 already done, 0 error(s).");
  expect(fetchRequests(requests)).toHaveLength(2);

  const store = new IdempotencyStore({ configDir });
  expect(await store.has(idempotencyKey("personal", "<m1@example.com>", []))).toBe(true);
  store.close();
});

test("a held lock exits 1 with the AC's line and fetches nothing (CONCURRENT_RUN)", async () => {
  await writeAccount("work");
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  // A live run holds the lock; this test process stands in for it.
  acquireRunLock({ configDir, pid: process.pid });

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  expect(capturedLines(stderr).join("")).toContain("another email-classify run is in progress");
});

test("a lock file left by a dead pid does not block the next run (STALE_LOCK)", async () => {
  await writeAccount("work");
  await writeFile(join(configDir, "run.lock"), `${deadPid()}\n`, "utf8");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  expect(fetchRequests(requests)).toHaveLength(1);
  expect(capturedLines(stdout).join("")).toContain("1 labeled");
});

test("a corrupt idempotency store exits 1 with one line naming the path, before any fetch (STORE_UNAVAILABLE)", async () => {
  await writeAccount("work");
  await writeFile(join(configDir, "idempotency.db"), "this is not a SQLite database", "utf8");
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  const errors = capturedLines(stderr);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(join(configDir, "idempotency.db"));
  // The lock was taken before the store opened, so the failed open must release it.
  await expect(readFile(join(configDir, "run.lock"), "utf8")).rejects.toThrow();
});

test("a failing cycle still releases the lock, so the next run can start (RELEASE_ON_FAILURE)", async () => {
  await writeAccount("work");
  const { fetchFn } = recordingFetch([]);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  // No token for the account: the fetch fails, the account fails and the run exits 1.
  const code = await runBackfill(
    { source: "m365", account: "all" },
    { fetchFn, tokenStore: memoryTokenStore({}), configDir, model: modelDouble() },
  );

  expect(code).toBe(1);
  expect(capturedLines(stderr).join("")).toContain("1 of 1 m365 account(s) failed.");
  await expect(readFile(join(configDir, "run.lock"), "utf8")).rejects.toThrow();
});

test("a SIGINT during an adapter's 429 wait ends it, flushes once and exits 0 without a failed account (SIGINT_IN_BACKOFF)", async () => {
  await writeAccount("work");
  // Only the 429 is queued: the abort must cut the wait before the fetch is re-issued.
  const { fetchFn } = recordingFetch([
    jsonResponse({ error: { code: "TooManyRequests" } }, false, 429, { "retry-after": "2" }),
  ]);
  const log = recordingLogPort();
  const { target, fire } = signalTarget();
  const exitSpy = vi.fn();
  const shutdown = createShutdown({ target, exit: exitSpy });
  shutdown.attach();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const sleeps: number[] = [];

  const code = await runBackfill(
    { source: "m365", account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      model: modelDouble(),
      logPort: log.logPort,
      shutdown,
      // The adapter's 9.1 ladder wait is where the signal lands: the raced base never resolves.
      sleep: async (ms) => {
        sleeps.push(ms);
        fire("SIGINT");
        await new Promise(() => {});
      },
    },
  );

  expect(code).toBe(0);
  // The ladder's wait arrived through the command's seam and was cut short.
  expect(sleeps).toEqual([2_000]);
  // The throttle is still announced (no silent sleeping) through the command's log port...
  expect(
    log.entries.some((entry) => entry.level === "warn" && entry.message.includes("is throttled by Microsoft Graph")),
  ).toBe(true);
  // ...but the interrupted wait is not the account's error and the run is not reported as failed.
  expect(log.entries.some((entry) => entry.level === "error")).toBe(false);
  expect(capturedLines(stderr).join("")).not.toContain("account(s) failed");
  // The drain flushed the log buffer once and never forced an exit.
  expect(log.flushes).toBe(1);
  expect(exitSpy).not.toHaveBeenCalled();
  expect(capturedLines(stdout).join("")).not.toContain("Fetched");
});
