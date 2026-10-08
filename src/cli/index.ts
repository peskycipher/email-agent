import { Command } from "commander";
import { runAuth } from "./commands/auth.js";
import { runSyncCategories } from "./commands/sync-categories.js";
import { resolveCliCommand, type CliOptions } from "./dispatch.js";

const program = new Command();

program
  .name("email-classify")
  .description("Multi-account email triage: authenticate, fetch, classify and label mail.")
  .option("--auth <provider>", 'authenticate a provider; "m365" or "gmail"')
  .option(
    "--account <name|all>",
    "account to act on (a per-account settings name, or 'all' for every enabled account; defaults to 'all' for --sync-categories)",
  )
  .option("--sync-categories", "ensure the taxonomy's labels exist as M365 master categories and Gmail labels")
  .addHelpText(
    "after",
    "\nExamples:\n  $ email-classify --auth m365 --account work\n  $ email-classify --auth m365 --account all\n  $ email-classify --auth gmail --account personal\n  $ email-classify --auth gmail --account all\n  $ email-classify --sync-categories --account all\n",
  )
  .action(async (options: CliOptions) => {
    const command = resolveCliCommand(options);
    if (command.kind === "error") {
      process.stderr.write(`${command.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode =
      command.kind === "sync"
        ? await runSyncCategories({ account: command.account })
        : await runAuth({ provider: command.provider, account: command.account });
  });

await program.parseAsync(process.argv);
