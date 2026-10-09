import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAccountState,
  StateFileError,
  writeLastRunTimestamp,
} from "../../src/adapters/config/stateFile.js";
import type { FetchOpts } from "../../src/core/dto/FetchOpts.js";
import type { MessageDTO } from "../../src/core/dto/MessageDTO.js";
import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";
import type { MessageFetchTarget } from "../../src/orch/fetch.js";
import { fetchIncremental, type GmailHistoryOutcome, type GmailIncrementalSeam, type IncrementalAccountState } from "../../src/orch/incremental.js";

interface LogEntry {
  level: string;
  message: string;
  context: LogContext | undefined;
}

function recordingLogPort(): { logPort: LogPort; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record = (level: string) => (message: string, context?: LogContext) => {
    entries.push({ level, message, context });
  };
  return {
    entries,
    logPort: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
  };
}

function message(id: string, accountId: string): MessageDTO {
  return {
    id,
    internetMessageId: `<${id}@example.com>`,
    subject: "",
    bodyPreview: "",
    senderEmail: "",
    senderName: "",
    receivedDateTime: "2026-10-09T00:00:00Z",
    existingLabels: [],
    source: "m365",
    accountId,
  };
}

/** An in-memory state seam plus a record of every write, so the state advance is assertable. */
function memoryState(initial: Record<string, IncrementalAccountState>): {
  writes: Array<{ accountId: string; date: Date }>;
  readAccountState: (accountName: string) => Promise<IncrementalAccountState>;
  writeLastRunTimestamp: (accountName: string, date: Date) => Promise<void>;
} {
  const writes: Array<{ accountId: string; date: Date }> = [];
  return {
    writes,
    readAccountState: async (accountName) => initial[accountName] ?? {},
    writeLastRunTimestamp: async (accountName, date) => {
      writes.push({ accountId: accountName, date });
    },
  };
}

test("reads each account's own timestamp and advances it to that account's cycle start (MULTI_ACCOUNT)", async () => {
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [message("m1", opts.accountId)];
    },
  };
  const log = recordingLogPort();
  const state = memoryState({
    work: { lastRunTimestamp: "2026-10-08T08:00:00.000Z" },
    home: { lastRunTimestamp: "2026-10-08T09:00:00.000Z" },
  });
  const starts = [new Date("2026-10-09T08:00:00.000Z"), new Date("2026-10-09T09:00:00.000Z")];
  let next = 0;

  const result = await fetchIncremental({
    accounts: [{ accountId: "work" }, { accountId: "home" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    now: () => starts[next++] as Date,
  });

  expect(result).toEqual({ fetched: 2, failures: 0, accountsFetched: 2 });
  // Sequential, in plan order, each request carrying its own account's bound.
  expect(calls.map((call) => [call.accountId, call.since?.toISOString()])).toEqual([
    ["work", "2026-10-08T08:00:00.000Z"],
    ["home", "2026-10-08T09:00:00.000Z"],
  ]);
  expect(state.writes).toEqual([
    { accountId: "work", date: starts[0] },
    { accountId: "home", date: starts[1] },
  ]);
});

test("a failed fetch leaves that account's state untouched while the other advances (ACCOUNT_FAILURE)", async () => {
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      if (opts.accountId === "work") {
        throw new Error('Microsoft Graph refused to list messages for account "work" (HTTP 500).');
      }
      return [message("m1", "home")];
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ work: { lastRunTimestamp: "2026-10-08T08:00:00.000Z" } });
  const start = new Date("2026-10-09T10:00:00.000Z");

  const result = await fetchIncremental({
    accounts: [{ accountId: "work" }, { accountId: "home" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    now: () => start,
  });

  expect(result).toEqual({ fetched: 1, failures: 1, accountsFetched: 1 });
  // Only the healthy account's state advanced.
  expect(state.writes).toEqual([{ accountId: "home", date: start }]);
  expect(log.entries).toContainEqual({
    level: "error",
    message: 'Microsoft Graph refused to list messages for account "work" (HTTP 500).',
    context: { accountId: "work", folder: "Inbox" },
  });
});

