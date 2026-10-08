import { loadTaxonomy } from "../../adapters/config/taxonomy.js";
import {
  accountsDirDisplayPath,
  listEnabledAccounts,
  readAccountSettings as readM365AccountSettings,
  type M365AccountsListing,
} from "../../adapters/m365/accountSettings.js";
import { M365Adapter } from "../../adapters/m365/M365Adapter.js";
import { M365AuthAdapter, type FetchLike } from "../../adapters/m365/M365AuthAdapter.js";
import { KeychainTokenStore } from "../../adapters/token/KeychainTokenStore.js";
import type { Taxonomy } from "../../core/dto/Taxonomy.js";
import type { LogContext, LogPort } from "../../core/ports/LogPort.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";
import { syncCategories } from "../../orch/sync.js";
import { createPassphrasePrompt, errorLine } from "./auth.js";

export interface SyncCategoriesCommandOptions {
  /** A per-account settings name, or "all" for every enabled m365 account. */
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

/**
 * Temporary `--sync-categories --account <name|all>` command (human scope decision,
 * 2026-10-09): loads the merged taxonomy, syncs it into every selected account's M365
 * master categories through the orchestrator, and maps the returned failure count to
 * the exit code. Replaced wholesale by Epic 11's DI container and `main.ts`.
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
  const auth = new M365AuthAdapter({
    fetchFn,
    tokenStore:
      runtime.tokenStore ?? new KeychainTokenStore({ promptPassphrase: createPassphrasePrompt(), ...configDir }),
    accountSettings: { read: (accountName) => readM365AccountSettings(accountName, configDir) },
  });
  const mailPort = new M365Adapter({
    fetchFn,
    getAccessToken: (accountName) => auth.getAccessToken(accountName),
  });
  const logPort = runtime.logPort ?? createConsoleLogPort();

  if (options.account === "all") {
    let listing: M365AccountsListing;
    try {
      listing = await listEnabledAccounts(configDir);
    } catch (error) {
      process.stderr.write(`m365: ${errorLine(error)}\n`);
      return 1;
    }
    for (const error of listing.errors) {
      process.stderr.write(`m365 ${error.accountName}: ${error.message}\n`);
    }
    if (listing.accounts.length === 0) {
      process.stderr.write(
        listing.errors.length > 0
          ? `${listing.errors.length} m365 account(s) have invalid settings — fix or remove them, then re-run.\n`
          : `No enabled m365 accounts found — add ${accountsDirDisplayPath()}/<name>.yaml with "enabled: true".\n`,
      );
      return 1;
    }

    const failures = await syncCategories({
      accounts: listing.accounts.map((account) => account.name),
      labels,
      mailPort,
      logPort,
    });
    const totalFailures = failures + listing.errors.length;
    if (totalFailures > 0) {
      process.stderr.write(
        `${totalFailures} of ${listing.accounts.length + listing.errors.length} m365 account(s) failed.\n`,
      );
      return 1;
    }
    return 0;
  }

  const failures = await syncCategories({ accounts: [options.account], labels, mailPort, logPort });
  return failures > 0 ? 1 : 0;
}
