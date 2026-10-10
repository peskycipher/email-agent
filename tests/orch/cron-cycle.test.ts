import { expect, test } from "vitest";
import type { MessageDTO } from "../../src/core/dto/MessageDTO.js";
import type { FetchOpts } from "../../src/core/dto/FetchOpts.js";
import type { Taxonomy } from "../../src/core/dto/Taxonomy.js";
import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";
import type { ModelPort } from "../../src/core/ports/ModelPort.js";
import { RETRY_BACKOFF_MS, runCronCycle, type CronCycleProvider } from "../../src/orch/cron-cycle.js";
import type { ClassificationRecordStore } from "../../src/orch/classification-run.js";
import type { MessageFetchTarget } from "../../src/orch/fetch.js";
import type {
  GmailHistoryOutcome,
  GmailIncrementalSeam,
  IncrementalAccountState,
  ReadAccountState,
} from "../../src/orch/incremental.js";

/** The taxonomy every test classifies against: one label, so the model double's reply validates. */
const TAXONOMY: Taxonomy = [
  { name: "Crypto", description: "Cryptocurrency, blockchain, DeFi, trading, wallet notifications.", m365Color: "preset3", gmailColor: "#3F51B5" },
];

const MODEL_CONFIG = {
  provider: "openai",
  model: "test-model",
  apiKeyEnvVar: "TEST_KEY",
  temperature: 0,
  maxTokens: 100,
} as const;

/** A fixed base clock the whole suite steps deterministically. */
const CYCLE_START = new Date("2026-10-10T12:00:00.000Z");

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
    subject: `Subject ${id}`,
    bodyPreview: `Preview ${id}`,
    senderEmail: `${id}@example.com`,
    senderName: `Sender ${id}`,
    receivedDateTime: "2026-10-10T11:00:00Z",
    existingLabels: [],
    source: "m365",
    accountId,
  };
}

/** A model double that answers the one taxonomy label, optionally rejecting one message by subject. */
function modelDouble(rejectSubject?: string): { model: ModelPort; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    model: {
      async complete(prompt) {
        const user = prompt.user;
        calls.push(user);
        if (rejectSubject !== undefined && user.includes(rejectSubject)) {
          throw new Error(`The model refused to classify "${rejectSubject}" (HTTP 503).`);
        }
        return { labels: ["Crypto"] };
      },
    },
  };
}

/** In-memory 8.2 store; a `record` error stands in for the store's own failure (RECORD_ERROR). */
function memoryStore(initial: Record<string, string[]> = {}, recordError?: Error): {
  store: ClassificationRecordStore;
  records: Map<string, string[]>;
  recordCalls: Array<{ accountId: string; internetMessageId: string; labels: string[] }>;
} {
  const records = new Map(Object.entries(initial));
  const recordCalls: Array<{ accountId: string; internetMessageId: string; labels: string[] }> = [];
  return {
    records,
    recordCalls,
    store: {
      async labelsFor(accountId, internetMessageId) {
        return records.get(`${accountId}|${internetMessageId}`);
      },
      async record(accountId, internetMessageId, labels) {
        if (recordError !== undefined) throw recordError;
        recordCalls.push({ accountId, internetMessageId, labels });
        records.set(`${accountId}|${internetMessageId}`, labels);
      },
    },
  };
}

/** One provider's namespaced state seams, over its own map — the SOURCE_ALL row's isolation proof. */
function memoryState(initial: Record<string, IncrementalAccountState> = {}, timestampWriteError?: Error): {
  state: Record<string, IncrementalAccountState>;
  timestampWrites: Array<{ accountName: string; date: Date }>;
  readAccountState: ReadAccountState;
  writeLastRunTimestamp: (accountName: string, date: Date) => Promise<void>;
} {
  const state = { ...initial };
  const timestampWrites: Array<{ accountName: string; date: Date }> = [];
  return {
    state,
    timestampWrites,
    readAccountState: async (accountName) => state[accountName] ?? {},
    writeLastRunTimestamp: async (accountName, date) => {
      if (timestampWriteError !== undefined) throw timestampWriteError;
      timestampWrites.push({ accountName, date });
    },
  };
}