test("an account with no state fetches without a bound and then creates its state (NO_STATE)", async () => {
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [message("m1", opts.accountId)];
    },
  };
  const log = recordingLogPort();
  const state = memoryState({});
  const start = new Date("2026-10-09T11:00:00.000Z");

  const result = await fetchIncremental({
    accounts: [{ accountId: "work" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    now: () => start,
  });

  expect(result).toEqual({ fetched: 1, failures: 0, accountsFetched: 1 });
  expect(calls[0]).not.toHaveProperty("since");
  expect(state.writes).toEqual([{ accountId: "work", date: start }]);
});

test("a filter that matches nothing fetches zero but still advances the state (NO_NEW_MESSAGES)", async () => {
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      return [];
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ work: { lastRunTimestamp: "2026-10-08T08:00:00.000Z" } });
  const start = new Date("2026-10-09T12:00:00.000Z");

  const result = await fetchIncremental({
    accounts: [{ accountId: "work" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    now: () => start,
  });

  expect(result).toEqual({ fetched: 0, failures: 0, accountsFetched: 1 });
  expect(state.writes).toEqual([{ accountId: "work", date: start }]);
});

test("an invalid stored state fails that account before any request (STATE_INVALID)", async () => {
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("must not be called");
    },
  };
  const log = recordingLogPort();

  const result = await fetchIncremental({
    accounts: [{ accountId: "work" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: async (accountName) => {
      throw new StateFileError("STATE_INVALID", accountName, `State for account "${accountName}" is invalid.`);
    },
    writeLastRunTimestamp: async () => {},
  });

  expect(result).toEqual({ fetched: 0, failures: 1, accountsFetched: 0 });
  expect(log.entries).toEqual([
    {
      level: "error",
      message: 'State for account "work" is invalid.',
      context: { accountId: "work" },
    },
  ]);
});

test("a state write failure still returns the fetched messages and counts as a failure (STATE_WRITE_FAILS)", async () => {
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      return [message("m1", "work")];
    },
  };
  const log = recordingLogPort();

  const result = await fetchIncremental({
    accounts: [{ accountId: "work" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: async () => ({}),
    writeLastRunTimestamp: async (accountName) => {
      throw new StateFileError("STATE_WRITE_FAILED", accountName, `Could not write the state for account "${accountName}".`);
    },
    now: () => new Date("2026-10-09T12:00:00.000Z"),
  });

  expect(result).toEqual({ fetched: 1, failures: 1, accountsFetched: 1 });
  expect(log.entries).toContainEqual({
    level: "error",
    message: 'Could not write the state for account "work".',
    context: { accountId: "work" },
  });
});

test("the persisted timestamp is the pre-fetch cycle start, not a post-fetch clock read (CYCLE_START)", async () => {
  const start = new Date("2026-10-09T12:00:00.000Z");
  let clock = 0;
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      // A multi-minute mailbox walk: any clock read after this returns a later instant.
      clock += 5;
      return [message("m1", "work")];
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ work: { lastRunTimestamp: "2026-10-08T08:00:00.000Z" } });

  const result = await fetchIncremental({
    accounts: [{ accountId: "work" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    now: () => new Date(start.getTime() + clock * 60_000),
  });

  expect(result).toEqual({ fetched: 1, failures: 0, accountsFetched: 1 });
  expect(state.writes).toEqual([{ accountId: "work", date: start }]);
});

test("stamps the requested source on every fetch, defaulting to m365", async () => {
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [];
    },
  };
  const log = recordingLogPort();
  const state = memoryState({});

  await fetchIncremental({
    accounts: [{ accountId: "work" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    // With no stored history id the Gmail path is the list path: profile first, then the walk.
    gmail: gmailSeams({ profile: "H1" }).seam,
  });

  expect(calls.map((call) => call.source)).toEqual(["gmail"]);
  expect(calls[0]?.folder).toBe("INBOX");
});

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "incremental-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

