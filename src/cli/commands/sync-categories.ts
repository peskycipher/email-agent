import { join } from "node:path";
import { loadTaxonomy } from "../../adapters/config/taxonomy.js";
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
import type { Taxonomy } from "../../core/dto/Taxonomy.js";
import type { LogContext, LogPort } from "../../core/ports/LogPort.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";
import { syncCategories, type CategorySyncTarget } from "../../orch/sync.js";
import { createPassphrasePrompt, errorLine } from "./auth.js";

export interface SyncCategoriesCommandOptions {
  /** A per-account settings name, or "all" for every enabled m365 and gmail account. */
  account: string;
}

/** Test seam mirroring `runAuth`'s: mocked network, in-memory tokens, temp config/taxonomy, recording logger. */
export interface SyncCategoriesRuntime {
  fetchFn?: FetchLike;
  tokenStore?: TokenPort;
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
  taxonomyPath?: string | URL;
  logPort?: LogPort;
}

/** The part of a per-account listing this command reads; both providers return one. */
interface EnabledAccountsListing {
  accounts: Array<{ name: string }>;
  errors: Array<{ accountName: string; message: string }>;
}

/** One provider's half of the command: its listing, its adapter, and what it calls the labels. */
interface ProviderPlan {
  provider: "m365" | "gmail";
  /** The orchestrator's log noun — M365 ensures categories, Gmail ensures labels. */
  noun: string;
  port: CategorySyncTarget;
  listEnabledAccounts(): Promise<EnabledAccountsListing>;
}

function writeLine(
  stream: { write(chunk: string): unknown },
  level: string,
  message: string,
  context?: LogContext,
): void {
  const accountId = context?.accountId;
  const prefix = typeof accountId === "string" ? `${accountId}: ` : "";
  stream.write(`${level} ${prefix}${message}\n`);
}

/**
 * The minimal console `LogPort` this temporary command needs (Epic 10 owns the real
 * one, AD-7): the context's `accountId` prefixes each line, and only `warn`/`error`
 * reach stderr.
 */
export function createConsoleLogPort(): LogPort {
  return {
    debug: (message, context) => writeLine(process.stdout, "debug", message, context),
    info: (message, context) => writeLine(process.stdout, "info", message, context),
    warn: (message, context) => writeLine(process.stderr, "warn", message, context),
    error: (message, context) => writeLine(process.stderr, "error", message, context),
  };
}

/** Both providers' setups in one line, for when neither has an account to act on. */
function noAccountsHint(account: string | undefined, configDir: string | undefined): string {  const file = account === undefined ? "<name>.yaml" : `${account}.yaml`;
  // An injected configDir (tests, a future XDG override) must be named correctly in the hint —
  // not the home display path the constants spell.
  const dir = (displayPath: () => string, subpath: string): string =>
    configDir === undefined ? displayPath() : join(configDir, subpath);
  return (
    `No enabled ${account === undefined ? "m365 or gmail accounts" : `m365 or gmail account named "${account}"`} found` +
    ` — add ${dir(m365AccountsDirDisplayPath, "accounts/m365")}/${file} or ${dir(gmailAccountsDirDisplayPath, "accounts/gmail")}/${file}` +
    ` with "enabled: true"${account === undefined ? "." : ", then re-run."}`
  );
}

/** One provider's setup pointer — for when that provider listed cleanly but has nothing to act on. */
function providerHint(provider: "m365" | "gmail", configDir: string | undefined): string {
  const dir =
    configDir === undefined
      ? provider === "m365"
        ? m365AccountsDirDisplayPath()
        : gmailAccountsDirDisplayPath()
      : join(configDir, provider === "m365" ? "accounts/m365" : "accounts/gmail");
  return `No enabled ${provider} accounts found — add ${dir}/<name>.yaml with "enabled: true".`;
}

/**
 * Temporary `--sync-categories --account <name|all>` command (human scope decision,
 * 2026-10-09): loads the merged taxonomy, ensures it exists as M365 master categories
 * *and* Gmail labels in every selected account through the orchestrator, and maps the
 * failure count to the exit code. An account may be enabled for either provider or both;
 * a named account is resolved against both providers' enabled listings, so there is no
 * provider flag. Replaced wholesale by Epic 11's DI container and `main.ts`.
 */
