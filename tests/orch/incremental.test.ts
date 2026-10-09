import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { fetchIncremental, type IncrementalAccountState } from "../../src/orch/incremental.js";

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
  });

  expect(calls.map((call) => call.source)).toEqual(["gmail"]);
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
});