test("the real state writer preserves a key owned by another provider (STATE_MERGE)", async () => {
  await mkdir(join(configDir, "state"), { recursive: true, mode: 0o700 });
  // A legacy-format fixture (`state/work.json`, Stories 5.1/5.2); the m365 reader reads it back.
  await writeFile(join(configDir, "state", "work.json"), JSON.stringify({ lastHistoryId: "42" }), "utf8");
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      return [message("m1", "work")];
    },
  };
  const log = recordingLogPort();
  const start = new Date("2026-10-09T12:00:00.000Z");

  const result = await fetchIncremental({
    accounts: [{ accountId: "work" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: (accountName) => readAccountState(accountName, { configDir }),
    writeLastRunTimestamp: (accountName, date) => writeLastRunTimestamp(accountName, date, { configDir }),
    now: () => start,
  });

  expect(result).toEqual({ fetched: 1, failures: 0, accountsFetched: 1 });
  expect(await readAccountState("work", { configDir })).toEqual({
    lastHistoryId: "42",
    lastRunTimestamp: "2026-10-09T12:00:00.000Z",
  });
  // The merged result landed in the namespaced file (EC2); the legacy fixture is untouched.
  expect(await readFile(join(configDir, "state", "m365-work.json"), "utf8")).toContain("lastHistoryId");
});

/** A Gmail DTO, as both the history walk and the INBOX walk return one. */
function gmailMessage(id: string, accountId: string): MessageDTO {
  return { ...message(id, accountId), source: "gmail" };
}

interface GmailHistoryCall {
  accountId: string;
  historyId: string;
  batchSize?: number;
}

/** A scripted Gmail seam plus a record of its calls, so a cycle's chosen path is assertable. */
function gmailSeams(script: {
  profile?: string;
  history?: GmailHistoryOutcome;
  profileError?: Error;
  historyError?: Error;
  historyIdWriteError?: Error;
}): {
  seam: GmailIncrementalSeam;
  profileCalls: string[];
  historyCalls: GmailHistoryCall[];
  historyIdWrites: Array<{ accountId: string; historyId: string }>;
} {
  const profileCalls: string[] = [];
  const historyCalls: GmailHistoryCall[] = [];
  const historyIdWrites: Array<{ accountId: string; historyId: string }> = [];
  return {
    profileCalls,
    historyCalls,
    historyIdWrites,
    seam: {
      history: {
        async fetchHistoryId(accountId) {
          profileCalls.push(accountId);
          if (script.profileError !== undefined) throw script.profileError;
          return script.profile ?? "H0";
        },
        async fetchHistory(opts) {
          historyCalls.push(opts);
          if (script.historyError !== undefined) throw script.historyError;
          return script.history ?? { kind: "expired" };
        },
      },
      async writeLastHistoryId(accountId, historyId) {
        if (script.historyIdWriteError !== undefined) throw script.historyIdWriteError;
        historyIdWrites.push({ accountId, historyId });
      },
    },
  };
}

test("resumes a gmail account from its stored history id and advances both keys (HAPPY_HISTORY)", async () => {
  const history = gmailSeams({
    history: { kind: "ok", messages: [gmailMessage("m1", "personal"), gmailMessage("m2", "personal")], historyId: "H3", skippedIds: [] },
  });
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("a stored history id must not walk the label list");
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ personal: { lastHistoryId: "H2", lastRunTimestamp: "2026-10-08T08:00:00.000Z" } });
  const start = new Date("2026-10-09T12:00:00.000Z");

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
    now: () => start,
  });

  expect(result).toEqual({ fetched: 2, failures: 0, accountsFetched: 1 });
  // The walk resumes from the stored id and never reads the profile.
  expect(history.historyCalls).toEqual([{ accountId: "personal", historyId: "H2" }]);
  expect(history.profileCalls).toEqual([]);
  // The recorded id is the response's, and the cycle start is recorded with it.
  expect(history.historyIdWrites).toEqual([{ accountId: "personal", historyId: "H3" }]);
  expect(state.writes).toEqual([{ accountId: "personal", date: start }]);
  expect(log.entries).toEqual([{ level: "info", message: "Fetched 2 messages.", context: { accountId: "personal" } }]);
});

