import { afterEach, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createProgram, defaultHandlers, runCli, type CliHandlers } from "../../src/cli/main.js";
import { runAuth } from "../../src/cli/commands/auth.js";
import { runBackfill } from "../../src/cli/commands/backfill.js";
import { runCron } from "../../src/cli/commands/cron.js";
import { runSyncCategories } from "../../src/cli/commands/sync-categories.js";
import { createShutdown, type ShutdownTarget } from "../../src/cli/shutdown.js";

type HandlerName = keyof CliHandlers;

function recordingHandlers(codes: Partial<Record<HandlerName, number>> = {}): {
  handlers: CliHandlers;
  calls: Array<{ handler: HandlerName; options: unknown }>;
} {
  const calls: Array<{ handler: HandlerName; options: unknown }> = [];
  const record = (handler: HandlerName, options: unknown): number => {
    calls.push({ handler, options });
    return codes[handler] ?? 0;
  };
  const handlers: CliHandlers = {
    runAuth: async (options) => record("runAuth", options),
    runSyncCategories: async (options) => record("runSyncCategories", options),
    runBackfill: async (options) => record("runBackfill", options),
    runCron: async (options) => record("runCron", options),
  };
  return { handlers, calls };
}

/** Mirrors the shipped `process.argv`: `argv[0]` is node, `argv[1]` the script, then user args. */
function argv(...args: string[]): string[] {
  return ["node", "email-classify", ...args];
}

/** A `ShutdownTarget` recorder, so the signal seam's registrations are observable. */
function signalTarget(): { target: ShutdownTarget; registrations: string[] } {
  const registrations: string[] = [];
  return { registrations, target: { on: (signal) => registrations.push(signal) } };
}

/** Handlers that record the runtime seam `createProgram` hands the two signal-handling routes. */
function runtimeRecordingHandlers(): {
  handlers: CliHandlers;
  runtimes: Array<{ handler: HandlerName; runtime: unknown }>;
} {
  const runtimes: Array<{ handler: HandlerName; runtime: unknown }> = [];
  return {
    runtimes,
    handlers: {
      runAuth: async () => 0,
      runSyncCategories: async () => 0,
      runBackfill: async (_options, runtime) => {
        runtimes.push({ handler: "runBackfill", runtime });
        return 0;
      },
      runCron: async (_options, runtime) => {
        runtimes.push({ handler: "runCron", runtime });
        return 0;
      },
    },
  };
}

function capturedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

test("importing the builder module writes no output, runs nothing and does not exit (IMPORT SIDE EFFECT)", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
  vi.resetModules();

  await import("../../src/cli/main.js");

  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
});

test("defaultHandlers wires the real command functions, not lookalikes", () => {
  expect(defaultHandlers.runAuth).toBe(runAuth);
  expect(defaultHandlers.runSyncCategories).toBe(runSyncCategories);
  expect(defaultHandlers.runBackfill).toBe(runBackfill);
  expect(defaultHandlers.runCron).toBe(runCron);
});

/** The exact `Examples:` block this entry point ships; every line is contract. */
const EXAMPLES_BLOCK = [
  "Examples:",
  "  $ email-classify --auth m365 --account work",
  "  $ email-classify --auth m365 --account all",
  "  $ email-classify --auth gmail --account personal",
  "  $ email-classify --auth gmail --account all",
  "  $ email-classify --sync-categories --account all",
  "  $ email-classify --backfill --source m365 --account work",
  "  $ email-classify --backfill --source m365 --account all",
  "  $ email-classify --backfill --source gmail --account all",
  "  $ email-classify --backfill --source gmail --account all --since 2026-01-01 --batch-size 100",
  "  $ email-classify --cron --source m365 --account work",
  "  $ email-classify --cron --source m365 --account all",
  "  $ email-classify --cron --source gmail --account work",
  "  $ email-classify --cron --source gmail --account all",
  "  $ email-classify --cron --source all --account all",
  "  $ email-classify --cron --source m365 --account work --interval 5",
].join("\n");

