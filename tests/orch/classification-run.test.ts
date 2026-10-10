import { expect, test } from "vitest";
import type { FetchOpts } from "../../src/core/dto/FetchOpts.js";
import type { MessageDTO } from "../../src/core/dto/MessageDTO.js";
import type { ModelConfig } from "../../src/core/dto/ModelConfig.js";
import type { Taxonomy } from "../../src/core/dto/Taxonomy.js";
import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";
import type { ModelPort } from "../../src/core/ports/ModelPort.js";
import { runBackfillAccounts, type BackfillAccount, type ClassificationRecordStore, type LabelWriteTarget } from "../../src/orch/classification-run.js";
import type { MessageFetchTarget } from "../../src/orch/fetch.js";

const TAXONOMY: Taxonomy = [
  { name: "Crypto", description: "Crypto mail.", m365Color: "preset0", gmailColor: "#000000" },
];
const CONFIG: ModelConfig = {
  provider: "jev",
  model: "jev-latest",
  apiKeyEnvVar: "TYPESAFE_API_KEY",
  temperature: 0.1,
  maxTokens: 500,
};

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
    internetMessageId: `${id}@example.com`,
    subject: "Subject",
    bodyPreview: "Body",
    senderEmail: "a@example.com",
    senderName: "A",
    receivedDateTime: "2026-01-01T00:00:00Z",
    existingLabels: [],
    source: "m365",
    accountId,
  };
}

/**
 * A `ModelPort` double that answers the real classification contract: `complete` resolves the
 * raw reply, and `completeWithRetry` validates it against the taxonomy. `byId` keys on the
 * message id, which `buildPrompt` writes into the user half — so a scripted reply can vary per
 * message without the double knowing about classification.
 */
function modelDouble(byId: Record<string, string[]>, options: { reject?: boolean } = {}): ModelPort {
  return {
    async complete(prompt): Promise<unknown> {
      if (options.reject === true) throw new Error("model transport rejected");
      // The double selects its reply by the message subject, which `buildPrompt` writes into
      // the user half; that keeps it ignorant of the classification contract it feeds.
      const subject = /^Subject: (.*)$/m.exec(prompt.user)?.[1] ?? "";
      return { labels: byId[subject] ?? [] };
    },
  };
}

/** Messages whose subject doubles as the double's lookup key. */
function messageWithSubject(id: string, accountId: string, subject: string): MessageDTO {
  return { ...message(id, accountId), subject };
}

/** A port double recording every call: fetch per folder, and every label write. */
function portDouble(options: {
  messagesByFolder?: Record<string, MessageDTO[]>;
  fetchError?: string;
  writeError?: string;
}): {
  port: MessageFetchTarget & LabelWriteTarget;
  writes: Array<{ accountId: string; messageId: string; labels: string[] }>;
  fetches: FetchOpts[];
} {
  const writes: Array<{ accountId: string; messageId: string; labels: string[] }> = [];
  const fetches: FetchOpts[] = [];
  return {
    writes,
    fetches,
    port: {
      async fetchMessages(opts: FetchOpts): Promise<MessageDTO[]> {
        fetches.push(opts);
        if (options.fetchError !== undefined) throw new Error(options.fetchError);
        return options.messagesByFolder?.[opts.folder ?? ""] ?? [];
      },
      async writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void> {
        if (options.writeError !== undefined) throw new Error(options.writeError);
        writes.push({ accountId, messageId, labels });
      },
    },
  };
}

/**
 * A `ClassificationRecordStore` double over a plain map: the pre-classify lookup answers for a
 * recorded pair, `record` stores one. `failRead`/`failWrite` make one call throw, so the loop's
 * isolation of a store failure is observable rather than inferred.
 */
