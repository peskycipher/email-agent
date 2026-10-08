import { expect, test } from "vitest";
import { syncCategories, type CategorySyncTarget } from "../../src/orch/sync.js";
import type { LabelDef } from "../../src/core/dto/LabelDef.js";
import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";

const LABELS: LabelDef[] = [
  { name: "Action Needed", description: "Needs a response.", m365Color: "preset0", gmailColor: "#E67C73" },
  { name: "Crypto", description: "Crypto mail.", m365Color: "preset4", gmailColor: "#3ECCE9" },
];

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

test("syncs every account with the taxonomy and returns 0 when all succeed", async () => {
  const calls: Array<{ accountId: string; labels: LabelDef[] }> = [];
  const mailPort: CategorySyncTarget = {
    async ensureCategories(accountId, labels) {
      calls.push({ accountId, labels });
    },
  };
  const log = recordingLogPort();

  const failures = await syncCategories({
    accounts: ["work", "home"],
    labels: LABELS,
    mailPort,
    logPort: log.logPort,
  });

  expect(failures).toBe(0);
  expect(calls).toEqual([
    { accountId: "work", labels: LABELS },
    { accountId: "home", labels: LABELS },
  ]);
  expect(log.entries.map((entry) => [entry.level, entry.context?.accountId])).toEqual([
    ["info", "work"],
    ["info", "home"],
  ]);
  expect(log.entries[0]?.message).toBe("Ensured 2 categories.");
});

test("a provider noun names what was ensured, without changing the default", async () => {
  const mailPort: CategorySyncTarget = {
    async ensureCategories() {},
  };
  const log = recordingLogPort();

  const failures = await syncCategories({
    accounts: ["personal"],
    labels: LABELS,
    mailPort,
    logPort: log.logPort,
    noun: "labels",
  });

  expect(failures).toBe(0);
  expect(log.entries).toEqual([
    { level: "info", message: "Ensured 2 labels.", context: { accountId: "personal" } },
  ]);
});

test("a failing account is logged with its accountId and never aborts the rest (ISOLATION)", async () => {
  const attempted: string[] = [];
  const mailPort: CategorySyncTarget = {
    async ensureCategories(accountId) {
      attempted.push(accountId);
      if (accountId === "work") throw new Error('Microsoft Graph refused to list the master categories for account "work" (HTTP 403).');
    },
  };
  const log = recordingLogPort();

  const failures = await syncCategories({
    accounts: ["work", "home"],
    labels: LABELS,
    mailPort,
    logPort: log.logPort,
  });

  expect(failures).toBe(1);
  expect(attempted).toEqual(["work", "home"]);
  expect(log.entries).toEqual([
    {
      level: "error",
      message: 'Microsoft Graph refused to list the master categories for account "work" (HTTP 403).',
      context: { accountId: "work" },
    },
    { level: "info", message: expect.stringContaining("2"), context: { accountId: "home" } },
  ]);
});

test("a non-Error rejection is rendered as a line, not a crash", async () => {
  const mailPort: CategorySyncTarget = {
    async ensureCategories(accountId) {
      if (accountId === "work") throw "token store unavailable";
    },
  };
  const log = recordingLogPort();

  const failures = await syncCategories({
    accounts: ["work", "home"],
    labels: LABELS,
    mailPort,
    logPort: log.logPort,
  });

  expect(failures).toBe(1);
  expect(log.entries[0]).toEqual({ level: "error", message: "token store unavailable", context: { accountId: "work" } });
});

test("an empty account list is a no-op", async () => {
  const mailPort: CategorySyncTarget = {
    async ensureCategories() {
      throw new Error("must not be called");
    },
  };
  const log = recordingLogPort();

  const failures = await syncCategories({ accounts: [], labels: LABELS, mailPort, logPort: log.logPort });

  expect(failures).toBe(0);
  expect(log.entries).toHaveLength(0);
});