/** The fetch + write port double; each hook may throw to script a provider failure. */
function portDouble(hooks: {
  fetchMessages?: (opts: FetchOpts, call: number) => MessageDTO[];
  writeLabels?: (accountId: string, messageId: string, labels: string[], call: number) => void;
  ensureCategories?: (accountId: string, labels: Taxonomy, call: number) => void;
}): {
  port: MessageFetchTarget & { writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void> };
  fetchCalls: FetchOpts[];
  writeCalls: Array<{ accountId: string; messageId: string; labels: string[] }>;
  ensureCalls: Array<{ accountId: string; labels: Taxonomy }>;
} {
  const fetchCalls: FetchOpts[] = [];
  const writeCalls: Array<{ accountId: string; messageId: string; labels: string[] }> = [];
  const ensureCalls: Array<{ accountId: string; labels: Taxonomy }> = [];
  return {
    fetchCalls,
    writeCalls,
    ensureCalls,
    port: {
      async fetchMessages(opts) {
        fetchCalls.push(opts);
        return hooks.fetchMessages === undefined ? [] : hooks.fetchMessages(opts, fetchCalls.length - 1);
      },
      async writeLabels(accountId, messageId, labels) {
        writeCalls.push({ accountId, messageId, labels });
        hooks.writeLabels?.(accountId, messageId, labels, writeCalls.length - 1);
      },
      // The cycle's Gmail half calls this before its writes; the hook scripts its failures.
      async ensureCategories(accountId, labels) {
        ensureCalls.push({ accountId, labels });
        hooks.ensureCategories?.(accountId, labels, ensureCalls.length - 1);
      },
    },
  };
}

/** A Gmail seam double over its own recorded writes. */
function gmailSeam(script: { profile?: string; history?: GmailHistoryOutcome; profileError?: Error }): {
  seam: GmailIncrementalSeam;
  historyIdWrites: Array<{ accountName: string; historyId: string }>;
} {
  const historyIdWrites: Array<{ accountName: string; historyId: string }> = [];
  return {
    historyIdWrites,
    seam: {
      history: {
        async fetchHistoryId(accountId) {
          if (script.profileError !== undefined) throw script.profileError;
          return script.profile ?? "H0";
        },
        async fetchHistory() {
          return script.history ?? { kind: "expired" };
        },
      },
      async writeLastHistoryId(accountName, historyId) {
        historyIdWrites.push({ accountName, historyId });
      },
    },
  };
}

/** The sleep recorder: pins the single 30s backoff without ever waiting. */
function sleepRecorder(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

function m365Provider(
  port: ReturnType<typeof portDouble>["port"],
  state: ReturnType<typeof memoryState>,
  accountIds: string[],
): CronCycleProvider {
  return {
    source: "m365",
    accounts: accountIds.map((accountId) => ({ accountId })),
    mailPort: port,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
  };
}

test("a stored cursor's window is fetched, classified, written, recorded and the state advanced (HAPPY_CYCLE)", async () => {
  const log = recordingLogPort();
  const state = memoryState({ work: { lastRunTimestamp: "2026-10-10T08:00:00.000Z" } });
  const port = portDouble({
    fetchMessages: (opts) => [message("m1", opts.accountId), message("m2", opts.accountId)],
  });
  const store = memoryStore();
  const model = modelDouble();

  const result = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: model.model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
    sleep: sleepRecorder().sleep,
  });

  expect(result.fetched).toBe(2);
  expect(result.labeled).toBe(2);
  expect(result.skipped).toBe(0);
  expect(result.alreadyDone).toBe(0);
  expect(result.errors).toBe(0);
  expect(result.failures).toBe(0);
  expect(result.failedAccounts).toEqual([]);
  // The stored cursor bounds the fetch; the cycle start is what gets committed.
  expect(port.fetchCalls[0]?.since?.toISOString()).toBe("2026-10-10T08:00:00.000Z");
  expect(port.writeCalls.map((call) => [call.accountId, call.messageId])).toEqual([
    ["work", "m1"],
    ["work", "m2"],
  ]);
  expect([...store.records.keys()].sort()).toEqual(["work|<m1@example.com>", "work|<m2@example.com>"]);
  expect(state.timestampWrites).toEqual([{ accountName: "work", date: CYCLE_START }]);
  expect(result.startedAt).toEqual(CYCLE_START);
  expect(result.durationMs).toBe(0);
});

