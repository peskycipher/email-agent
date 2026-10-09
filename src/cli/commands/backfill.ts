import {
  accountsDirDisplayPath as m365AccountsDirDisplayPath,
  listEnabledAccounts as listM365Accounts,
  readAccountSettings as readM365AccountSettings,
  type M365AccountsListing,
} from "../../adapters/m365/accountSettings.js";
import { M365Adapter } from "../../adapters/m365/M365Adapter.js";
import { M365AuthAdapter, type FetchLike } from "../../adapters/m365/M365AuthAdapter.js";
import { KeychainTokenStore } from "../../adapters/token/KeychainTokenStore.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";
import { fetchAllMessages, type FetchAccount } from "../../orch/fetch.js";
import { createPassphrasePrompt, errorLine } from "./auth.js";
import { createConsoleLogPort } from "./sync-categories.js";

export interface BackfillCommandOptions {
  /** The provider to fetch from; only "m365" reaches here (dispatch rejects the rest). */
  source: "m365";
  /** A per-account settings name, or "all" for every enabled m365 account. */
  account: string;
}

/** Test seam mirroring `runSyncCategories`'s: mocked network, in-memory tokens, temp config, recording logger. */
export interface BackfillRuntime {
  fetchFn?: FetchLike;
  tokenStore?: TokenPort;
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
  logPort?: LogPort;
}

/** M365-only setup hint, for when the selection has no account to fetch. */
function noAccountsHint(account: string): string {
  const file = account === "all" ? "<name>.yaml" : `${account}.yaml`;
  return account === "all"
    ? `No enabled m365 accounts found — add ${m365AccountsDirDisplayPath()}/${file} with "enabled: true".`
    : `No enabled m365 account named "${account}" found — add ${m365AccountsDirDisplayPath()}/${file} with "enabled: true", then re-run.`;
}

/** Reads the optional Story 5.1 keys into a fetch plan; the orchestrator supplies the defaults. */
function planFor(entry: M365AccountsListing["accounts"][number]): FetchAccount {
  return {
    accountId: entry.name,
    ...(entry.folders === undefined ? {} : { folders: entry.folders }),
    ...(entry.batchSize === undefined ? {} : { batchSize: entry.batchSize }),
  };
}

/**
 * Temporary `--backfill --source m365 --account <name|all>` command (human scope decision,
 * 2026-10-09): lists the enabled m365 accounts, fetches every configured folder through
 * `fetchAllMessages` with per-account isolation, prints each account's count and a counted
 * failure line, and maps the failure count to the exit code. Nothing is persisted. Replaced
 * wholesale by Epic 11's DI container and `main.ts`.
 */
export async function runBackfill(
  options: BackfillCommandOptions,
  runtime: BackfillRuntime = {},
): Promise<number> {
  const configDir = runtime.configDir === undefined ? {} : { configDir: runtime.configDir };
  const fetchFn = runtime.fetchFn ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const tokenStore =
    runtime.tokenStore ?? new KeychainTokenStore({ promptPassphrase: createPassphrasePrompt(), ...configDir });
  const auth = new M365AuthAdapter({
    fetchFn,
    tokenStore,
    accountSettings: { read: (accountName) => readM365AccountSettings(accountName, configDir) },
  });
  const mailPort = new M365Adapter({ fetchFn, getAccessToken: (accountName) => auth.getAccessToken(accountName) });
  const logPort = runtime.logPort ?? createConsoleLogPort();

  let listing: M365AccountsListing;
  try {
    listing = await listM365Accounts(configDir);
  } catch (error) {
    process.stderr.write(`m365: ${errorLine(error)}\n`);
    return 1;
  }

  const account = options.account;
  const selected = account === "all" ? listing.accounts : listing.accounts.filter((entry) => entry.name === account);
  const relevantErrors = account === "all" ? listing.errors : listing.errors.filter((e) => e.accountName === account);
  for (const error of relevantErrors) {
    process.stderr.write(`m365 ${error.accountName}: ${error.message}\n`);
  }

  if (selected.length === 0) {
    process.stderr.write(
      relevantErrors.length > 0
        ? `${relevantErrors.length} m365 account(s) have invalid settings — fix or remove them, then re-run.\n`
        : `${noAccountsHint(account)}\n`,
    );
    return 1;
  }

  const accounts = selected.map(planFor);
  const { fetched, failures } = await fetchAllMessages({ accounts, mailPort, logPort, source: options.source });
  const total = selected.length + relevantErrors.length;
  const totalFailures = failures + relevantErrors.length;
  if (totalFailures > 0) {
    process.stderr.write(`${totalFailures} of ${total} m365 account(s) failed.\n`);
  }
  process.stdout.write(`Fetched ${fetched} message(s) from ${selected.length} account(s).\n`);
  return totalFailures > 0 ? 1 : 0;
}