test("a gmail account with no state reads the profile before walking the whole INBOX (FIRST_RUN_NO_STATE)", async () => {
  const history = gmailSeams({ profile: "H5" });
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [gmailMessage("m1", opts.accountId)];
    },
  };
  const log = recordingLogPort();
  const state = memoryState({});
  const start = new Date("2026-10-09T13:00:00.000Z");

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
    now: () => start,
  });

  expect(result).toEqual({ fetched: 1, failures: 0, accountsFetched: 1 });
  expect(history.profileCalls).toEqual(["personal"]);
  expect(history.historyCalls).toEqual([]);
  // The whole INBOX, unbounded: no stored cycle start means no lower bound is folded in.
  expect(calls.map((call) => [call.accountId, call.folder, call.source, call.since])).toEqual([
    ["personal", "INBOX", "gmail", undefined],
  ]);
  // The id recorded is the one read before the walk, so a message arriving mid-cycle is re-fetched.
  expect(history.historyIdWrites).toEqual([{ accountId: "personal", historyId: "H5" }]);
  expect(state.writes).toEqual([{ accountId: "personal", date: start }]);
});

test("a gmail account with a cycle start but no history id bounds its INBOX walk by that instant (BH7)", async () => {
  const stored = "2026-10-08T08:00:00.000Z";
  const history = gmailSeams({ profile: "H5" });
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [gmailMessage("m1", opts.accountId)];
    },
  };
  const log = recordingLogPort();
  // The post-partial-write or cross-provider shape: a timestamp without a cursor.
  const state = memoryState({ personal: { lastRunTimestamp: stored } });
  const start = new Date("2026-10-09T16:00:00.000Z");

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
    now: () => start,
  });

  expect(result).toEqual({ fetched: 1, failures: 0, accountsFetched: 1 });
  // The profile is read first (no stored history id), then the INBOX walk carries the stored bound.
  expect(history.profileCalls).toEqual(["personal"]);
  expect(calls[0]?.since?.toISOString()).toBe(stored);
  expect(history.historyIdWrites).toEqual([{ accountId: "personal", historyId: "H5" }]);
  expect(state.writes).toEqual([{ accountId: "personal", date: start }]);
});

test("an expired gmail history warns by name and falls back to the bounded INBOX walk (HISTORY_EXPIRED)", async () => {
  const stored = "2026-10-08T08:00:00.000Z";
  const history = gmailSeams({ profile: "H9", history: { kind: "expired" } });
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [gmailMessage("m1", opts.accountId)];
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ personal: { lastHistoryId: "H1", lastRunTimestamp: stored } });
  const start = new Date("2026-10-09T14:00:00.000Z");

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
    now: () => start,
  });

  expect(result).toEqual({ fetched: 1, failures: 0, accountsFetched: 1 });
  // A warning naming the account, not a silent skip and not a failure.
  expect(log.entries).toContainEqual({
    level: "warn",
    message: expect.stringContaining('"personal"'),
    context: { accountId: "personal" },
  });
  // The stored cycle start bounds the fallback walk.
  expect(calls[0]?.since?.toISOString()).toBe(stored);
  // The profile is read before that walk, so the id recorded predates it.
  expect(history.profileCalls).toEqual(["personal"]);
  expect(history.historyIdWrites).toEqual([{ accountId: "personal", historyId: "H9" }]);
  expect(state.writes).toEqual([{ accountId: "personal", date: start }]);
});

