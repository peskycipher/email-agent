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
import { KeychainTokenStore } from "../../adapters/token/KeychainTokenStore.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";
import { fetchAllMessages, type FetchAccount, type MessageFetchTarget } from "../../orch/fetch.js";
import { createPassphrasePrompt, errorLine } from "./auth.js";
import { createConsoleLogPort } from "./sync-categories.js";

export interface BackfillCommandOptions {
  /** The provider to fetch from; dispatch rejects everything but "m365" and "gmail". */
  source: "m365" | "gmail";
  /** A per-account settings name, or "all" for every enabled account of that provider. */
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

/** The part of a per-account listing this command reads; both providers return one. */
interface EnabledAccountSettings {
  name: string;
  /** m365's configured folders (Story 5.1). */
  folders?: string[];
  /** Gmail's configured labels (Story 5.3) — the provider's name for the same walk. */
  labels?: string[];
  batchSize?: number;
}

interface EnabledAccountsListing {
  accounts: EnabledAccountSettings[];
  errors: Array<{ accountName: string; message: string }>;
}

/** One provider's half of the command: its listing, its fetch port, and how its settings become a plan. */
interface FetchProviderPlan {
  provider: "m365" | "gmail";
  accountsDirDisplayPath(): string;
  listEnabledAccounts(): Promise<EnabledAccountsListing>;
  planFor(entry: EnabledAccountSettings): FetchAccount;
  port: MessageFetchTarget;
}

/** Provider-specific setup hint, for when the selection has no account to fetch. */
function noAccountsHint(plan: FetchProviderPlan, account: string): string {
  const file = account === "all" ? "<name>.yaml" : `${account}.yaml`;
  return account === "all"
    ? `No enabled ${plan.provider} accounts found — add ${plan.accountsDirDisplayPath()}/${file} with "enabled: true".`
    : `No enabled ${plan.provider} account named "${account}" found — add ${plan.accountsDirDisplayPath()}/${file} with "enabled: true", then re-run.`;
}

/**
 * Temporary `--backfill --source <m365|gmail> --account <name|all>` command (human scope
 * decision, 2026-10-09): lists the enabled accounts for the requested provider, fetches
 * them through the shared `fetchAllMessages` with per-account isolation, prints each
 * account's count and a counted failure line, and maps the failure count to the exit code.
 * Nothing is persisted. Replaced wholesale by Epic 11's DI container and `main.ts`.
 */
export async function runBackfill(
  options: BackfillCommandOptions,
  runtime: BackfillRuntime = {},
): Promise<number> {
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
  const plans: Record<BackfillCommandOptions["source"], FetchProviderPlan> = {
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
      port: new M365Adapter({
        fetchFn,
        getAccessToken: m365Auth.getAccessToken.bind(m365Auth),
        logPort,
      }),
    },
    gmail: {
      provider: "gmail",
      accountsDirDisplayPath: gmailAccountsDirDisplayPath,
      listEnabledAccounts: () => listGmailAccounts(configDir),
      // Gmail's system inbox is the `INBOX` label, so the Gmail plan names its own default:
      // the orchestrator's m365 default ("Inbox") would be read as a user label.
      planFor: (entry) => ({
        accountId: entry.name,
        folders: entry.labels ?? ["INBOX"],
        ...(entry.batchSize === undefined ? {} : { batchSize: entry.batchSize }),
      }),
      port: new GmailAdapter({
        fetchFn,
        getAccessToken: gmailAuth.getAccessToken.bind(gmailAuth),
        logPort,
      }),
    },
  };
  const plan = plans[options.source];

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
  const { fetched, failures } = await fetchAllMessages({ accounts, mailPort: plan.port, logPort, source: plan.provider });
  const total = selected.length + relevantErrors.length;
  const totalFailures = failures + relevantErrors.length;
  if (totalFailures > 0) {
    process.stderr.write(`${totalFailures} of ${total} ${plan.provider} account(s) failed.\n`);
  }
  // The count of accounts that actually produced messages, not the number selected: a failed account
  // is already reported on stderr, and claiming it here would read as if it had fetched something.
  process.stdout.write(`Fetched ${fetched} message(s) from ${selected.length - failures} account(s).\n`);
  return totalFailures > 0 ? 1 : 0;
}