test("no stored state walks the whole window and creates the account's state (FIRST_CYCLE)", async () => {
  const log = recordingLogPort();
  const state = memoryState();
  const port = portDouble({ fetchMessages: (opts) => [message("m1", opts.accountId)] });
  const store = memoryStore();

  const result = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
  });

  expect(result.fetched).toBe(1);
  // A first cycle is unbounded on the wire: the fetch carries no `since`.
  expect(port.fetchCalls[0]).not.toHaveProperty("since");
  expect(state.timestampWrites).toEqual([{ accountName: "work", date: CYCLE_START }]);
});

test("one message's classification error is logged naming it, holds the account's state, and the next cycle skips the completed ones and retries the failed one (CLASSIFY_ERROR)", async () => {
  const log = recordingLogPort();
  const state = memoryState({ work: { lastRunTimestamp: "2026-10-10T08:00:00.000Z" } });
  const port = portDouble({
    fetchMessages: (opts) => [message("m1", opts.accountId), message("m2", opts.accountId)],
  });
  const store = memoryStore();
  const failing = modelDouble("Subject m2");
  const clock = { now: () => CYCLE_START };

  const first = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: failing.model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: clock.now,
  });

  expect(first.errors).toBe(1);
  expect(first.labeled).toBe(1);
  expect(first.failures).toBe(0);
  expect(log.entries).toContainEqual({
    level: "error",
    message: 'The model refused to classify "Subject m2" (HTTP 503).',
    context: { accountId: "work", messageId: "m2" },
  });
  // The held cursor is the re-queue: no state advanced after the errored cycle.
  expect(state.timestampWrites).toEqual([]);

  // The retry cycle: the same window again — m1 answers through the store (no model call), m2
  // is genuinely re-classified, and the clean cycle commits the cursor.
  const recovering = modelDouble();
  const second = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: recovering.model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: clock.now,
  });
  expect(second.alreadyDone).toBe(1);
  expect(second.labeled).toBe(1);
  expect(second.errors).toBe(0);
  expect(recovering.calls).toHaveLength(1);
  expect(recovering.calls[0]).toContain("Subject m2");
  expect(state.timestampWrites).toEqual([{ accountName: "work", date: CYCLE_START }]);
});

test("a fetch failure backs off 30 seconds, retries once, and a second failure counts the account failed with its cursor held while the other account still runs (FETCH_ERROR)", async () => {
  const log = recordingLogPort();
  const state = memoryState({ work: { lastRunTimestamp: "2026-10-10T08:00:00.000Z" } });
  let workFetches = 0;
  const port = portDouble({
    fetchMessages: (opts) => {
      if (opts.accountId === "work") {
        workFetches += 1;
        throw new Error('Microsoft Graph refused to list messages for account "work" (HTTP 500).');
      }
      return [message("home-m1", opts.accountId)];
    },
  });
  const store = memoryStore();
  const { sleeps, sleep } = sleepRecorder();

  const result = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work", "home"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
    sleep,
  });

  // The failed account's cycle ran twice: the attempt and its one retry.
  expect(workFetches).toBe(2);
  expect(sleeps).toEqual([RETRY_BACKOFF_MS]);
  expect(result.failures).toBe(1);
  expect(result.failedAccounts).toEqual(["work"]);
  expect(result.fetched).toBe(1);
  expect(result.labeled).toBe(1);
  expect(log.entries).toContainEqual({
    level: "warn",
    message: expect.stringContaining('Account "work" failed its cycle — backing off 30 seconds'),
    context: { accountId: "work" },
  });
  expect(log.entries).toContainEqual({
    level: "error",
    message: 'Account "work" failed again after one retry — its cursor is held; the next cycle re-fetches the window.',
    context: { accountId: "work" },
  });
  // The failed account's cursor stayed held; the healthy one's advanced.
  expect(state.timestampWrites).toEqual([{ accountName: "home", date: CYCLE_START }]);
});