test("an empty history page fetches nothing but still advances the cursor (HISTORY_EMPTY)", async () => {
  const history = gmailSeams({ history: { kind: "ok", messages: [], historyId: "H7", skippedIds: [] } });
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("an empty history page must not walk the label list");
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ personal: { lastHistoryId: "H6" } });
  const start = new Date("2026-10-09T15:00:00.000Z");

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
    now: () => start,
  });

  expect(result).toEqual({ fetched: 0, failures: 0, accountsFetched: 1 });
  expect(history.historyIdWrites).toEqual([{ accountId: "personal", historyId: "H7" }]);
  expect(state.writes).toEqual([{ accountId: "personal", date: start }]);
});

test("a purged message's id is skipped with a warn naming it, and the cycle still records state (PART_DELETED)", async () => {
  const history = gmailSeams({
    history: { kind: "ok", messages: [gmailMessage("m1", "personal")], historyId: "H2", skippedIds: ["purged"] },
  });
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("must not be called");
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ personal: { lastHistoryId: "H1" } });
  const start = new Date("2026-10-09T17:00:00.000Z");

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
    now: () => start,
  });

  // Warned, not failed: the surviving message was fetched and both keys advance.
  expect(result).toEqual({ fetched: 1, failures: 0, accountsFetched: 1 });
  expect(log.entries).toContainEqual({
    level: "warn",
    message: expect.stringContaining('"purged"'),
    context: { accountId: "personal" },
  });
  expect(log.entries).not.toContainEqual(expect.objectContaining({ level: "error" }));
  expect(history.historyIdWrites).toEqual([{ accountId: "personal", historyId: "H2" }]);
  expect(state.writes).toEqual([{ accountId: "personal", date: start }]);
});

test("a failed profile read fails that account with no state write (PROFILE_FAIL)", async () => {
  const history = gmailSeams({
    profileError: new Error('Gmail refused to read the profile for account "personal" (HTTP 500).'),
  });
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("must not be called");
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ personal: {} });

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
  });

  expect(result).toEqual({ fetched: 0, failures: 1, accountsFetched: 0 });
  expect(history.historyIdWrites).toEqual([]);
  expect(state.writes).toEqual([]);
  expect(log.entries).toEqual([
    {
      level: "error",
      message: 'Gmail refused to read the profile for account "personal" (HTTP 500).',
      context: { accountId: "personal" },
    },
  ]);
});

test("a failed history walk or detail batch leaves lastHistoryId untouched (BATCH_FAIL)", async () => {
  const history = gmailSeams({
    historyError: new Error('Gmail refused to fetch message details for account "personal" (HTTP 500).'),
  });
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("must not be called");
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ personal: { lastHistoryId: "H1", lastRunTimestamp: "2026-10-08T08:00:00.000Z" } });

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
  });

  expect(result).toEqual({ fetched: 0, failures: 1, accountsFetched: 0 });
  expect(history.historyIdWrites).toEqual([]);
  expect(state.writes).toEqual([]);
  expect(log.entries).toEqual([
    {
      level: "error",
      message: 'Gmail refused to fetch message details for account "personal" (HTTP 500).',
      context: { accountId: "personal" },
    },
  ]);
});

test("a gmail state write failure still counts the messages and keeps the previous state (STATE_WRITE_FAIL)", async () => {
  const history = gmailSeams({
    history: { kind: "ok", messages: [gmailMessage("m1", "personal")], historyId: "H2", skippedIds: [] },
    historyIdWriteError: new StateFileError("STATE_WRITE_FAILED", "personal", 'Could not write the state for account "personal".'),
  });
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("must not be called");
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ personal: { lastHistoryId: "H1", lastRunTimestamp: "2026-10-08T08:00:00.000Z" } });

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
  });

  expect(result).toEqual({ fetched: 1, failures: 1, accountsFetched: 1 });
  // The id write failed first, so the cycle start was never recorded either.
  expect(history.historyIdWrites).toEqual([]);
  expect(state.writes).toEqual([]);
  expect(log.entries).toContainEqual({
    level: "error",
    message: 'Could not write the state for account "personal".',
    context: { accountId: "personal" },
  });
});

