import {
  accountsDirDisplayPath as gmailAccountsDirDisplayPath,
  listEnabledAccounts as listGmailAccounts,
  readAccountSettings as readGmailAccountSettings,
} from "../../adapters/gmail/accountSettings.js";
import { GmailAdapter } from "../../adapters/gmail/GmailAdapter.js";
import { GmailAuthAdapter } from "../../adapters/gmail/GmailAuthAdapter.js";
import {
  accountsDirDisplayPath as m365AccountsDirDisplayPath,
  listEnabledAccounts as listM365Accounts,
  readAccountSettings as readM365AccountSettings,
} from "../../adapters/m365/accountSettings.js";
import { M365Adapter } from "../../adapters/m365/M365Adapter.js";
import { M365AuthAdapter, type FetchLike } from "../../adapters/m365/M365AuthAdapter.js";
import { readAccountState, writeLastHistoryId, writeLastRunTimestamp, type StateFileOptions } from "../../adapters/config/stateFile.js";
import { KeychainTokenStore } from "../../adapters/token/KeychainTokenStore.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";
import { type MessageFetchTarget } from "../../orch/fetch.js";
import {
  fetchIncremental,
  type GmailIncrementalSeam,
  type IncrementalAccount,
} from "../../orch/incremental.js";
import { createPassphrasePrompt, errorLine } from "./auth.js";
import { createConsoleLogPort } from "./sync-categories.js";

export interface CronCommandOptions {
  /** The provider to fetch from; dispatch rejects everything but "m365" and "gmail". */
  source: "m365" | "gmail";
  /** A per-account settings name, or "all" for every enabled account of that provider. */
  account: string;
}

/** Test seam mirroring `runBackfill`'s: mocked network, in-memory tokens, temp config, recording logger. */
export interface CronRuntime {
  fetchFn?: FetchLike;
  tokenStore?: TokenPort;
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
  logPort?: LogPort;
  /** Clock seam; injectable so the persisted cycle start is deterministic in tests. */
  now?: () => Date;
}

/** The part of a per-account listing this command reads; both providers return one. */
interface EnabledAccountSettings {
  name: string;
  /** m365's configured folders (Story 5.1). */
  folders?: string[];
  batchSize?: number;
}

interface EnabledAccountsListing {
  accounts: EnabledAccountSettings[];
  errors: Array<{ accountName: string; message: string }>;
}

/**
 * One provider's half of the loop: its listing, its fetch port and, for Gmail, its history seam
 * (`users.history.list`/getProfile plus the `lastHistoryId` write); absent for m365.
 */
interface IncrementalProviderPlan {
  provider: "m365" | "gmail";
  accountsDirDisplayPath(): string;
  listEnabledAccounts(): Promise<EnabledAccountsListing>;
  planFor(entry: EnabledAccountSettings): IncrementalAccount;
  port: MessageFetchTarget;
  /** Story 5.4's Gmail half; the orchestrator throws when a gmail run arrives without it. */
  gmail?: GmailIncrementalSeam;
}

/** Provider-specific setup hint, for when the selection has no account to fetch. */
function noAccountsHint(plan: IncrementalProviderPlan, account: string): string {
  const file = account === "all" ? "<name>.yaml" : `${account}.yaml`;
  return account === "all"
    ? `No enabled ${plan.provider} accounts found — add ${plan.accountsDirDisplayPath()}/${file} with "enabled: true".`
    : `No enabled ${plan.provider} account named "${account}" found — add ${plan.accountsDirDisplayPath()}/${file} with "enabled: true", then re-run.`;
}

/**
 * Temporary `--cron --source <m365|gmail> --account <name|all>` command (human scope decision,
 * 2026-10-09): lists the enabled accounts for the requested provider and fetches only what is new
 * per account through `fetchIncremental` (m365 from the stored `lastRunTimestamp`, Gmail from the
 * stored `lastHistoryId` with its expiry fallback), with per-account isolation, a per-account count
 * and a counted failure line, and the failure count mapped to the exit code. Nothing is classified
 * or written back. Looped by Story 8.3; replaced by Epic 11's DI container and `main.ts`.
 */