function storeDouble(seed: Array<{ accountId: string; internetMessageId: string }> = [], options: {
  failRead?: boolean;
  failWrite?: boolean;
} = {}): {
  store: ClassificationRecordStore;
  records: Array<{ accountId: string; internetMessageId: string; labels: string[] }>;
} {
  const pairs = new Set(seed.map((pair) => `${pair.accountId}|${pair.internetMessageId}`));
  const records: Array<{ accountId: string; internetMessageId: string; labels: string[] }> = [];
  return {
    records,
    store: {
      async labelsFor(accountId: string, internetMessageId: string): Promise<string[] | undefined> {
        if (options.failRead === true) throw new Error("store read exploded");
        return pairs.has(`${accountId}|${internetMessageId}`) ? ["Crypto"] : undefined;
      },
      async record(accountId: string, internetMessageId: string, labels: string[]): Promise<void> {
        if (options.failWrite === true) throw new Error("store write exploded");
        pairs.add(`${accountId}|${internetMessageId}`);
        records.push({ accountId, internetMessageId, labels });
      },
    },
  };
}

const ACCOUNT: BackfillAccount = { accountId: "acc-1", folders: ["Inbox"] };

function run(
  accounts: BackfillAccount[],
  port: MessageFetchTarget & LabelWriteTarget,
  model: ModelPort,
  logPort: LogPort,
  store: ClassificationRecordStore = storeDouble().store,
) {
  return runBackfillAccounts({
    accounts,
    store,
    mailPort: port,
    taxonomy: TAXONOMY,
    model,
    config: CONFIG,
    logPort,
    source: "m365",
  });
}

test("classifies and writes each fetched message (HAPPY_PATH)", async () => {
  const { port, writes } = portDouble({
    messagesByFolder: {
      Inbox: [
        messageWithSubject("m1", "acc-1", "Crypto"),
        messageWithSubject("m2", "acc-1", "Crypto"),
        messageWithSubject("m3", "acc-1", "Crypto"),
      ],
    },
  });
  const { logPort } = recordingLogPort();
  const { store, records } = storeDouble();
  const model = modelDouble({ Crypto: ["Crypto"] });
  const result = await run([ACCOUNT], port, model, logPort, store);
  expect(result.fetched).toBe(3);
  expect(result.labeled).toBe(3);
  expect(result.skipped).toBe(0);
  expect(result.alreadyDone).toBe(0);
  expect(result.failures).toBe(0);
  // Each finished message is recorded once, under the pair the next run looks up.
  expect(records).toEqual([
    { accountId: "acc-1", internetMessageId: "m1@example.com", labels: ["Crypto"] },
    { accountId: "acc-1", internetMessageId: "m2@example.com", labels: ["Crypto"] },
    { accountId: "acc-1", internetMessageId: "m3@example.com", labels: ["Crypto"] },
  ]);
  expect(writes).toEqual([
    { accountId: "acc-1", messageId: "m1", labels: ["Crypto"] },
    { accountId: "acc-1", messageId: "m2", labels: ["Crypto"] },
    { accountId: "acc-1", messageId: "m3", labels: ["Crypto"] },
  ]);
});

test("an empty label set writes nothing, records the empty outcome, and counts as skipped (EMPTY_LABEL_SET, NO_WRITE_ALSO_RECORDED)", async () => {
  const { port, writes } = portDouble({
    messagesByFolder: { Inbox: [messageWithSubject("m1", "acc-1", "Unmatched")] },
  });
  const { logPort } = recordingLogPort();
  const { store, records } = storeDouble();
  const result = await run([ACCOUNT], port, modelDouble({ Unmatched: [] }), logPort, store);
  expect(writes).toHaveLength(0);
  expect(result.skipped).toBe(1);
  expect(result.labeled).toBe(0);
  expect(result.errors).toBe(0);
  // The empty outcome is durable: the next run counts the message already done, not skipped again.
  expect(records).toEqual([{ accountId: "acc-1", internetMessageId: "m1@example.com", labels: [] }]);
});

