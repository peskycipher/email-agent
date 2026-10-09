import { expect, test } from "vitest";
import type { FetchOpts } from "../../src/core/dto/FetchOpts.js";
import type { MessageDTO } from "../../src/core/dto/MessageDTO.js";
import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_FOLDERS,
  fetchAllMessages,
  type MessageFetchTarget,
} from "../../src/orch/fetch.js";

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
    logPort: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
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

test("one account's failure never aborts the others and is counted (MULTI_ACCOUNT)", async () => {
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      if (opts.accountId === "work") {
        throw new Error('Microsoft Graph refused to list messages for account "work" (HTTP 403).');
      }
      return [message("m1", "home"), message("m2", "home")];
    },
  };
  const log = recordingLogPort();

  const result = await fetchAllMessages({
    accounts: [{ accountId: "work" }, { accountId: "home" }],
    mailPort,
    logPort: log.logPort,
  });

  expect(result).toEqual({ fetched: 2, failures: 1 });
  // Sequential, in plan order: the failed account first, the healthy one after it.
  expect(calls.map((call) => call.accountId)).toEqual(["work", "home"]);
  expect(log.entries).toEqual([
    {
      level: "error",
      message: 'Microsoft Graph refused to list messages for account "work" (HTTP 403).',
      context: { accountId: "work", folder: "Inbox" },
    },
    { level: "info", message: "Fetched 2 messages.", context: { accountId: "home" } },
  ]);
});

test("defaults each account to Inbox and batchSize 50, one request per folder (DEFAULTS)", async () => {
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [];
    },
  };
  const log = recordingLogPort();

  await fetchAllMessages({ accounts: [{ accountId: "work" }], mailPort, logPort: log.logPort });

  expect(DEFAULT_FOLDERS).toEqual(["Inbox"]);
  expect(DEFAULT_BATCH_SIZE).toBe(50);
  expect(calls).toEqual([{ source: "m365", accountId: "work", folder: "Inbox", batchSize: 50 }]);
});

test("walks an account's folders in order and sums their totals (MULTI_FOLDER)", async () => {
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return opts.folder === "Inbox" ? [message("m1", "work"), message("m2", "work")] : [message("m3", "work")];
    },
  };
  const log = recordingLogPort();

  const result = await fetchAllMessages({
    accounts: [{ accountId: "work", folders: ["Inbox", "Archive"], batchSize: 100 }],
    mailPort,
    logPort: log.logPort,
  });

  expect(calls.map((call) => call.folder)).toEqual(["Inbox", "Archive"]);
  expect(calls.every((call) => call.batchSize === 100)).toBe(true);
  expect(result).toEqual({ fetched: 3, failures: 0 });
  expect(log.entries).toEqual([
    { level: "info", message: "Fetched 3 messages.", context: { accountId: "work" } },
  ]);
});

test("a failure in one folder does not stop the account's other folders (MULTI_FOLDER)", async () => {
  const attempted: Array<string | undefined> = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      attempted.push(opts.folder);
      if (opts.folder === "Archive") throw new Error("boom");
      return [message("m1", "work")];
    },
  };
  const log = recordingLogPort();

  const result = await fetchAllMessages({
    accounts: [{ accountId: "work", folders: ["Archive", "Inbox"] }],
    mailPort,
    logPort: log.logPort,
  });

  expect(attempted).toEqual(["Archive", "Inbox"]);
  expect(result).toEqual({ fetched: 1, failures: 1 });
  expect(log.entries).toEqual([
    { level: "error", message: "boom", context: { accountId: "work", folder: "Archive" } },
  ]);
});

test("both of one account's folders failing counts that account once (MULTI_FOLDER)", async () => {
  const attempted: Array<string | undefined> = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      attempted.push(opts.folder);
      throw new Error(`boom ${opts.folder}`);
    },
  };
  const log = recordingLogPort();

  const result = await fetchAllMessages({
    accounts: [{ accountId: "work", folders: ["Inbox", "Archive"] }],
    mailPort,
    logPort: log.logPort,
  });

  // The CLI prints "N of M account(s) failed.", so failures counts accounts, never folders.
  expect(attempted).toEqual(["Inbox", "Archive"]);
  expect(result).toEqual({ fetched: 0, failures: 1 });
  expect(log.entries).toEqual([
    { level: "error", message: "boom Inbox", context: { accountId: "work", folder: "Inbox" } },
    { level: "error", message: "boom Archive", context: { accountId: "work", folder: "Archive" } },
  ]);
});

test("an account with an empty folder list falls back to the default", async () => {
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [];
    },
  };
  const log = recordingLogPort();

  await fetchAllMessages({
    accounts: [{ accountId: "work", folders: [] }],
    mailPort,
    logPort: log.logPort,
  });

  expect(calls).toEqual([{ source: "m365", accountId: "work", folder: "Inbox", batchSize: 50 }]);
});

test("a non-Error rejection is rendered as a line, not a crash", async () => {
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw "token store unavailable";
    },
  };
  const log = recordingLogPort();

  const result = await fetchAllMessages({ accounts: [{ accountId: "work" }], mailPort, logPort: log.logPort });

  expect(result).toEqual({ fetched: 0, failures: 1 });
  expect(log.entries).toEqual([
    { level: "error", message: "token store unavailable", context: { accountId: "work", folder: "Inbox" } },
  ]);
});

test("forwards an account's since instant into every folder's FetchOpts (INCREMENTAL)", async () => {
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [];
    },
  };
  const log = recordingLogPort();
  const since = new Date("2026-10-09T00:00:00.000Z");

  await fetchAllMessages({
    accounts: [{ accountId: "work", folders: ["Inbox", "Archive"], since }],
    mailPort,
    logPort: log.logPort,
  });

  expect(calls).toEqual([
    { source: "m365", accountId: "work", folder: "Inbox", batchSize: 50, since },
    { source: "m365", accountId: "work", folder: "Archive", batchSize: 50, since },
  ]);
});

test("an account without since issues no lower bound, so the backfill stays filterless", async () => {
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [];
    },
  };
  const log = recordingLogPort();

  await fetchAllMessages({ accounts: [{ accountId: "work" }], mailPort, logPort: log.logPort });

  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toHaveProperty("since");
});

test("stamps the requested source on every fetch", async () => {
  const calls: FetchOpts[] = [];
  const mailPort: MessageFetchTarget = {
    async fetchMessages(opts) {
      calls.push(opts);
      return [];
    },
  };
  const log = recordingLogPort();

  await fetchAllMessages({
    accounts: [{ accountId: "personal" }],
    mailPort,
    logPort: log.logPort,
    source: "gmail",
  });

  expect(calls).toEqual([{ source: "gmail", accountId: "personal", folder: "Inbox", batchSize: 50 }]);
});

test("an empty account list is a no-op", async () => {
  const mailPort: MessageFetchTarget = {
    async fetchMessages() {
      throw new Error("must not be called");
    },
  };
  const log = recordingLogPort();

  const result = await fetchAllMessages({ accounts: [], mailPort, logPort: log.logPort });

  expect(result).toEqual({ fetched: 0, failures: 0 });
  expect(log.entries).toHaveLength(0);
});