test("a given-up throttled batch retires through the flat retry, and a later account is never aborted or skipped (GIVE_UP)", async () => {
  const log = recordingLogPort();
  const state = memoryState({ work: { lastRunTimestamp: "2026-10-10T08:00:00.000Z" } });
  let workFetches = 0;
  const port = portDouble({
    fetchMessages: (opts) => {
      if (opts.accountId !== "work") return [message("home-m1", opts.accountId)];
      workFetches += 1;
      // The adapter already walked its five-retry ladder per call and gave up; what reaches the
      // cycle is one typed line naming the account — which the cycle treats like any other
      // fetch failure: the flat retry, never a ladder of its own (FLAT_KEEP / the two-mechanisms rule).
      // A local error object, not a provider's class: the orch layer is provider-agnostic.
      throw Object.assign(
        new Error(`Gmail kept throttling account "${opts.accountId}" — the call was abandoned after 5 backoff retries (HTTP 429).`),
        { code: "RATE_LIMIT_GAVE_UP", status: 429 },
      );
    },
  });
  const store = memoryStore();
  const { sleeps, sleep } = sleepRecorder();

  const result = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work", "home"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
    sleep,
  });

  // The given-up batch's account ran its attempt and its one flat retry, then failed for the cycle.
  expect(workFetches).toBe(2);
  // Exactly the one flat wait — the 30s backoff. The same recorder also serves the adapters'
  // ladder seam, but this double throws before any adapter sleeps, so the single entry is the flat retry.
  expect(sleeps).toEqual([RETRY_BACKOFF_MS]);
  expect(result.failures).toBe(1);
  expect(result.failedAccounts).toEqual(["work"]);
  // The throttled account's failure did not abort or skip the account after it.
  expect(result.fetched).toBe(1);
  expect(result.labeled).toBe(1);
  expect(log.entries).toContainEqual({
    level: "error",
    message: 'Account "work" failed again after one retry — its cursor is held; the next cycle re-fetches the window.',
    context: { accountId: "work" },
  });
  expect(state.timestampWrites).toEqual([{ accountName: "home", date: CYCLE_START }]);
});

test("a fetch failure that recovers on its one retry commits the state and counts no failure (FETCH_RETRY_RECOVERS)", async () => {
  const log = recordingLogPort();
  const state = memoryState();
  let fetches = 0;
  const port = portDouble({
    fetchMessages: (opts) => {
      fetches += 1;
      if (fetches === 1) throw new Error("transient network failure");
      return [message("m1", opts.accountId)];
    },
  });
  const store = memoryStore();
  const { sleeps, sleep } = sleepRecorder();

  const result = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
    sleep,
  });

  expect(fetches).toBe(2);
  expect(sleeps).toEqual([RETRY_BACKOFF_MS]);
  expect(result.failures).toBe(0);
  expect(result.labeled).toBe(1);
  expect(state.timestampWrites).toEqual([{ accountName: "work", date: CYCLE_START }]);
});

