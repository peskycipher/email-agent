import { Command } from "commander";
import { runAuth } from "./commands/auth.js";
import { runBackfill } from "./commands/backfill.js";
import { runCron } from "./commands/cron.js";
import { runSyncCategories } from "./commands/sync-categories.js";
import { resolveCliCommand, type CliOptions } from "./dispatch.js";

/**
 * The four command entry points the CLI can run, one member per `run*`. Kept as an interface so
 * `createProgram` can be driven by fakes in tests and `defaultHandlers` can be asserted to wire
 * the real imports. The optional runtime parameters the real functions accept are omitted here:
 * a handler is only ever called with its command options from the entry point.
 */
export interface CliHandlers {
  runAuth: (options: { provider: string; account: string }) => Promise<number>;
  runSyncCategories: (options: { account: string }) => Promise<number>;
  runBackfill: (options: { source: "m365" | "gmail"; account: string; since?: Date; batchSize?: number }) => Promise<number>;
  runCron: (options: { source: "m365" | "gmail" | "all"; account: string; intervalMinutes: number }) => Promise<number>;
}

/** The shipped wiring: the real command functions, identity-stable for the entry-point pin. */
export const defaultHandlers: CliHandlers = {
  runAuth,
  runSyncCategories,
  runBackfill,
  runCron,
};

/**
 * Build the commander program without parsing argv or running anything, so a test can import and
 * drive it. `resolveCliCommand` stays the only routing authority; failures are reported on stderr
 * and the observable exit code is left on `process.exitCode`.
 */
export function createProgram(handlers: CliHandlers): Command {
  const program = new Command();

  program
    .name("email-classify")
    .description("Multi-account email triage: authenticate, fetch, classify and label mail.")
    .option("--auth <provider>", 'authenticate a provider; "m365" or "gmail"')
    .option(
      "--account <name|all>",
      "account to act on (a per-account settings name, or 'all' for every enabled account; defaults to 'all' for --sync-categories, --backfill and --cron)",
    )
    .option("--sync-categories", "ensure the taxonomy's labels exist as M365 master categories and Gmail labels")
    .option("--backfill", "fetch, classify and label every selected account's messages (m365 or gmail backfill; labels are written back)")
    .option("--cron", "recurring mode: every --interval minutes fetch what is new per selected account, classify it and write the labels back (gmail window: INBOX only; loops until stopped)")
    .option(
      "--source <provider>",
      'message source for --backfill/--cron; "m365" or "gmail", and "all" runs both providers in one --cron loop (defaults to "m365")',
    )
    .option("--since <date>", "--backfill only: fetch messages received on or after this date (default: all time)")
    .option("--batch-size <n>", "--backfill only: per-account fetch batch, clamped to the provider's maximum (default: 50)")
    .option("--interval <minutes>", "--cron only: minutes between cycles, 1-1440 (default: 15)")
    .addHelpText(
      "after",
      "\nExamples:\n  $ email-classify --auth m365 --account work\n  $ email-classify --auth m365 --account all\n  $ email-classify --auth gmail --account personal\n  $ email-classify --auth gmail --account all\n  $ email-classify --sync-categories --account all\n  $ email-classify --backfill --source m365 --account work\n  $ email-classify --backfill --source m365 --account all\n  $ email-classify --backfill --source gmail --account all\n  $ email-classify --backfill --source gmail --account all --since 2026-01-01 --batch-size 100\n  $ email-classify --cron --source m365 --account work\n  $ email-classify --cron --source m365 --account all\n  $ email-classify --cron --source gmail --account work\n  $ email-classify --cron --source gmail --account all\n  $ email-classify --cron --source all --account all\n  $ email-classify --cron --source m365 --account work --interval 5\n\nState: --backfill takes ~/.config/email-classify/run.lock for its whole run, so a second invocation exits 1 instead of racing; --cron takes and releases it around each cycle, so a backfill may interleave between cycles. Both record every completed message in ~/.config/email-classify/idempotency.db, and --backfill also resumes from that record — delete that file to force a full re-classification on the next backfill. A --cron run instead resumes each account from its own cursor in ~/.config/email-classify/state/, so an already-walked window is not repeated either way. --auth and --sync-categories never take the lock.\n",
    )
    .action(async (options: CliOptions) => {
      const command = resolveCliCommand(options);
      if (command.kind === "error") {
        process.stderr.write(`${command.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (command.kind === "sync") {
        process.exitCode = await handlers.runSyncCategories({ account: command.account });
        return;
      }
      if (command.kind === "backfill") {
        process.exitCode = await handlers.runBackfill({
          source: command.source,
          account: command.account,
          ...(command.since === undefined ? {} : { since: command.since }),
          ...(command.batchSize === undefined ? {} : { batchSize: command.batchSize }),
        });
        return;
      }
      if (command.kind === "cron") {
        process.exitCode = await handlers.runCron({
          source: command.source,
          account: command.account,
          intervalMinutes: command.intervalMinutes,
        });
        return;
      }
      process.exitCode = await handlers.runAuth({ provider: command.provider, account: command.account });
    });

  return program;
}

/**
 * Parse `argv` against a program built from `handlers` and return the resulting exit code. The
 * shipped executable passes `process.argv` and `defaultHandlers` and assigns the result to
 * `process.exitCode`; no argv is parsed and nothing runs until this is called.
 *
 * Only routes that reach the action body return a code. Commander's own `--help` and its
 * unknown-option and missing-argument paths call `process.exit` from inside `parseAsync` (there is
 * no `exitOverride`), so they terminate the process instead of returning — the same behaviour the
 * executable had before this seam existed.
 */
export async function runCli(argv: readonly string[], handlers: CliHandlers): Promise<number> {
  process.exitCode = 0;
  const program = createProgram(handlers);
  await program.parseAsync(argv);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}
