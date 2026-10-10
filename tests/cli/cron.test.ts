import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, releaseRunLock } from "../../src/adapters/lock/runLock.js";
import type { FetchLike, FetchResponseLike } from "../../src/adapters/m365/M365AuthAdapter.js";
import { runCron } from "../../src/cli/commands/cron.js";
import { createShutdown, type ShutdownTarget } from "../../src/cli/shutdown.js";
import type { LogPort } from "../../src/core/ports/LogPort.js";
import type { SchedulerPort } from "../../src/core/ports/SchedulerPort.js";
import type { ModelPort } from "../../src/core/ports/ModelPort.js";
import type { TokenSet } from "../../src/core/dto/TokenSet.js";
import type { TokenPort } from "../../src/core/ports/TokenPort.js";

const FOLDER_MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/mailFolders";
const STORED_ISO = "2026-10-08T08:00:00.000Z";
const STORED_ENCODED = "2026-10-08T08%3A00%3A00.000Z";
const CYCLE_START = new Date("2026-10-09T12:00:00.000Z");
/** The default interval's next-cycle instant: 15 minutes after a fixed cycle start. */
const NEXT_AT_DEFAULT = new Date("2026-10-09T12:15:00.000Z");

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

/**
 * A `ModelPort` double for a CLI cycle: `classify` validates the reply against the shipped
 * taxonomy, so the double answers the one label every seeded subject maps to.
 */
function modelDouble(): ModelPort {
  return {
    async complete(): Promise<unknown> {
      return { labels: ["Crypto"] };
    },
  };
}

/**
 * A scheduler double: the inline first cycle runs through `runOnce`, then `runInterval` runs
 * `ticks` further cycles and records the interval it was handed. `ticks: 0` pins the one-cycle
 * shape; the loop tests raise it so no real interval is ever scheduled.
 */