test("a recorded message is skipped before any classify call and no write is attempted (ALREADY_DONE)", async () => {
  const { port, writes } = portDouble({
    messagesByFolder: {
      Inbox: [messageWithSubject("m1", "acc-1", "Crypto"), messageWithSubject("m2", "acc-1", "Crypto")],
    },
  });
  const { logPort } = recordingLogPort();
  const { store } = storeDouble([{ accountId: "acc-1", internetMessageId: "m1@example.com" }]);
  const model = modelDouble({ Crypto: ["Crypto"] });
  let classified = 0;
  const counting: ModelPort = {
    async complete(prompt): Promise<unknown> {
      classified += 1;
      return model.complete(prompt);
    },
  };

  const result = await run([ACCOUNT], port, counting, logPort, store);

  expect(classified).toBe(1);
  expect(result.alreadyDone).toBe(1);
  expect(result.labeled).toBe(1);
  expect(result.skipped).toBe(0);
  expect(result.errors).toBe(0);
  expect(writes).toEqual([{ accountId: "acc-1", messageId: "m2", labels: ["Crypto"] }]);
});

test("a record under an older taxonomy still reads as already done (STALE_TAXONOMY)", async () => {
  const { port, writes } = portDouble({
    messagesByFolder: { Inbox: [messageWithSubject("m1", "acc-1", "Crypto")] },
  });
  const { logPort, entries } = recordingLogPort();
  // The row was written by an earlier run; the record is keyed by message, not by taxonomy version.
  const { store } = storeDouble([{ accountId: "acc-1", internetMessageId: "m1@example.com" }]);

  const result = await run([ACCOUNT], port, modelDouble({ Crypto: ["Crypto"] }), logPort, store);

  expect(result.alreadyDone).toBe(1);
  expect(result.labeled).toBe(0);
  expect(writes).toHaveLength(0);
  expect(entries.some((entry) => entry.level === "error")).toBe(false);
});

test("a failed classification or write records nothing, so the next run retries it (FAILED_NOT_RECORDED)", async () => {
  const { port } = portDouble({
    messagesByFolder: { Inbox: [messageWithSubject("m1", "acc-1", "Crypto")] },
    writeError: "write exploded",
  });
  const { logPort } = recordingLogPort();
  const { store, records } = storeDouble();

  const writeFailed = await run([ACCOUNT], port, modelDouble({ Crypto: ["Crypto"] }), logPort, store);
  const rejectPort = portDouble({ messagesByFolder: { Inbox: [messageWithSubject("m1", "acc-1", "Crypto")] } });
  const { store: rejectStore, records: rejectRecords } = storeDouble();
  const classifyRejected = await run(
    [ACCOUNT],
    rejectPort.port,
    modelDouble({}, { reject: true }),
    logPort,
    rejectStore,
  );

  expect(writeFailed.errors).toBe(1);
  expect(classifyRejected.errors).toBe(1);
  expect(records).toHaveLength(0);
  expect(rejectRecords).toHaveLength(0);
});

test("a record failure after a landed write is an error and the account's remaining messages continue (STORE_WRITE_FAILS)", async () => {
  const { port, writes } = portDouble({
    messagesByFolder: {
      Inbox: [messageWithSubject("m1", "acc-1", "Crypto"), messageWithSubject("m2", "acc-1", "Crypto")],
    },
  });
  const { logPort, entries } = recordingLogPort();
  const { store } = storeDouble([], { failWrite: true });

  const result = await run([ACCOUNT], port, modelDouble({ Crypto: ["Crypto"] }), logPort, store);

  // Both writes landed, and both record attempts failed: counted as errors, never as labeled, so
  // `fetched = labeled + skipped + alreadyDone + errors` still partitions the two messages.
  expect(writes).toHaveLength(2);
  expect(result.errors).toBe(2);
  expect(result.labeled).toBe(0);
  expect(result.alreadyDone).toBe(0);
  expect(result.labeled + result.skipped + result.alreadyDone + result.errors).toBe(result.fetched);
  expect(entries.some((entry) => entry.level === "error" && entry.context?.messageId === "m1")).toBe(true);
});

test("a store read failure is that message's error and the account's remaining messages continue (STORE_READ_FAILS)", async () => {
  const { port, writes } = portDouble({
    messagesByFolder: {
      Inbox: [messageWithSubject("m1", "acc-1", "Crypto"), messageWithSubject("m2", "acc-1", "Crypto")],
    },
  });
  const { logPort, entries } = recordingLogPort();
  const { store } = storeDouble([], { failRead: true });

  const result = await run([ACCOUNT], port, modelDouble({ Crypto: ["Crypto"] }), logPort, store);

  expect(result.errors).toBe(2);
  expect(result.labeled).toBe(0);
  expect(result.failures).toBe(0);
  expect(writes).toHaveLength(0);
  expect(entries.filter((entry) => entry.level === "error")).toHaveLength(2);
});

