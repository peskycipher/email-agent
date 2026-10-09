import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike, FetchResponseLike } from "../../src/adapters/m365/M365AuthAdapter.js";
import { runCron } from "../../src/cli/commands/cron.js";
import type { TokenSet } from "../../src/core/dto/TokenSet.js";
import type { TokenPort } from "../../src/core/ports/TokenPort.js";

const FOLDER_MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/mailFolders";
const STORED_ISO = "2026-10-08T08:00:00.000Z";
const STORED_ENCODED = "2026-10-08T08%3A00%3A00.000Z";
const CYCLE_START = new Date("2026-10-09T12:00:00.000Z");

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

async function writeAccount(name: string, extra = ""): Promise<void> {
  const body = `name: ${name}\nenabled: true\ntenantId: tenant-1\nclientId: client-1\n${extra}`;
  await writeFile(join(configDir, "accounts", "m365", `${name}.yaml`), body, "utf8");
}

/** The per-provider cursor file (Story 5.4 decision 2-A): `m365-<name>.json` or `gmail-<name>.json`. */
function statePath(name: string, provider: "m365" | "gmail" = "m365"): string {
  return join(configDir, "state", `${provider}-${name}.json`);
}

async function writeState(name: string, state: Record<string, unknown>, provider: "m365" | "gmail" = "m365"): Promise<void> {
  await mkdir(join(configDir, "state"), { recursive: true, mode: 0o700 });
  await writeFile(statePath(name, provider), `${JSON.stringify(state)}\n`, "utf8");
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "cli-cron-"));
  await mkdir(join(configDir, "accounts", "m365"), { recursive: true });
  await mkdir(join(configDir, "accounts", "gmail"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
});

test("--cron fetches only messages since the stored timestamp and advances the state (HAPPY)", async () => {
  await writeAccount("work");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "m365", account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Inbox/messages?`)).toBe(true);
  expect(requests[0]?.url).toContain(`$filter=receivedDateTime ge ${STORED_ENCODED}`);
  expect(requests[0]?.url).toContain("$orderby=receivedDateTime asc");
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
  // The persisted timestamp is the cycle start, not the newest message.
  expect(JSON.parse(await readFile(statePath("work"), "utf8"))).toEqual({
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("Fetched 2 message(s) from 1 account(s).");
});

test("--cron without a state file sends no filter and creates the state on success (NO_STATE)", async () => {
  await writeAccount("work");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "m365", account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(0);
  expect(requests[0]?.url).not.toContain("$filter");
  expect(requests[0]?.url).not.toContain("$orderby");
  expect(JSON.parse(await readFile(statePath("work"), "utf8"))).toEqual({
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
});

test("--cron --account all keeps going after an account fails and exits 1 with a counted line (ACCOUNT_FAILURE)", async () => {
  await writeAccount("alpha");
  await writeAccount("beta");
  await writeState("alpha", { lastRunTimestamp: "2026-10-07T07:00:00.000Z" });
  await writeState("beta", { lastRunTimestamp: STORED_ISO });
  const alphaBefore = await readFile(statePath("alpha"), "utf8");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "m365", account: "all" },
    {
      fetchFn,
      // alpha has no token, so its fetch fails before any request; beta fetches.
      tokenStore: memoryTokenStore({ "m365:beta": cachedToken("beta") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("alpha: ");
  expect(errors).toContain("1 of 2 m365 account(s) failed.");
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-beta");
  // The failed account's stored state is byte-for-byte untouched; the healthy one advanced.
  expect(await readFile(statePath("alpha"), "utf8")).toBe(alphaBefore);
  expect(JSON.parse(await readFile(statePath("beta"), "utf8"))).toEqual({
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
});

test("--cron --account all with no enabled m365 account exits 1 with the setup hint (NO_ACCOUNTS)", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron({ source: "m365", account: "all" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("No enabled m365 accounts found");
  expect(errors).toContain("~/.config/email-classify/accounts/m365/<name>.yaml");
  // A failed setup must not leave a state file behind.
  await expect(readFile(statePath("work"), "utf8")).rejects.toThrow();
});

test("--cron --account <name> targets that one account only", async () => {
  await writeAccount("work");
  await writeAccount("other");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "m365", account: "work" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
  await expect(readFile(statePath("other"), "utf8")).rejects.toThrow();
});

test("--cron --account all counts an account with malformed settings as a failure (ACCOUNT_FAILURE)", async () => {
  await writeAccount("work");
  await writeFile(join(configDir, "accounts", "m365", "broken.yaml"), "name: [unclosed\n", "utf8");
  const { fetchFn } = recordingFetch([graphPage(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "m365", account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("m365 broken: ");
  expect(errors).toContain("1 of 2 m365 account(s) failed.");
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
});

test("--cron --account all with only malformed settings reports invalid settings, not the setup hint", async () => {
  await writeFile(join(configDir, "accounts", "m365", "broken.yaml"), "name: [unclosed\n", "utf8");
  const { fetchFn } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron({ source: "m365", account: "all" }, { fetchFn, configDir });

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("1 m365 account(s) have invalid settings");
  expect(errors).not.toContain("No enabled m365 accounts found");
  expect(capturedLines(stdout)).toHaveLength(0);
});

const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_HISTORY_URL = "https://gmail.googleapis.com/gmail/v1/users/me/history";
const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";

async function writeGmailAccount(name: string, extra = ""): Promise<void> {
  const body = `name: ${name}\nenabled: true\nclientId: client-1\nclientSecretEnvVar: GMAIL_SECRET\n${extra}`;
  await writeFile(join(configDir, "accounts", "gmail", `${name}.yaml`), body, "utf8");
}

function cachedGmailToken(accountId: string): TokenSet {
  return {
    accessToken: `access-gmail-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 3_600_000,
    scopes: ["gmail.readonly", "gmail.labels", "gmail.modify"],
  };
}