test("a writeLabels failure earns the same single backoff-and-retry, and the retry's clean cycle commits (WRITE_ERROR)", async () => {
  const log = recordingLogPort();
  const state = memoryState();
  const port = portDouble({
    fetchMessages: (opts) => [message("m1", opts.accountId)],
    writeLabels: (_accountId, messageId, _labels, call) => {
      if (call === 0) throw new Error('Microsoft Graph refused to patch message "m1" (HTTP 500).');
    },
  });
  const store = memoryStore();
  const { sleeps, sleep } = sleepRecorder();

  const result = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
    sleep,
  });

  expect(sleeps).toEqual([RETRY_BACKOFF_MS]);
  expect(result.failures).toBe(0);
  expect(result.errors).toBe(0);
  // The retried cycle re-fetched the window (the cursor was held) and its write landed.
  expect(port.fetchCalls).toHaveLength(2);
  expect(port.writeCalls).toHaveLength(2);
  expect(state.timestampWrites).toEqual([{ accountName: "work", date: CYCLE_START }]);
});

test("a writeLabels failure twice counts the account failed with its cursor held (WRITE_ERROR_TWICE)", async () => {
  const log = recordingLogPort();
  const state = memoryState();
  const port = portDouble({
    fetchMessages: (opts) => [message("m1", opts.accountId)],
    writeLabels: () => {
      throw new Error('Microsoft Graph refused to patch message "m1" (HTTP 500).');
    },
  });
  const store = memoryStore();
  const { sleep } = sleepRecorder();

  const result = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
    sleep,
  });

  expect(result.failures).toBe(1);
  expect(result.failedAccounts).toEqual(["work"]);
  // The failed write never recorded and never advanced the cursor: the next cycle retries it.
  expect(store.records.size).toBe(0);
  expect(state.timestampWrites).toEqual([]);
  expect(log.entries).toContainEqual({
    level: "error",
    message: 'Account "work" failed again after one retry — its cursor is held; the next cycle re-fetches the window.',
    context: { accountId: "work" },
  });
});

test("a Gmail ensureCategories failure earns the same single backoff-and-retry, and the retry commits (ENSURE_RETRY_RECOVERS)", async () => {
  const log = recordingLogPort();
  const state = memoryState({ personal: { lastHistoryId: "H1" } });
  const seam = gmailSeam({
    history: { kind: "ok", messages: [{ ...message("g1", "personal"), source: "gmail" }], historyId: "H2", skippedIds: [] },
  });
  const port = portDouble({
    fetchMessages: () => {
      throw new Error("a stored history id must not walk the label list");
    },
    // The first attempt's labels.list call fails; the retried attempt's succeeds.
    ensureCategories: (_accountId, _labels, call) => {
      if (call === 0) throw new Error("Gmail refused to list the labels for account \"personal\" (HTTP 503).");
    },
  });
  const store = memoryStore();
  const { sleeps, sleep } = sleepRecorder();
  const provider: CronCycleProvider = {
    source: "gmail",
    accounts: [{ accountId: "personal" }],
    mailPort: port.port,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    gmail: seam.seam,
  };

  const result = await runCronCycle({
    providers: [provider],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
    sleep,
  });

  expect(sleeps).toEqual([RETRY_BACKOFF_MS]);
  expect(result.failures).toBe(0);
  expect(port.ensureCalls).toHaveLength(2);
  expect(port.writeCalls).toHaveLength(1);
  expect(seam.historyIdWrites).toEqual([{ accountName: "personal", historyId: "H2" }]);
  expect(state.timestampWrites).toEqual([{ accountName: "personal", date: CYCLE_START }]);
  // The retried attempt re-fetched the window (the cursor was held) and its detail batch too.
  expect(log.entries.filter((entry) => entry.level === "error")).toHaveLength(1);
});