export async function runCron(options: CronCommandOptions, runtime: CronRuntime = {}): Promise<number> {
  const configDir = runtime.configDir === undefined ? {} : { configDir: runtime.configDir };
  const fetchFn = runtime.fetchFn ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const tokenStore =
    runtime.tokenStore ?? new KeychainTokenStore({ promptPassphrase: createPassphrasePrompt(), ...configDir });
  const logPort = runtime.logPort ?? createConsoleLogPort();
  const m365Auth = new M365AuthAdapter({
    fetchFn,
    tokenStore,
    accountSettings: { read: (accountName) => readM365AccountSettings(accountName, configDir) },
  });
  const gmailAuth = new GmailAuthAdapter({
    fetchFn,
    tokenStore,
    accountSettings: { read: (accountName) => readGmailAccountSettings(accountName, configDir) },
  });
  const gmailAdapter = new GmailAdapter({
    fetchFn,
    getAccessToken: (accountName) => gmailAuth.getAccessToken(accountName),
  });
  const plans: Record<CronCommandOptions["source"], IncrementalProviderPlan> = {
    m365: {
      provider: "m365",
      accountsDirDisplayPath: m365AccountsDirDisplayPath,
      listEnabledAccounts: () => listM365Accounts(configDir),
      // Reads the optional Story 5.1 keys; the orchestrator supplies the defaults.
      planFor: (entry) => ({
        accountId: entry.name,
        ...(entry.folders === undefined ? {} : { folders: entry.folders }),
        ...(entry.batchSize === undefined ? {} : { batchSize: entry.batchSize }),
      }),
      port: new M365Adapter({ fetchFn, getAccessToken: (accountName) => m365Auth.getAccessToken(accountName) }),
    },
    gmail: {
      provider: "gmail",
      accountsDirDisplayPath: gmailAccountsDirDisplayPath,
      listEnabledAccounts: () => listGmailAccounts(configDir),
      // The cron window is the account's INBOX: the adapter's history walk hardcodes the INBOX
      // label, and a configured `labels` list — a backfill key (Story 5.3) — never widens it.
      planFor: (entry) => ({
        accountId: entry.name,
        ...(entry.batchSize === undefined ? {} : { batchSize: entry.batchSize }),
      }),
      port: gmailAdapter,
      gmail: {
        history: gmailAdapter,
        writeLastHistoryId: (accountName, historyId) =>
          writeLastHistoryId(accountName, historyId, { ...configDir, provider: "gmail" }),
      },
    },
  };
  const plan = plans[options.source];
  // Per-provider state files (Story 5.4 decision 2-A): each provider only reads and writes its own
  // `state/<provider>-<name>.json`, so same-named accounts never share a cursor.
  const stateOptions: StateFileOptions = { ...configDir, provider: plan.provider };

  let listing: EnabledAccountsListing;
  try {
    listing = await plan.listEnabledAccounts();
  } catch (error) {
    process.stderr.write(`${plan.provider}: ${errorLine(error)}\n`);
    return 1;
  }

  const account = options.account;
  const selected = account === "all" ? listing.accounts : listing.accounts.filter((entry) => entry.name === account);
  const relevantErrors = account === "all" ? listing.errors : listing.errors.filter((e) => e.accountName === account);
  for (const error of relevantErrors) {
    process.stderr.write(`${plan.provider} ${error.accountName}: ${error.message}\n`);
  }

  if (selected.length === 0) {
    process.stderr.write(
      relevantErrors.length > 0
        ? `${relevantErrors.length} ${plan.provider} account(s) have invalid settings — fix or remove them, then re-run.\n`
        : `${noAccountsHint(plan, account)}\n`,
    );
    return 1;
  }

  const accounts = selected.map((entry) => plan.planFor(entry));
  const { fetched, failures, accountsFetched } = await fetchIncremental({
    accounts,
    mailPort: plan.port,
    logPort,
    source: plan.provider,
    readAccountState: (accountName) => readAccountState(accountName, stateOptions),
    writeLastRunTimestamp: (accountName, date) => writeLastRunTimestamp(accountName, date, stateOptions),
    ...(plan.gmail === undefined ? {} : { gmail: plan.gmail }),
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
  });
  const total = selected.length + relevantErrors.length;
  const totalFailures = failures + relevantErrors.length;
  if (totalFailures > 0) {
    process.stderr.write(`${totalFailures} of ${total} ${plan.provider} account(s) failed.\n`);
  }
  // The count of accounts that actually produced messages, not the number selected: a failed
  // account is already reported on stderr, and claiming it here would read as if it had fetched.
  process.stdout.write(`Fetched ${fetched} message(s) from ${accountsFetched} account(s).\n`);
  return totalFailures > 0 ? 1 : 0;
}