test("the reverse write order is pinned too: the history id lands, then the cycle start fails (BH8)", async () => {
  const history = gmailSeams({
    history: { kind: "ok", messages: [gmailMessage("m1", "personal")], historyId: "H2", skippedIds: [] },
  });
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("must not be called");
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ personal: { lastHistoryId: "H1" } });

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: async () => {
      throw new StateFileError('STATE_WRITE_FAILED', 'personal', 'Could not write the state for account "personal".');
    },
    source: "gmail",
    gmail: history.seam,
  });

  // The cursor already advanced (safe: the next walk re-covers the window), but the account still
  // counts as failed and the cycle start did not move.
  expect(result).toEqual({ fetched: 1, failures: 1, accountsFetched: 1 });
  expect(history.historyIdWrites).toEqual([{ accountId: "personal", historyId: "H2" }]);
  expect(state.writes).toEqual([]);
  expect(log.entries.filter((entry) => entry.level === "error")).toHaveLength(1);
});

test("a gmail account with invalid state fails while the other still fetches (STATE_READ_FAIL)", async () => {
  const history = gmailSeams({
    history: { kind: "ok", messages: [gmailMessage("m1", "healthy")], historyId: "H2", skippedIds: [] },
  });
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("must not be called");
    },
  };
  const log = recordingLogPort();
  const state = memoryState({ healthy: { lastHistoryId: "H1" } });

  const result = await fetchIncremental({
    accounts: [{ accountId: "broken" }, { accountId: "healthy" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: async (accountName) => {
      if (accountName === "broken") {
        throw new StateFileError("STATE_INVALID", accountName, `State for account "broken" is invalid.`);
      }
      return state.readAccountState(accountName);
    },
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
  });

  expect(result).toEqual({ fetched: 1, failures: 1, accountsFetched: 1 });
  expect(history.historyIdWrites).toEqual([{ accountId: "healthy", historyId: "H2" }]);
  expect(log.entries).toContainEqual({
    level: "error",
    message: 'State for account "broken" is invalid.',
    context: { accountId: "broken" },
  });
});

test("a gmail run without the Gmail seam fails loudly before any account, never as an m365 walk (BH9)", async () => {
  const readAccountStateCalls: string[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("must not be called");
    },
  };

  await expect(
    fetchIncremental({
      accounts: [{ accountId: "personal" }],
      mailPort,
      logPort: recordingLogPort().logPort,
      readAccountState: async (accountName) => {
        readAccountStateCalls.push(accountName);
        return {};
      },
      writeLastRunTimestamp: async () => {},
      source: "gmail",
    }),
  ).rejects.toThrow(/Gmail incremental seam/);
  // Hoisted above the account loop: no state read happens for the broken wiring.
  expect(readAccountStateCalls).toEqual([]);
});

test("a failed gmail list-path walk counts the account and records no state (FETCH_FAIL)", async () => {
  const history = gmailSeams({ profile: "H5" });
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error('Gmail refused to list messages for account "personal" (HTTP 500).');
    },
  };
  const log = recordingLogPort();
  const state = memoryState({});

  const result = await fetchIncremental({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    source: "gmail",
    gmail: history.seam,
  });

  expect(result).toEqual({ fetched: 0, failures: 1, accountsFetched: 0 });
  // A failed cycle records nothing — not even the pre-walk profile id the fallback read first.
  expect(history.historyIdWrites).toEqual([]);
  expect(state.writes).toEqual([]);
  expect(log.entries).toEqual([
    {
      level: "error",
      message: 'Gmail refused to list messages for account "personal" (HTTP 500).',
      context: { accountId: "personal", folder: "INBOX" },
    },
  ]);
});
