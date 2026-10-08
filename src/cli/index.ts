import { Command } from "commander";
import { runAuth } from "./commands/auth.js";

const program = new Command();

program
  .name("email-classify")
  .description("Multi-account email triage: authenticate, fetch, classify and label mail.")
  .option("--auth <provider>", 'authenticate a provider; "m365" or "gmail"')
  .option(
    "--account <name|all>",
    "account to authenticate (a per-account settings name, or 'all' for every enabled account)",
  )
  .addHelpText(
    "after",
    "\nExamples:\n  $ email-classify --auth m365 --account work\n  $ email-classify --auth m365 --account all\n  $ email-classify --auth gmail --account personal\n  $ email-classify --auth gmail --account all\n",
  )
  .action(async (options: { auth?: string; account?: string }) => {
    const provider = options.auth;
    const account = options.account;
    if (!provider || !account) {
      process.stderr.write(
        "--auth <provider> and --account <name|all> are both required (e.g. --auth gmail --account personal).\n",
      );
      process.exitCode = 1;
      return;
    }
    process.exitCode = await runAuth({ provider, account });
  });

await program.parseAsync(process.argv);