test("a Gmail ensureCategories failure twice counts the account failed with its cursor held (ENSURE_ERROR_TWICE)", async () => {
  const log = recordingLogPort();
  const state = memoryState({ personal: { lastHistoryId: "H1" } });
  const seam = gmailSeam({
    history: { kind: "ok", messages: [{ ...message("g1", "personal"), source: "gmail" }], historyId: "H2", skippedIds: [] },
  });
  const port = portDouble({
    fetchMessages: () => {
      throw new Error("a stored history id must not walk the label list");
    },
    ensureCategories: () => {
      throw new Error("Gmail refused to list the labels for account \"personal\" (HTTP 503).");
    },
  });
  const store = memoryStore();
  const { sleeps, sleep } = sleepRecorder();
  const provider: CronCycleProvider = {
    source: "gmail",
    accounts: [{ accountId: "personal" }],
    mailPort: port.port,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    gmail: seam.seam,
  };

  const result = await runCronCycle({
    providers: [provider],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
    sleep,
  });

  expect(result.failures).toBe(1);
  expect(result.failedAccounts).toEqual(["personal"]);
  expect(sleeps).toEqual([RETRY_BACKOFF_MS]);
  // Nothing was written, nothing recorded and nothing committed: the next cycle retries it all.
  expect(port.writeCalls).toHaveLength(0);
  expect(store.records.size).toBe(0);
  expect(seam.historyIdWrites).toEqual([]);
  expect(state.timestampWrites).toEqual([]);
  expect(log.entries).toContainEqual({
    level: "error",
    message: 'Account "personal" failed again after one retry — its cursor is held; the next cycle re-fetches the window.',
    context: { accountId: "personal" },
  });
});

test("a store record failure after a landed write counts the error and holds the cursor so the next cycle retries the message (RECORD_ERROR)", async () => {
  const log = recordingLogPort();
  const state = memoryState();
  const port = portDouble({ fetchMessages: (opts) => [message("m1", opts.accountId)] });
  const store = memoryStore({}, new Error("the idempotency store is unavailable"));

  const first = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
  });

  // The write stood (8.2's rule); the error is counted and the cursor held — no backoff retry,
  // the next cycle owns the retry.
  expect(first.errors).toBe(1);
  expect(first.failures).toBe(0);
  expect(port.writeCalls).toHaveLength(1);
  expect(state.timestampWrites).toEqual([]);

  const recovering = memoryStore();
  const second = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: recovering.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
  });
  expect(second.labeled).toBe(1);
  expect(second.alreadyDone).toBe(0);
  expect(state.timestampWrites).toEqual([{ accountName: "work", date: CYCLE_START }]);
});

test("a state-commit failure after a clean cycle counts the account failed and holds the cursor (COMMIT_ERROR)", async () => {
  const log = recordingLogPort();
  const state = memoryState({}, new Error('Could not write the state for account "work".'));
  const port = portDouble({ fetchMessages: (opts) => [message("m1", opts.accountId)] });
  const store = memoryStore();

  const result = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
  });

  // The message landed in the store, but the account's cursor did not advance, so the account
  // never reads as a successful one.
  expect(result.failures).toBe(1);
  expect(result.failedAccounts).toEqual(["work"]);
  expect(result.labeled).toBe(1);
  expect(store.records.size).toBe(1);
  expect(log.entries).toContainEqual({
    level: "error",
    message: 'Could not write the state for account "work".',
    context: { accountId: "work" },
  });
});

test("a Gmail cycle commits the history id and the cycle start through the provider's own seams (GMAIL_COMMIT)", async () => {
  const log = recordingLogPort();
  const state = memoryState({ personal: { lastHistoryId: "H1" } });
  const seam = gmailSeam({
    history: { kind: "ok", messages: [{ ...message("g1", "personal"), source: "gmail" }], historyId: "H2", skippedIds: [] },
  });
  const port = portDouble({ fetchMessages: () => { throw new Error("a stored history id must not walk the label list"); } });
  const store = memoryStore();
  const provider: CronCycleProvider = {
    source: "gmail",
    accounts: [{ accountId: "personal" }],
    mailPort: port.port,
    readAccountState: state.readAccountState,
    writeLastRunTimestamp: state.writeLastRunTimestamp,
    gmail: seam.seam,
  };

  const result = await runCronCycle({
    providers: [provider],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
  });

  expect(result.labeled).toBe(1);
  expect(result.failures).toBe(0);
  expect(seam.historyIdWrites).toEqual([{ accountName: "personal", historyId: "H2" }]);
  expect(state.timestampWrites).toEqual([{ accountName: "personal", date: CYCLE_START }]);
});

