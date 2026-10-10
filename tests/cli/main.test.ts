import { afterEach, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createProgram, defaultHandlers, runCli, type CliHandlers } from "../../src/cli/main.js";
import { runAuth } from "../../src/cli/commands/auth.js";
import { runBackfill } from "../../src/cli/commands/backfill.js";
import { runCron } from "../../src/cli/commands/cron.js";
import { runSyncCategories } from "../../src/cli/commands/sync-categories.js";

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

/** The exact `Examples:` block this entry point shipped before the refactor; every line is contract. */
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
].join("\n");

test("createProgram pins the program name, every flag description and all thirteen examples", () => {
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
      "fetch only what is new per selected account (m365 or gmail incremental; the gmail window is the account's INBOX only; nothing is written back)",
    ],
    [
      "--source",
      'message source for --backfill/--cron; "m365" or "gmail" (defaults to "m365"; "all" is not a provider)',
    ],
    ["--since", "--backfill only: fetch messages received on or after this date (default: all time)"],
    [
      "--batch-size",
      "--backfill only: per-account fetch batch, clamped to the provider's maximum (default: 50)",
    ],
  ]);

  program.outputHelp();

  expect(capturedLines(stdout).join("")).toContain(EXAMPLES_BLOCK);
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

test("--cron --source gmail --account work passes both through to runCron (CRON)", async () => {
  const { handlers, calls } = recordingHandlers();

  const code = await runCli(argv("--cron", "--source", "gmail", "--account", "work"), handlers);

  expect(code).toBe(0);
  expect(calls).toEqual([{ handler: "runCron", options: { source: "gmail", account: "work" } }]);
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