test("createProgram pins the program name, every flag description and all sixteen examples", () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { handlers } = recordingHandlers();
  const program = createProgram(handlers);

  expect(program.name()).toBe("email-classify");
  expect(program.description()).toBe(
    "Multi-account email triage: authenticate, fetch, classify and label mail.",
  );
  expect(program.options.map((option) => [option.long, option.description])).toEqual([
    ["--auth", 'authenticate a provider; "m365" or "gmail"'],
    [
      "--account",
      "account to act on (a per-account settings name, or 'all' for every enabled account; defaults to 'all' for --sync-categories, --backfill and --cron)",
    ],
    ["--sync-categories", "ensure the taxonomy's labels exist as M365 master categories and Gmail labels"],
    [
      "--backfill",
      "fetch, classify and label every selected account's messages (m365 or gmail backfill; labels are written back)",
    ],
    [
      "--cron",
      "recurring mode: every --interval minutes fetch what is new per selected account, classify it and write the labels back (gmail window: INBOX only; loops until stopped)",
    ],
    [
      "--source",
      'message source for --backfill/--cron; "m365" or "gmail", and "all" runs both providers in one --cron loop (defaults to "m365")',
    ],
    ["--since", "--backfill only: fetch messages received on or after this date (default: all time)"],
    [
      "--batch-size",
      "--backfill only: per-account fetch batch, clamped to the provider's maximum (default: 50)",
    ],
    ["--interval", "--cron only: minutes between cycles, 1-1440 (default: 15)"],
  ]);

  program.outputHelp();

  expect(capturedLines(stdout).join("")).toContain(EXAMPLES_BLOCK);
  // The durable state a run leaves behind is user-facing: the lock it takes and the store a
  // resumed run reads (Story 8.2).
  const help = capturedLines(stdout).join("");
  expect(help).toContain("~/.config/email-classify/run.lock");
  expect(help).toContain("~/.config/email-classify/idempotency.db");
});

test("--auth gmail --account work calls runAuth and exits 0 (AUTH)", async () => {
  const { handlers, calls } = recordingHandlers();

  const code = await runCli(argv("--auth", "gmail", "--account", "work"), handlers);

  expect(code).toBe(0);
  expect(calls).toEqual([{ handler: "runAuth", options: { provider: "gmail", account: "work" } }]);
});

test("--sync-categories defaults --account to all and calls runSyncCategories (SYNC)", async () => {
  const { handlers, calls } = recordingHandlers();

  const code = await runCli(argv("--sync-categories"), handlers);

  expect(code).toBe(0);
  expect(calls).toEqual([{ handler: "runSyncCategories", options: { account: "all" } }]);
});

test("--backfill --account all defaults --source to m365 and calls runBackfill (BACKFILL)", async () => {
  const { handlers, calls } = recordingHandlers();

  const code = await runCli(argv("--backfill", "--account", "all"), handlers);

  expect(code).toBe(0);
  expect(calls).toEqual([{ handler: "runBackfill", options: { source: "m365", account: "all" } }]);
});

test("--cron --source gmail --account work passes both and the interval through to runCron (CRON)", async () => {
  const { handlers, calls } = recordingHandlers();

  const code = await runCli(argv("--cron", "--source", "gmail", "--account", "work"), handlers);

  expect(code).toBe(0);
  expect(calls).toEqual([
    { handler: "runCron", options: { source: "gmail", account: "work", intervalMinutes: 15 } },
  ]);
});

test("--cron --interval 5 reaches runCron as the cycle interval (INTERVAL)", async () => {
  const { handlers, calls } = recordingHandlers();

  const code = await runCli(argv("--cron", "--source", "all", "--interval", "5"), handlers);

  expect(code).toBe(0);
  expect(calls).toEqual([
    { handler: "runCron", options: { source: "all", account: "all", intervalMinutes: 5 } },
  ]);
});