test("an empty internetMessageId is never looked up and never recorded, so two such messages never collapse (EMPTY_IDENTITY)", async () => {
  const blank = (id: string): MessageDTO => ({ ...messageWithSubject(id, "acc-1", "Crypto"), internetMessageId: "" });
  const { port, writes } = portDouble({ messagesByFolder: { Inbox: [blank("m1"), blank("m2")] } });
  const { logPort } = recordingLogPort();
  const { store, records } = storeDouble();
  let classified = 0;

  const model: ModelPort = {
    async complete(): Promise<unknown> {
      classified += 1;
      return { labels: ["Crypto"] };
    },
  };
  const result = await run([ACCOUNT], port, model, logPort, store);

  // Both are classified and written — neither is mistaken for the other — and neither is recorded.
  expect(classified).toBe(2);
  expect(writes).toHaveLength(2);
  expect(records).toHaveLength(0);
  expect(result.labeled).toBe(2);
  expect(result.errors).toBe(0);
});

test("an account with no messages classifies and writes nothing (EMPTY_ACCOUNT)", async () => {
  const { port, writes } = portDouble({ messagesByFolder: { Inbox: [] } });
  const { logPort } = recordingLogPort();
  const { store } = storeDouble();
  const result = await run([ACCOUNT], port, modelDouble({}), logPort, store);
  expect(result.fetched).toBe(0);
  expect(result.labeled).toBe(0);
  expect(result.errors).toBe(0);
  expect(writes).toHaveLength(0);
});

test("an empty label set writes nothing and counts as skipped (EMPTY_LABEL_SET)", async () => {
  const { port, writes } = portDouble({
    messagesByFolder: { Inbox: [messageWithSubject("m1", "acc-1", "Unmatched")] },
  });
  const { logPort } = recordingLogPort();
  const result = await run([ACCOUNT], port, modelDouble({ Unmatched: [] }), logPort);
  expect(writes).toHaveLength(0);
  expect(result.skipped).toBe(1);
  expect(result.labeled).toBe(0);
  expect(result.errors).toBe(0);
});

test("one account's fetch failure does not stop the next account (ONE_ACCOUNT_FAILS)", async () => {
  let calls = 0;
  const writes: Array<{ accountId: string; messageId: string; labels: string[] }> = [];
  const port: MessageFetchTarget & LabelWriteTarget = {
    async fetchMessages(): Promise<MessageDTO[]> {
      calls += 1;
      if (calls === 1) throw new Error("fetch exploded");
      return [messageWithSubject("m1", "acc-2", "Crypto")];
    },
    async writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void> {
      writes.push({ accountId, messageId, labels });
    },
  };
  const { logPort, entries } = recordingLogPort();
  const result = await run(
    [
      { accountId: "acc-1", folders: ["Inbox"] },
      { accountId: "acc-2", folders: ["Inbox"] },
    ],
    port,
    modelDouble({ Crypto: ["Crypto"] }),
    logPort,
  );
  expect(result.failures).toBe(1);
  expect(result.fetched).toBe(1);
  expect(writes.map((w) => w.accountId)).toEqual(["acc-2"]);
  expect(entries.some((e) => e.level === "error" && e.context?.accountId === "acc-1")).toBe(true);
});

test("a write failure is logged and the account's remaining messages continue (MESSAGE_WRITE_FAILS)", async () => {
  const { port } = portDouble({
    messagesByFolder: { Inbox: [messageWithSubject("m1", "acc-1", "Crypto")] },
    writeError: "write exploded",
  });
  const { logPort, entries } = recordingLogPort();
  const result = await run([ACCOUNT], port, modelDouble({ Crypto: ["Crypto"] }), logPort);
  expect(result.errors).toBe(1);
  expect(result.failures).toBe(0);
  expect(entries.some((e) => e.level === "error" && e.context?.messageId === "m1")).toBe(true);
});