function loopScheduler(ticks: number): { scheduler: SchedulerPort; intervals: number[] } {
  const intervals: number[] = [];
  return {
    intervals,
    scheduler: {
      async runOnce(fn) {
        await fn();
      },
      async runInterval(fn, intervalMs) {
        intervals.push(intervalMs);
        for (let tick = 0; tick < ticks; tick += 1) await fn();
        return new AbortController();
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

test("one cycle fetches what is new since the stored timestamp, classifies, writes back and advances the state (HAPPY_CYCLE)", async () => {
  await writeAccount("work");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"]), ...m365WriteResponses(["m1", "m2"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  // The cycle's own lines: the per-account progress the logPort writes, then the one cycle line.
  const out = capturedLines(stdout).join("");
  expect(out).toContain("info work: Fetched 2 messages.\n");
  expect(out).toContain("info work: Processed 2 message(s): 2 labeled, 0 skipped, 0 already done, 0 error(s).\n");
  expect(out).toContain(
    `Cron cycle started ${CYCLE_START.toISOString()}: 2 fetched, 2 labeled, 0 skipped, 0 already done, 0 error(s), ` +
      `took 0ms — next cycle at ${NEXT_AT_DEFAULT.toISOString()}.\n`,
  );
  expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Inbox/messages?`)).toBe(true);
  expect(requests[0]?.url).toContain(`$filter=receivedDateTime ge ${STORED_ENCODED}`);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
  // The label write landed once per message: a categories read, then the PATCH.
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(2);
  // The persisted timestamp is the cycle start, not the newest message.
  expect(JSON.parse(await readFile(statePath("work"), "utf8"))).toEqual({
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
});

test("a looped run cycles at the interval, each cycle incremental from the last (LOOP)", async () => {
  await writeAccount("work");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([
    graphPage(["m1"]),
    ...m365WriteResponses(["m1"]),
    graphPage([]),
    graphPage([]),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler, intervals } = loopScheduler(2);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  // The loop was handed the interval in milliseconds: three cycles ran (the inline one plus two ticks).
  expect(intervals).toEqual([900_000]);
  const lines = capturedLines(stdout).join("");
  expect(lines.match(/Cron cycle started /g)).toHaveLength(3);
  // The later cycles are bounded by the cycle start the first one committed.
  const bounded = requests.filter((request) => request.url.includes(`$filter=receivedDateTime ge ${CYCLE_START.toISOString().replace(/:/g, "%3A")}`));
  expect(bounded).toHaveLength(2);
  expect(JSON.parse(await readFile(statePath("work"), "utf8"))).toEqual({
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
});

test("--interval threads through as the cycle interval and the next-cycle time (INTERVAL)", async () => {
  await writeAccount("work");
  const { fetchFn } = recordingFetch([graphPage([]), graphPage([])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { scheduler, intervals } = loopScheduler(1);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 5 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  expect(intervals).toEqual([300_000]);
  const nextAt = new Date("2026-10-09T12:05:00.000Z").toISOString();
  expect(capturedLines(stdout).join("")).toContain(`— next cycle at ${nextAt}.`);
});

test("--cron without a state file sends no filter and creates the state on success (FIRST_CYCLE)", async () => {
  await writeAccount("work");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  expect(requests[0]?.url).not.toContain("$filter");
  expect(requests[0]?.url).not.toContain("$orderby");
  expect(JSON.parse(await readFile(statePath("work"), "utf8"))).toEqual({
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("1 fetched, 1 labeled");
});

test("one account's failed cycle is named in the cycle's failure line while the other still runs (ACCOUNT_ISOLATION)", async () => {
  await writeAccount("alpha");
  await writeAccount("beta");
  await writeState("alpha", { lastRunTimestamp: "2026-10-07T07:00:00.000Z" });
  await writeState("beta", { lastRunTimestamp: STORED_ISO });
  const alphaBefore = await readFile(statePath("alpha"), "utf8");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      // alpha has no token, so its fetch fails before any request; beta fetches and labels.
      tokenStore: memoryTokenStore({ "m365:beta": cachedToken("beta") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
      sleep: async () => {},
    },
  );

  // The loop starts regardless: a failed account never stops the others, and in loop mode there is
  // no terminal exit code — the account is named in the cycle's own failure line instead.
  expect(code).toBe(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("alpha: ");
  expect(errors).toContain("1 of 2 account(s) failed this cycle: alpha.");
  expect(capturedLines(stdout).join("")).toContain("1 fetched, 1 labeled");
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

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    { fetchFn, configDir, scheduler: loopScheduler(0).scheduler },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("No enabled m365 accounts found");
  expect(errors).toContain("~/.config/email-classify/accounts/m365/<name>.yaml");
  // A failed setup must not leave a state file behind.
  await expect(readFile(statePath("work"), "utf8")).rejects.toThrow();
});

test("a start blocked by another invocation leaves no empty idempotency.db behind (STORE_ORDER)", async () => {
  await writeAccount("work");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([]);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  // A live run holds the lock before this invocation's first cycle can take it.
  acquireRunLock({ configDir, pid: process.pid });

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler: loopScheduler(0).scheduler,
    },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  // The store opens only once a cycle holds the lock: nothing was created for a blocked start.
  await expect(readFile(join(configDir, "idempotency.db"), "utf8")).rejects.toThrow();
  await releaseRunLock({ configDir, pid: process.pid });
});

test("a fault escaping the first cycle is one line and exit 1, never a stack trace (CYCLE_FAULT)", async () => {
  await writeAccount("work");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  // No token: the account's cycle fails, earns its one retry, and the throwing sleep escapes
  // `runCronCycle` — which is the wiring-fault contract the CLI must catch.
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({}),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
      sleep: async () => {
        throw new Error("sleep exploded");
      },
    },
  );

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("sleep exploded");
  // The escape is one actionable line — never a stack trace crossing the CLI.
  expect(errors).not.toContain("at ");
});

test("a gmail account with labels configured is told the cron window ignores them (LABELS_IGNORED)", async () => {
  await writeGmailAccount("personal", "labels: [Label_5]\n");
  const { fetchFn } = recordingFetch([gmailProfile("H1"), gmailListPage([]), gmailLabelsList()]);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "gmail", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("warn personal: ");
  expect(errors).toContain("the cron window is the account's INBOX only");
  expect(errors).toContain("--backfill");
});

test("--cron --account <name> targets that one account only", async () => {
  await writeAccount("work");
  await writeAccount("other");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "m365", account: "work", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
  expect(capturedLines(stdout).join("")).toContain("1 fetched, 1 labeled");
  await expect(readFile(statePath("other"), "utf8")).rejects.toThrow();
});

test("a fetch failure backs off 30 seconds, retries the account's cycle once, and a second failure holds the cursor (FETCH_ERROR)", async () => {
  await writeAccount("work");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([]);
  const sleeps: number[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      // No token: the fetch fails before any request, on both the attempt and its one retry.
      tokenStore: memoryTokenStore({}),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
      sleep: async (ms) => { sleeps.push(ms); },
    },
  );

  expect(code).toBe(0);
  expect(sleeps).toEqual([30_000]);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("work: ");
  expect(errors).toContain('Account "work" failed again after one retry');
  expect(errors).toContain("1 of 1 account(s) failed this cycle: work.");
  // The failed account's cursor stayed held.
  expect(JSON.parse(await readFile(statePath("work"), "utf8"))).toEqual({
    lastRunTimestamp: STORED_ISO,
  });
  expect(capturedLines(stdout).join("")).toContain("0 fetched");
  expect(requests).toHaveLength(0);
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

/** The Gmail label write: a `format=minimal` read, then the `modify` POST. */
function gmailWriteResponses(ids: string[]): FetchResponseLike[] {
  return ids.flatMap((id) => [jsonResponse({ id, labelIds: ["INBOX"] }), jsonResponse({ id, labelIds: ["INBOX", "Label_1"] })]);
}

/**
 * A `multipart/mixed` batch response, one metadata detail per id — with a per-part Content-ID.
 * The identity is the `Message-ID` header: a real Gmail detail has no top-level `internetMessageId`.
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

/**
 * `users.labels.list` for the cycle's `ensureCategories` call: the default taxonomy's every label
 * already exists, so nothing is created. `Crypto` carries the id the write fixtures script.
 */
function gmailLabelsList(): FetchResponseLike {
  const names = [
    "Crypto",
    "Action Needed",
    "Waiting/Follow-up",
    "Important",
    "Invoices",
    "Business",
    "Family/Friends",
    "Newsletters",
    "Promos",
    "Notifications",
    "Real-estate",
  ];
  return jsonResponse({
    labels: names.map((name, index) => ({ id: index === 0 ? "Label_1" : `Label_${index + 1}`, name })),
  });
}

test("--cron --source gmail resumes from the stored history id, classifies and advances both keys (HAPPY_HISTORY)", async () => {
  await writeGmailAccount("personal");
  await writeState("personal", { lastHistoryId: "H1" }, "gmail");
  const { fetchFn, requests } = recordingFetch([
    gmailHistoryPage("H2", ["m1"]),
    gmailBatchResponse(["m1"]),
    gmailLabelsList(),
    ...gmailWriteResponses(["m1"]),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "gmail", account: "personal", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  // One history GET, one detail batch, then the label write's read + modify per message.
  expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "GET", "GET", "POST"]);
  expect(requests[0]?.url).toBe(`${GMAIL_HISTORY_URL}?startHistoryId=H1&labelId=INBOX`);
  expect(requests[0]?.authorization).toBe("Bearer access-gmail-personal");
  expect(JSON.parse(await readFile(statePath("personal", "gmail"), "utf8"))).toEqual({
    lastHistoryId: "H2",
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("1 fetched, 1 labeled");
});

test("--cron --source gmail with no state reads the profile first and walks the INBOX (FIRST_RUN_NO_STATE)", async () => {
  // A configured `labels` list is a backfill key; it must not widen the cron window past INBOX.
  await writeGmailAccount("personal", "labels: [Label_5]\n");
  const { fetchFn, requests } = recordingFetch([
    gmailProfile("H5"),
    gmailListPage(["m1"]),
    gmailBatchResponse(["m1"]),
    gmailLabelsList(),
    ...gmailWriteResponses(["m1"]),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "gmail", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  // Profile first, then the whole INBOX — no history walk to resume from — then the write.
  expect(requests.slice(0, 3).map((request) => request.url)).toEqual([
    GMAIL_PROFILE_URL,
    `${GMAIL_MESSAGES_URL}?labelIds=INBOX&maxResults=50`,
    GMAIL_BATCH_URL,
  ]);
  // The pre-walk profile id is what gets recorded, together with the cycle start.
  expect(JSON.parse(await readFile(statePath("personal", "gmail"), "utf8"))).toEqual({
    lastHistoryId: "H5",
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("1 fetched, 1 labeled");
});

test("a throttled gmail cycle waits through the adapters' injected sleep and still commits (THROTTLED)", async () => {
  await writeGmailAccount("personal");
  await writeState("personal", { lastHistoryId: "H1" }, "gmail");
  const { fetchFn, requests } = recordingFetch([
    jsonResponse({ error: { code: 429, message: "Rate Limited" } }, false, 429, { "retry-after": "3" }),
    gmailHistoryPage("H2", ["m1"]),
    gmailBatchResponse(["m1"]),
    gmailLabelsList(),
    ...gmailWriteResponses(["m1"]),
  ]);
  const sleeps: number[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "gmail", account: "personal", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
      sleep: async (ms) => { sleeps.push(ms); },
    },
  );

  expect(code).toBe(0);
  // The adapter's backoff wait arrived through the same injected seam — recorded, never really waited.
  expect(sleeps).toEqual([3_000]);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain('is throttled by Gmail — waiting 3s before retry 1 of 5');
  expect(errors).not.toContain("failed");
  expect(JSON.parse(await readFile(statePath("personal", "gmail"), "utf8"))).toEqual({
    lastHistoryId: "H2",
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("1 fetched, 1 labeled");
  // history (429) + the same history GET re-issued + batch + label ensure + the write's read + modify.
  expect(requests).toHaveLength(6);
});

test("--cron --source gmail on an expired history warns by name and falls back to the INBOX walk (HISTORY_EXPIRED)", async () => {
  await writeGmailAccount("personal");
  await writeState("personal", { lastHistoryId: "old", lastRunTimestamp: STORED_ISO }, "gmail");
  const { fetchFn, requests } = recordingFetch([
    jsonResponse({}, false, 404),
    gmailProfile("H2"),
    gmailListPage(["m1"]),
    gmailBatchResponse(["m1"]),
    gmailLabelsList(),
    ...gmailWriteResponses(["m1"]),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "gmail", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  // Warned, not failed: the account is still fetched, classified and advanced.
  expect(code).toBe(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("warn personal: ");
  expect(errors).toContain("has expired");
  expect(requests.slice(0, 4).map((request) => request.url)).toEqual([
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
  expect(capturedLines(stdout).join("")).toContain("1 fetched, 1 labeled");
});

test("an m365 and a gmail account sharing a name each keep their own cursor file, and --source all runs both in one cycle (SOURCE_ALL)", async () => {
  await writeAccount("shared");
  await writeGmailAccount("shared");
  await writeState("shared", { lastHistoryId: "H1" }, "gmail");
  const { fetchFn, requests } = recordingFetch([
    // The m365 half of the one cycle: fetch, then the write.
    graphPage(["m1"]),
    ...m365WriteResponses(["m1"]),
    // The gmail half: history walk, detail batch, the cycle's label ensure, then the write.
    gmailHistoryPage("H2", ["g1"]),
    gmailBatchResponse(["g1"]),
    gmailLabelsList(),
    ...gmailWriteResponses(["g1"]),
  ]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "all", account: "shared", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({
        "m365:shared": cachedToken("shared"),
        "gmail:shared": cachedGmailToken("shared"),
      }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  // One cycle line covering both providers' accounts.
  expect(capturedLines(stdout).join("")).toContain("2 fetched, 2 labeled");
  // Each provider's cursor advanced in its own namespaced file.
  expect(JSON.parse(await readFile(statePath("shared", "m365"), "utf8"))).toEqual({
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(JSON.parse(await readFile(statePath("shared", "gmail"), "utf8"))).toEqual({
    lastHistoryId: "H2",
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  // The m365 fetch ran through the m365 token, the gmail history walk through the gmail one.
  expect(requests.find((request) => request.url.startsWith(`${FOLDER_MESSAGES_URL}/`))?.authorization).toBe("Bearer access-m365-shared");
  expect(requests.find((request) => request.url.startsWith(GMAIL_HISTORY_URL))?.authorization).toBe("Bearer access-gmail-shared");
});

test("--interval 1440 reaches the scheduler as 86_400_000 ms (INTERVAL_MAX)", async () => {
  await writeAccount("work");
  const { fetchFn } = recordingFetch([graphPage([])]);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { scheduler, intervals } = loopScheduler(0);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 1440 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  expect(intervals).toEqual([86_400_000]);
});

test("--cron --account all counts an account with malformed settings as a failure and still cycles the valid one (ACCOUNT_FAILURE)", async () => {
  await mkdir(join(configDir, "accounts", "m365"), { recursive: true });
  await writeFile(join(configDir, "accounts", "m365", "broken.yaml"), "name: [unclosed\n", "utf8");
  await writeAccount("work");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  // The malformed account is named in its own selection line; the valid one still cycles.
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("m365 broken: ");
  expect(code).toBe(0);
  expect(capturedLines(stdout).join("")).toContain("1 fetched, 1 labeled");
});

test("--cron --account all with only malformed settings reports them and exits 1, without the setup hint (ACCOUNT_FAILURE)", async () => {
  await mkdir(join(configDir, "accounts", "m365"), { recursive: true });
  await writeFile(join(configDir, "accounts", "m365", "broken.yaml"), "name: [unclosed\n", "utf8");
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    { fetchFn, configDir, scheduler: loopScheduler(0).scheduler },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("m365 broken: ");
  // Invalid settings read as the rejection, not the setup hint.
  expect(errors).not.toContain("No enabled m365 accounts found");
});

test("--cron exits 1 with the AC's line and starts no loop when a run already holds the lock (CONCURRENT_RUN)", async () => {
  await writeAccount("work");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler, intervals } = loopScheduler(2);
  // A live run holds the lock; this test process stands in for it.
  acquireRunLock({ configDir, pid: process.pid });

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  expect(capturedLines(stderr).join("")).toContain("another email-classify run is in progress");
  // The loop never started: no interval was handed to the scheduler.
  expect(intervals).toEqual([]);
  // The held lock is not the failed cycle's to remove.
  expect(await readFile(statePath("work"), "utf8")).toContain(STORED_ISO);
});

test("a tick that finds the lock held by an interleaved --backfill logs the line, skips its cycle and the next tick proceeds (PER_CYCLE_LOCK)", async () => {
  await writeAccount("work");
  const { fetchFn } = recordingFetch([graphPage([]), graphPage([])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const lock = { configDir, pid: process.pid };
  const tick = async (fn: () => Promise<void>): Promise<void> => {
    // A backfill takes the lock in the gap between cycles...
    acquireRunLock(lock);
    await fn();
    // ...and finishes before the next tick fires.
    releaseRunLock(lock);
  };
  const scheduler: SchedulerPort = {
    async runOnce(fn) {
      await fn();
    },
    async runInterval(fn, intervalMs) {
      expect(intervalMs).toBe(900_000);
      await tick(fn);
      await fn();
      return new AbortController();
    },
  };

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  const out = capturedLines(stdout).join("");
  // The inline first cycle plus the free second tick ran; the locked tick wrote no cycle line.
  expect(out.match(/Cron cycle started /g)).toHaveLength(2);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("another email-classify run is in progress");
  // The lock the test held was released, and the cron's own per-cycle lock is gone too.
  await expect(readFile(join(configDir, "run.lock"), "utf8")).rejects.toThrow();
});

test("--cron takes over a lock file left by a dead pid and proceeds (STALE_LOCK)", async () => {
  await writeAccount("work");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  await writeFile(join(configDir, "run.lock"), `${deadPid()}\n`, "utf8");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  expect(requests[0]?.method).toBe("GET");
  expect(capturedLines(stdout).join("")).toContain("1 fetched, 1 labeled");
});

test("--cron releases the lock on every cycle exit path, including a failing one (RELEASE_ON_FAILURE)", async () => {
  await writeAccount("work");
  const { fetchFn } = recordingFetch([]);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  // No token for the account: its cycle fails on both the attempt and the retry, and the run
  // still starts its loop — the failed account is named in the cycle's failure line.
  const code = await runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({}),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
      sleep: async () => {},
    },
  );

  expect(code).toBe(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("1 of 1 account(s) failed this cycle: work.");
  await expect(readFile(join(configDir, "run.lock"), "utf8")).rejects.toThrow();
});

test("--source all with a provider that has no enabled account still runs the other (SOURCE_ALL_PARTIAL)", async () => {
  await writeAccount("work");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { scheduler } = loopScheduler(0);

  const code = await runCron(
    { source: "all", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
    },
  );

  expect(code).toBe(0);
  // The gmail half reported its empty listing; the m365 half still ran its cycle.
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("No enabled gmail accounts found");
  expect(capturedLines(stdout).join("")).toContain("1 fetched, 1 labeled");
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
});

test("--source all with no enabled account on either provider exits 1 with both hints (SOURCE_ALL_EMPTY)", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { source: "all", account: "all", intervalMinutes: 15 },
    { fetchFn, configDir, scheduler: loopScheduler(0).scheduler },
  );

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("No enabled m365 accounts found");
  expect(errors).toContain("No enabled gmail accounts found");
});
test("a SIGINT between cycles clears the interval, drains the in-flight cycle, flushes and exits 0 (SIGINT_IDLE)", async () => {
  await writeAccount("work");
  let fetchCalls = 0;
  let markSecondStarted: () => void = () => {};
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  let releaseSecond: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const fetchFn: FetchLike = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return graphPage([]); // the inline first cycle
    markSecondStarted();
    // The loop cycle is genuinely in flight and only the test releases it.
    await gate;
    return graphPage([]);
  };

  const events: string[] = [];
  const logPort: LogPort = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    flush: async () => {
      events.push("flush");
    },
  };
  const { target, fire } = signalTarget();
  const exits: number[] = [];
  const shutdown = createShutdown({ target, exit: (code) => exits.push(code) });
  shutdown.attach();

  let controller: AbortController | undefined;
  const intervals: number[] = [];
  const scheduler: SchedulerPort = {
    async runOnce(fn) {
      await fn();
    },
    async runInterval(fn, intervalMs) {
      intervals.push(intervalMs);
      controller = new AbortController();
      // The shipped adapter resolves immediately: the cycle runs on its own from here.
      void fn().then(() => events.push("cycle-drained"));
      return controller;
    },
  };
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const runPromise = runCron(
    { source: "m365", account: "all", intervalMinutes: 15 },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
      model: modelDouble(),
      scheduler,
      logPort,
      shutdown,
    },
  );

  await secondStarted;
  fire("SIGINT");
  await vi.waitFor(() => expect(controller?.signal.aborted).toBe(true));
  // The drain must wait for the in-flight cycle: no flush has happened while it is gated.
  expect(events).not.toContain("flush");

  releaseSecond();
  const code = await runPromise;

  expect(code).toBe(0);
  expect(exits).toEqual([]); // a handled shutdown, not a forced one
  expect(events).toEqual(["cycle-drained", "flush"]);
  expect(intervals).toEqual([900_000]);
  expect(fetchCalls).toBe(2); // the interval was cleared: no third cycle started
});