export async function runSyncCategories(
  options: SyncCategoriesCommandOptions,
  runtime: SyncCategoriesRuntime = {},
): Promise<number> {
  let labels: Taxonomy;
  try {
    labels = await loadTaxonomy({
      ...(runtime.taxonomyPath === undefined ? {} : { taxonomyPath: runtime.taxonomyPath }),
      ...(runtime.configDir === undefined ? {} : { configDir: runtime.configDir }),
    });
  } catch (error) {
    process.stderr.write(`${errorLine(error)}\n`);
    return 1;
  }

  const configDir = runtime.configDir === undefined ? {} : { configDir: runtime.configDir };
  const fetchFn = runtime.fetchFn ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const tokenStore =
    runtime.tokenStore ?? new KeychainTokenStore({ promptPassphrase: createPassphrasePrompt(), ...configDir });
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
  const logPort = runtime.logPort ?? createConsoleLogPort();
  const providers: ProviderPlan[] = [
    {
      provider: "m365",
      noun: "categories",
      listEnabledAccounts: () => listM365Accounts(configDir),
      port: new M365Adapter({
        fetchFn,
        getAccessToken: m365Auth.getAccessToken.bind(m365Auth),
        logPort,
      }),
    },
    {
      provider: "gmail",
      noun: "labels",
      listEnabledAccounts: () => listGmailAccounts(configDir),
      port: new GmailAdapter({
        fetchFn,
        getAccessToken: gmailAuth.getAccessToken.bind(gmailAuth),
        logPort,
      }),
    },
  ];

  if (options.account === "all") {
    let failures = 0;
    let listingFailures = 0;
    /** Providers that listed (possibly with zero accounts) — the named-account branch's symmetric counters. */
    const emptyListed: Array<"m365" | "gmail"> = [];
    let selected = 0;
    for (const plan of providers) {
      let listing: EnabledAccountsListing;
      try {
        listing = await plan.listEnabledAccounts();
      } catch (error) {
        // One provider's listing failure costs that provider, not the whole run.
        failures += 1;
        listingFailures += 1;
        process.stderr.write(`${plan.provider}: ${errorLine(error)}\n`);
        continue;
      }
      for (const error of listing.errors) {
        process.stderr.write(`${plan.provider} ${error.accountName}: ${error.message}\n`);
      }
      const accounts = listing.accounts.map((account) => account.name);
      const total = accounts.length + listing.errors.length;
      selected += total;
      if (listing.accounts.length === 0) emptyListed.push(plan.provider);
      const providerFailures =
        (await syncCategories({ accounts, labels, mailPort: plan.port, logPort, noun: plan.noun })) +
        listing.errors.length;
      failures += providerFailures;
      if (providerFailures > 0) {
        process.stderr.write(`${providerFailures} of ${total} ${plan.provider} account(s) failed.\n`);
      }
    }
    if (listingFailures > 0) {
      // The counted line account failures already get (Epic-4 retro item 2): a listing failure
      // is reported the same way, not only by its provider line.
      process.stderr.write(`${listingFailures} of ${providers.length} provider listing(s) failed.\n`);
    }
    if (selected === 0) {
      if (listingFailures === 0) {
        process.stderr.write(`${noAccountsHint(undefined, runtime.configDir)}\n`);
      } else {
        // A provider whose listing succeeded still owes its user a setup pointer — the counted
        // line above names the failures, so the pointer no longer contradicts them.
        for (const listedAndEmpty of emptyListed) {
          process.stderr.write(`${providerHint(listedAndEmpty, runtime.configDir)}\n`);
        }
      }
      return 1;
    }
    return failures > 0 ? 1 : 0;
  }

  const account = options.account;
  let failures = 0;
  let listingFailures = 0;
  let synced = 0;
  for (const plan of providers) {
    let listing: EnabledAccountsListing;
    try {
      listing = await plan.listEnabledAccounts();
    } catch (error) {
      // Only the failing provider is affected; the other still lists and syncs.
      failures += 1;
      listingFailures += 1;
      process.stderr.write(`${plan.provider}: ${errorLine(error)}\n`);
      continue;
    }
    for (const error of listing.errors) {
      if (error.accountName !== account) continue;
      failures += 1;
      process.stderr.write(`${plan.provider} ${error.accountName}: ${error.message}\n`);
    }
    if (!listing.accounts.some((entry) => entry.name === account)) continue;
    synced += 1;
    failures += await syncCategories({
      accounts: [account],
      labels,
      mailPort: plan.port,
      logPort,
      noun: plan.noun,
    });
  }
  if (listingFailures > 0) {
    // The same counted line the --account all branch prints, so failure reporting does not
    // depend on the selection mode (Epic-4 retro item 2's asymmetry finding).
    process.stderr.write(`${listingFailures} of ${providers.length} provider listing(s) failed.\n`);
  }
  if (synced === 0 && failures === 0) {
    process.stderr.write(`${noAccountsHint(account, runtime.configDir)}\n`);
    return 1;
  }
  return failures > 0 ? 1 : 0;
}