test("a transport rejection is logged per message and does not stop the account (CLASSIFY_REJECTS)", async () => {
  const { port, writes } = portDouble({
    messagesByFolder: { Inbox: [messageWithSubject("m1", "acc-1", "Crypto")] },
  });
  const { logPort, entries } = recordingLogPort();
  const result = await run([ACCOUNT], port, modelDouble({}, { reject: true }), logPort);
  expect(result.errors).toBe(1);
  expect(result.labeled).toBe(0);
  expect(writes).toHaveLength(0);
  expect(entries.some((e) => e.level === "error" && e.context?.accountId === "acc-1")).toBe(true);
});

test("a fetch failure is not re-counted as a classification failure (BOTH_STAGES_REPORT)", async () => {
  const { port } = portDouble({ fetchError: "fetch exploded" });
  const { logPort } = recordingLogPort();
  const result = await run([ACCOUNT], port, modelDouble({}), logPort);
  expect(result.failures).toBe(1);
  expect(result.errors).toBe(0);
});

test("applies the account's batch size to its fetch (BATCH_SIZE)", async () => {
  const { port, fetches } = portDouble({ messagesByFolder: { Inbox: [] } });
  const { logPort } = recordingLogPort();
  await run([{ accountId: "acc-1", folders: ["Inbox"], batchSize: 100 }], port, modelDouble({}), logPort);
  expect(fetches[0]?.batchSize).toBe(100);
});

test("applies the run's since bound to the fetch (SINCE)", async () => {
  const { port, fetches } = portDouble({ messagesByFolder: { Inbox: [] } });
  const { logPort } = recordingLogPort();
  const since = new Date("2026-01-01T00:00:00Z");
  await run([{ accountId: "acc-1", folders: ["Inbox"], since }], port, modelDouble({}), logPort);
  expect(fetches[0]?.since).toEqual(since);
});

test("counts the five counters so fetched partitions and processed is labeled plus skipped (COUNTERS)", async () => {
  const { port } = portDouble({
    messagesByFolder: {
      Inbox: [
        messageWithSubject("m1", "acc-1", "Crypto"),
        messageWithSubject("m2", "acc-1", "Unmatched"),
        messageWithSubject("m3", "acc-1", "Crypto"),
      ],
    },
  });
  const { logPort } = recordingLogPort();
  const { store } = storeDouble([{ accountId: "acc-1", internetMessageId: "m4@example.com" }]);
  const result = await run([ACCOUNT], port, modelDouble({ Crypto: ["Crypto"], Unmatched: [] }), logPort, store);
  expect(result.labeled).toBe(2);
  expect(result.skipped).toBe(1);
  expect(result.alreadyDone).toBe(0);
  expect(result.errors).toBe(0);
  expect(result.labeled + result.skipped).toBe(3);
  expect(result.labeled + result.skipped + result.alreadyDone + result.errors).toBe(result.fetched);
});

test("a partial folder failure counts only accounts that fetched cleanly (PARTIAL_FOLDER)", async () => {
  const calls: string[] = [];
  const writes: Array<{ accountId: string; messageId: string; labels: string[] }> = [];
  const port: MessageFetchTarget & LabelWriteTarget = {
    async fetchMessages(opts: FetchOpts): Promise<MessageDTO[]> {
      calls.push(opts.folder ?? "");
      if (opts.folder === "Archive") throw new Error("archive fetch failed");
      return opts.folder === "Inbox" ? [messageWithSubject("m1", "acc-1", "Crypto")] : [];
    },
    async writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void> {
      writes.push({ accountId, messageId, labels });
    },
  };
  const { logPort } = recordingLogPort();
  const result = await run(
    [{ accountId: "acc-1", folders: ["Inbox", "Archive"] }],
    port,
    modelDouble({ Crypto: ["Crypto"] }),
    logPort,
  );
  expect(result.failures).toBe(1);
  expect(result.fetched).toBe(0);
  expect(result.labeled).toBe(0);
  expect(result.errors).toBe(0);
  expect(writes).toHaveLength(0);
  expect(calls).toEqual(["Inbox", "Archive"]);
});
