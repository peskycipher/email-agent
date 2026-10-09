import { Command } from "commander";
import { runAuth } from "./commands/auth.js";
import { runBackfill } from "./commands/backfill.js";
import { runSyncCategories } from "./commands/sync-categories.js";
import { resolveCliCommand, type CliOptions } from "./dispatch.js";

const program = new Command();

program
  .name("email-classify")
  .description("Multi-account email triage: authenticate, fetch, classify and label mail.")
  .option("--auth <provider>", 'authenticate a provider; "m365" or "gmail"')
  .option(
    "--account <name|all>",
    "account to act on (a per-account settings name, or 'all' for every enabled account; defaults to 'all' for --sync-categories and --backfill)",
  )
  .option("--sync-categories", "ensure the taxonomy's labels exist as M365 master categories and Gmail labels")
  .option("--backfill", "fetch every selected account's messages (m365 backfill; nothing is written back)")
  .option("--source <provider>", 'message source for --backfill; only "m365" today (defaults to "m365")')
  .addHelpText(
    "after",
    "\nExamples:\n  $ email-classify --auth m365 --account work\n  $ email-classify --auth m365 --account all\n  $ email-classify --auth gmail --account personal\n  $ email-classify --auth gmail --account all\n  $ email-classify --sync-categories --account all\n  $ email-classify --backfill --source m365 --account work\n  $ email-classify --backfill --source m365 --account all\n",
  )
  .action(async (options: CliOptions) => {
    const command = resolveCliCommand(options);
    if (command.kind === "error") {
      process.stderr.write(`${command.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (command.kind === "sync") {
      process.exitCode = await runSyncCategories({ account: command.account });
      return;
    }
    if (command.kind === "backfill") {
      process.exitCode = await runBackfill({ source: command.source, account: command.account });
      return;
    }
    process.exitCode = await runAuth({ provider: command.provider, account: command.account });
  });

await program.parseAsync(process.argv);