test("--cron --source all routes to runCron instead of a routing error (SOURCE_ALL)", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { handlers, calls } = recordingHandlers();

  const code = await runCli(argv("--cron", "--source", "all"), handlers);

  expect(code).toBe(0);
  expect(calls).toEqual([
    { handler: "runCron", options: { source: "all", account: "all", intervalMinutes: 15 } },
  ]);
  expect(stderr).not.toHaveBeenCalled();
});

test("--cron attaches the coordinator and hands it to runCron (SIGNAL_ROUTING)", async () => {
  const { target, registrations } = signalTarget();
  const shutdown = createShutdown({ target, exit: () => {} });
  const { handlers, runtimes } = runtimeRecordingHandlers();

  const code = await runCli(argv("--cron", "--source", "m365"), handlers, shutdown);

  expect(code).toBe(0);
  expect(registrations).toEqual(["SIGINT", "SIGTERM"]);
  expect(runtimes).toEqual([{ handler: "runCron", runtime: { shutdown } }]);
});

test("--backfill attaches the coordinator and hands it to runBackfill (SIGNAL_ROUTING)", async () => {
  const { target, registrations } = signalTarget();
  const shutdown = createShutdown({ target, exit: () => {} });
  const { handlers, runtimes } = runtimeRecordingHandlers();

  const code = await runCli(argv("--backfill", "--source", "gmail"), handlers, shutdown);

  expect(code).toBe(0);
  expect(registrations).toEqual(["SIGINT", "SIGTERM"]);
  expect(runtimes).toEqual([{ handler: "runBackfill", runtime: { shutdown } }]);
});

test("--auth and --sync-categories never attach the coordinator (SIGNAL_ROUTING)", async () => {
  const { target, registrations } = signalTarget();
  const shutdown = createShutdown({ target, exit: () => {} });
  const { handlers, runtimes } = runtimeRecordingHandlers();

  await runCli(argv("--auth", "m365", "--account", "work"), handlers, shutdown);
  await runCli(argv("--sync-categories"), handlers, shutdown);

  // The two lock-free routes take no signal handler and receive no runtime seam.
  expect(registrations).toEqual([]);
  expect(runtimes).toEqual([]);
});

test("a handler's non-zero code becomes the CLI exit code (NON-ZERO handler)", async () => {
  const { handlers } = recordingHandlers({ runCron: 2 });

  const code = await runCli(argv("--cron", "--source", "gmail", "--account", "work"), handlers);

  expect(code).toBe(2);
});

test("--backfill --source all reports on stderr, exits 1 and runs no handler (ROUTING ERROR)", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { handlers, calls } = recordingHandlers();

  const code = await runCli(argv("--backfill", "--source", "all"), handlers);

  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
  expect(capturedLines(stderr)[0]).toContain("--source all is not supported");
});

test("--auth combined with --sync-categories reports on stderr, exits 1 and runs no handler (CONFLICT)", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { handlers, calls } = recordingHandlers();

  const code = await runCli(argv("--auth", "m365", "--account", "work", "--sync-categories"), handlers);

  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
  expect(capturedLines(stderr)[0]).toContain("--auth and --sync-categories");
});

/** The entry file as it exists on disk, so the main-guard's argv[1] comparison has something real. */
const INDEX_FILE = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

test("the shipped entry hands the real process.argv to the real handlers (ENTRY WIRING)", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const savedArgv = process.argv;
  process.argv = ["node", INDEX_FILE, "--backfill", "--source", "all"];
  vi.resetModules();

  try {
    await import("../../src/cli/index.js");
  } finally {
    process.argv = savedArgv;
  }

  // Only the real argv reaching the real resolver produces this message; a sliced argv parses no
  // flag and would report the missing-flags error instead.
  expect(process.exitCode).toBe(1);
  expect(capturedLines(stderr)[0]).toContain("--source all is not supported");
});