test("a gmail provider without its seam is a wiring fault thrown before any account runs (NO_SEAM)", async () => {
  const state = memoryState();
  const port = portDouble({});

  await expect(
    runCronCycle({
      providers: [
        {
          source: "gmail",
          accounts: [{ accountId: "personal" }],
          mailPort: port.port,
          readAccountState: state.readAccountState,
          writeLastRunTimestamp: state.writeLastRunTimestamp,
        },
      ],
      store: memoryStore().store,
      taxonomy: TAXONOMY,
      model: modelDouble().model,
      config: MODEL_CONFIG,
      logPort: recordingLogPort().logPort,
      now: () => CYCLE_START,
    }),
  ).rejects.toThrow(/Gmail incremental seam/);
  expect(port.fetchCalls).toEqual([]);
});

test("--source all runs both providers' accounts in one cycle, each through its own namespaced state (SOURCE_ALL)", async () => {
  const log = recordingLogPort();
  // The same-named account on both providers: isolation is the per-provider seams.
  const m365State = memoryState();
  const gmailState = memoryState();
  const seam = gmailSeam({
    profile: "H5",
  });
  const port = portDouble({
    fetchMessages: (opts) => [message(`${opts.source}-${opts.accountId}`, opts.accountId)],
  });
  const gmailPort = portDouble({
    fetchMessages: (opts) => [{ ...message("gmail-shared", opts.accountId), source: "gmail" }],
  });
  const store = memoryStore();

  const result = await runCronCycle({
    providers: [
      {
        source: "m365",
        accounts: [{ accountId: "shared" }],
        mailPort: port.port,
        readAccountState: m365State.readAccountState,
        writeLastRunTimestamp: m365State.writeLastRunTimestamp,
      },
      {
        source: "gmail",
        accounts: [{ accountId: "shared" }],
        mailPort: gmailPort.port,
        readAccountState: gmailState.readAccountState,
        writeLastRunTimestamp: gmailState.writeLastRunTimestamp,
        gmail: seam.seam,
      },
    ],
    store: store.store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now: () => CYCLE_START,
  });

  expect(result.fetched).toBe(2);
  expect(result.labeled).toBe(2);
  expect(result.failures).toBe(0);
  // Each provider's cursor advanced through its own seams — never the other's.
  expect(m365State.timestampWrites).toEqual([{ accountName: "shared", date: CYCLE_START }]);
  expect(gmailState.timestampWrites).toEqual([{ accountName: "shared", date: CYCLE_START }]);
  expect(seam.historyIdWrites).toEqual([{ accountName: "shared", historyId: "H5" }]);
});

test("the cycle reports its start and duration from the injected clock (DURATION)", async () => {
  const log = recordingLogPort();
  const state = memoryState();
  const port = portDouble({ fetchMessages: (opts) => [message("m1", opts.accountId)] });
  let tick = 0;
  const now = () => new Date(CYCLE_START.getTime() + tick++ * 2_500);

  const result = await runCronCycle({
    providers: [m365Provider(port.port, state, ["work"])],
    store: memoryStore().store,
    taxonomy: TAXONOMY,
    model: modelDouble().model,
    config: MODEL_CONFIG,
    logPort: log.logPort,
    now,
  });

  expect(result.startedAt).toEqual(CYCLE_START);
  // The clock is read once before the cycle, once for the account's own cycle start (the second
  // read — what gets committed) and once after it; the duration is the first-to-last delta.
  expect(result.durationMs).toBe(5_000);
  expect(state.timestampWrites).toEqual([
    { accountName: "work", date: new Date(CYCLE_START.getTime() + 2_500) },
  ]);
});