/** `users.getProfile`: the mailbox's current history id. */
function gmailProfile(historyId: string): FetchResponseLike {
  return jsonResponse({ emailAddress: "a@example.com", historyId });
}

/** A `users.history.list` page carrying one record per added id. */
function gmailHistoryPage(historyId: string, added: string[]): FetchResponseLike {
  return jsonResponse({
    history: added.map((id, index) => ({ id: `rec-${index}`, messagesAdded: [{ message: { id } }] })),
    historyId,
  });
}

/** Gmail's `messages.list` page: ids only. */
function gmailListPage(ids: string[]): FetchResponseLike {
  return jsonResponse({ messages: ids.map((id) => ({ id })) });
}

/** A `multipart/mixed` batch response, one metadata detail per id — with a per-part Content-ID. */
function gmailBatchResponse(ids: string[], boundary = "batch_cli"): FetchResponseLike {
  const parts = ids.map(
    (id, index) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-message-${index + 1}>\r\n\r\n` +
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n` +
      `${JSON.stringify({
        id,
        internetMessageId: `<${id}@example.com>`,
        labelIds: ["INBOX"],
        snippet: `Preview ${id}`,
        internalDate: "1759999999000",
        payload: {
          headers: [
            { name: "From", value: `Sender ${id} <${id}@example.com>` },
            { name: "Subject", value: `Subject ${id}` },
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

test("--cron --source gmail resumes from the stored history id and advances both keys (HAPPY_HISTORY)", async () => {
  await writeGmailAccount("personal");
  await writeState("personal", { lastHistoryId: "H1" }, "gmail");
  const { fetchFn, requests } = recordingFetch([gmailHistoryPage("H2", ["m1"]), gmailBatchResponse(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "gmail", account: "personal" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  // One history GET and one batch POST: only the added message is fetched, never the whole INBOX.
  expect(requests).toHaveLength(2);
  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.url).toBe(`${GMAIL_HISTORY_URL}?startHistoryId=H1&labelId=INBOX`);
  expect(requests[0]?.authorization).toBe("Bearer access-gmail-personal");
  expect(requests[1]?.url).toBe(GMAIL_BATCH_URL);
  expect(requests.some((request) => request.url.startsWith(GMAIL_MESSAGES_URL))).toBe(false);
  expect(JSON.parse(await readFile(statePath("personal", "gmail"), "utf8"))).toEqual({
    lastHistoryId: "H2",
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
});

test("--cron --source gmail with no state reads the profile first and walks the INBOX (FIRST_RUN_NO_STATE)", async () => {
  // A configured `labels` list is a backfill key; it must not widen the cron window past INBOX.
  await writeGmailAccount("personal", "labels: [Label_5]\n");
  const { fetchFn, requests } = recordingFetch([
    gmailProfile("H5"),
    gmailListPage(["m1"]),
    gmailBatchResponse(["m1"]),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "gmail", account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(0);
  // Profile first, then the whole INBOX — no history walk to resume from.
  expect(requests.map((request) => request.url)).toEqual([
    GMAIL_PROFILE_URL,
    `${GMAIL_MESSAGES_URL}?labelIds=INBOX&maxResults=50`,
    GMAIL_BATCH_URL,
  ]);
  // The pre-walk profile id is what gets recorded, together with the cycle start.
  expect(JSON.parse(await readFile(statePath("personal", "gmail"), "utf8"))).toEqual({
    lastHistoryId: "H5",
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
});

test("--cron --source gmail on an expired history warns by name and falls back to the INBOX walk (HISTORY_EXPIRED)", async () => {
  await writeGmailAccount("personal");
  await writeState("personal", { lastHistoryId: "old", lastRunTimestamp: STORED_ISO }, "gmail");
  const { fetchFn, requests } = recordingFetch([
    jsonResponse({}, false, 404),
    gmailProfile("H2"),
    gmailListPage(["m1"]),
    gmailBatchResponse(["m1"]),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "gmail", account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  // Warned, not failed: the account is still fetched and the exit code reflects success.
  expect(code).toBe(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("warn personal: ");
  expect(errors).toContain("has expired");
  expect(errors).not.toContain("error");
  expect(requests.map((request) => request.url)).toEqual([
    `${GMAIL_HISTORY_URL}?startHistoryId=old&labelId=INBOX`,
    GMAIL_PROFILE_URL,
    // The stored cycle start bounds the fallback on the wire: epoch 1791446400 steps back one
    // second, because Gmail's `after:` is exclusive.
    `${GMAIL_MESSAGES_URL}?labelIds=INBOX&maxResults=50&q=after%3A1791446399`,
    GMAIL_BATCH_URL,
  ]);
  expect(JSON.parse(await readFile(statePath("personal", "gmail"), "utf8"))).toEqual({
    lastHistoryId: "H2",
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
});

test("--cron --source gmail skips a purged message's 404 part with a warn naming the id (PART_DELETED)", async () => {
  await writeGmailAccount("personal");
  await writeState("personal", { lastHistoryId: "H1" }, "gmail");
  // One part per named id: the purged message's part answers 404, the surviving one maps to a detail.
  const boundary = "batch_cli";
  const detailPart = (id: string, index: number, status = 200): string =>
    `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-message-${index}>\r\n\r\n` +
    `HTTP/1.1 ${status === 200 ? "200 OK" : "404 Not Found"}\r\nContent-Type: application/json\r\n\r\n` +
    (status === 200
      ? `${JSON.stringify({
          id,
          internetMessageId: `<${id}@example.com>`,
          labelIds: ["INBOX"],
          snippet: `Preview ${id}`,
          internalDate: "1759999999000",
          payload: {
            headers: [
              { name: "From", value: `Sender ${id} <${id}@example.com>` },
              { name: "Subject", value: `Subject ${id}` },
            ],
          },
        })}\r\n\r\n`
      : `{"error":{"code":404,"message":"Requested entity was not found."}}\r\n\r\n`);
  const purgedBatch = {
    ok: true,
    status: 200,
    headers: { get: () => `multipart/mixed; boundary="${boundary}"` },
    json: async () => ({}),
    text: async () => detailPart("m1", 1) + detailPart("purged", 2, 404) + `--${boundary}--\r\n`,
  } as FetchResponseLike;
  const { fetchFn, requests } = recordingFetch([gmailHistoryPage("H2", ["m1", "purged"]), purgedBatch]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "gmail", account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("warn personal: ");
  expect(errors).toContain("purged");
  expect(errors).not.toContain("error");
  // The surviving message was fetched; the cycle succeeded and still recorded state.
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
  expect(JSON.parse(await readFile(statePath("personal", "gmail"), "utf8"))).toEqual({
    lastHistoryId: "H2",
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(requests).toHaveLength(2);
});

test("--cron --source gmail keeps going after an account fails and exits 1 with a counted line (MULTI_ACCOUNT)", async () => {
  await writeGmailAccount("alpha");
  await writeGmailAccount("beta");
  await writeState("alpha", { lastHistoryId: "H1", lastRunTimestamp: STORED_ISO }, "gmail");
  await writeState("beta", { lastHistoryId: "H1", lastRunTimestamp: STORED_ISO }, "gmail");
  const alphaBefore = await readFile(statePath("alpha", "gmail"), "utf8");
  const { fetchFn, requests } = recordingFetch([gmailHistoryPage("H2", ["m1"]), gmailBatchResponse(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "gmail", account: "all" },
    {
      fetchFn,
      // alpha has no token, so its cycle fails before any request; beta fetches.
      tokenStore: memoryTokenStore({ "gmail:beta": cachedGmailToken("beta") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("alpha: ");
  expect(errors).toContain("1 of 2 gmail account(s) failed.");
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
  expect(requests).toHaveLength(2);
  expect(requests[0]?.authorization).toBe("Bearer access-gmail-beta");
  // The failed account's stored state is byte-for-byte untouched; the healthy one advanced.
  expect(await readFile(statePath("alpha", "gmail"), "utf8")).toBe(alphaBefore);
  expect(JSON.parse(await readFile(statePath("beta", "gmail"), "utf8"))).toEqual({
    lastHistoryId: "H2",
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
});

test("--cron --source gmail --account all counts an account with malformed settings as a failure (INVALID_SETTINGS)", async () => {
  await writeGmailAccount("personal");
  await writeState("personal", { lastHistoryId: "H1" }, "gmail");
  await writeFile(join(configDir, "accounts", "gmail", "broken.yaml"), "name: [unclosed\n", "utf8");
  const { fetchFn, requests } = recordingFetch([gmailHistoryPage("H2", ["m1"]), gmailBatchResponse(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "gmail", account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("gmail broken: ");
  expect(errors).toContain("1 of 2 gmail account(s) failed.");
  // The valid account still ran.
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
  expect(requests).toHaveLength(2);
});

test("--cron --source gmail --account all with no enabled gmail account exits 1 with the setup hint (NO_ACCOUNTS)", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron({ source: "gmail", account: "all" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("No enabled gmail accounts found");
  expect(errors).toContain("~/.config/email-classify/accounts/gmail/<name>.yaml");
  // A failed setup must not leave a state file behind.
  await expect(readFile(statePath("personal", "gmail"), "utf8")).rejects.toThrow();
});

test("--cron --source gmail --account <name> with no such account exits 1 with the named hint", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron({ source: "gmail", account: "ghost" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain('No enabled gmail account named "ghost" found');
  expect(errors).toContain("accounts/gmail/ghost.yaml");
  expect(capturedLines(stdout)).toHaveLength(0);
});

test("an m365 and a gmail account sharing a name each keep their own cursor file (EC2)", async () => {
  await writeAccount("shared");
  await writeGmailAccount("shared");
  await writeState("shared", { lastHistoryId: "H1" }, "gmail");
  const { fetchFn: gmailFetch, requests: gmailRequests } = recordingFetch([
    jsonResponse({}, false, 404),
    gmailProfile("H2"),
    gmailListPage(["m1"]),
    gmailBatchResponse(["m1"]),
  ]);
  // Gmail's cycle writes only its own namespaced file — never the m365 account's bound.
  const gmailCode = await runCron(
    { source: "gmail", account: "shared" },
    {
      fetchFn: gmailFetch,
      tokenStore: memoryTokenStore({ "gmail:shared": cachedGmailToken("shared") }),
      configDir,
      now: () => CYCLE_START,
    },
  );
  expect(gmailCode).toBe(0);
  expect(await readFile(statePath("shared", "gmail"), "utf8")).toContain('"lastHistoryId": "H2"');
  // The m365 cursor file does not exist: Gmail never wrote it.
  await expect(readFile(statePath("shared", "m365"), "utf8")).rejects.toThrow();
  expect(gmailRequests.map((request) => request.url)).toEqual([
    `${GMAIL_HISTORY_URL}?startHistoryId=H1&labelId=INBOX`,
    GMAIL_PROFILE_URL,
    // No stored gmail cycle start, so the fallback walk carries no bound.
    `${GMAIL_MESSAGES_URL}?labelIds=INBOX&maxResults=50`,
    GMAIL_BATCH_URL,
  ]);

  // The m365 cycle reads and writes only its own file: no gmail-bound filter leaks in.
  const { fetchFn: m365Fetch, requests: m365Requests } = recordingFetch([graphPage(["m1"])]);
  const m365Code = await runCron(
    { source: "m365", account: "shared" },
    {
      fetchFn: m365Fetch,
      tokenStore: memoryTokenStore({ "m365:shared": cachedToken("shared") }),
      configDir,
      now: () => CYCLE_START,
    },
  );
  expect(m365Code).toBe(0);
  // No $filter — m365's cursor was absent, so gmail's gmail-<name>.json could not bound it.
  expect(m365Requests[0]?.url).not.toContain("$filter");
  // The gmail cursor file is untouched by m365's cycle-start write.
  expect(await readFile(statePath("shared", "gmail"), "utf8")).toContain('"lastRunTimestamp"');
  const m365State = JSON.parse(await readFile(statePath("shared", "m365"), "utf8")) as Record<string, string>;
  expect(Object.keys(m365State)).toEqual(["lastRunTimestamp"]);
});
