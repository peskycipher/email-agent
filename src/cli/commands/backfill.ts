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
import { loadTaxonomy } from "../../adapters/config/taxonomy.js";
import { IdempotencyStore } from "../../adapters/idempotency/sqliteIdempotencyStore.js";
import { acquireRunLock, releaseRunLock, type RunLockOptions } from "../../adapters/lock/runLock.js";
import { createModelAdapter, defaultModelClientFactories, DEFAULT_MODEL_CONFIG } from "../../adapters/model/modelAdapterFactory.js";
import type { ModelConfig } from "../../core/dto/ModelConfig.js";
import type { Taxonomy } from "../../core/dto/Taxonomy.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import type { ModelPort } from "../../core/ports/ModelPort.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";
import {
  runBackfillAccounts,
  type BackfillAccount,
  type BackfillResult,
  type LabelWriteTarget,
} from "../../orch/classification-run.js";
import { type MessageFetchTarget } from "../../orch/fetch.js";
import { abortableSleep, type ShutdownCoordinator } from "../shutdown.js";
import { createPassphrasePrompt, errorLine } from "./auth.js";
import { createConsoleLogPort } from "./sync-categories.js";

export interface BackfillCommandOptions {
  /** The provider to fetch from; dispatch rejects everything but "m365" and "gmail". */
  source: "m365" | "gmail";
  /** A per-account settings name, or "all" for every enabled account of that provider. */
  account: string;
  /** Messages received on or after this instant are the only ones fetched; absent means all time (Story 8.1's AC default). */
  since?: Date;
  /** The per-account fetch batch; the adapter clamps it to the provider's ceiling (default 50, max 100). */
  batchSize?: number;
}

/** Test seam mirroring `runSyncCategories`'s: mocked network, in-memory tokens, temp config, recording logger. */
export interface BackfillRuntime {
  fetchFn?: FetchLike;
  tokenStore?: TokenPort;
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
  taxonomyPath?: string | URL;
  logPort?: LogPort;
  /** The model config a run classifies with; defaults to the ratified `DEFAULT_MODEL_CONFIG` (Epic 11 owns real settings). */
  modelConfig?: ModelConfig;
  /** Model adapter seam; injectable so a test never reaches a provider SDK or the network. */
  model?: Parameters<typeof runBackfillAccounts>[0]["model"];
  /** Story 9.1's adapter backoff seam, threaded into the adapters; injectable so tests never really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The graceful-shutdown coordinator; present only on the `--backfill` route the entry wires (Story 9.2). */
  shutdown?: ShutdownCoordinator;
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

/** One provider's half of the command: its listing, its fetch+write port, and how its settings become a plan. */
interface BackfillProviderPlan {
  provider: "m365" | "gmail";
  accountsDirDisplayPath(): string;
  listEnabledAccounts(): Promise<EnabledAccountsListing>;
  planFor(entry: EnabledAccountSettings): BackfillAccount;
  port: MessageFetchTarget & LabelWriteTarget;
}

/** Provider-specific setup hint, for when the selection has no account to fetch. */
function noAccountsHint(plan: BackfillProviderPlan, account: string): string {
  const file = account === "all" ? "<name>.yaml" : `${account}.yaml`;
  return account === "all"
    ? `No enabled ${plan.provider} accounts found — add ${plan.accountsDirDisplayPath()}/${file} with "enabled: true".`
    : `No enabled ${plan.provider} account named "${account}" found — add ${plan.accountsDirDisplayPath()}/${file} with "enabled: true", then re-run.`;
}

/**
 * Releases the run lock, reporting a failure as one line without changing the run's exit code:
 * the stale-pid rule frees the file on the next run either way. Duplicated in `cron.ts`, which
 * takes the same lock.
 */
function releaseLock(options: RunLockOptions): void {
  try {
    releaseRunLock(options);
  } catch (error) {
    process.stderr.write(`${errorLine(error)}\n`);
  }
}

/**
 * The one-shot backfill: `--backfill --source <m365|gmail> --account <name|all>`, optionally
 * bounded by `--since` and `--batch-size`. Lists the enabled accounts for the requested
 * provider, then for each account fetches its messages, classifies every message the idempotency
 * store does not already record against the merged taxonomy, and writes the resulting labels back
 * through `MailPort.writeLabels` (Stories 8.1/8.2). Accounts are processed sequentially and
 * independently; the failure count maps to the exit code. `--backfill` and `--cron` take the one
 * process lock, and completed messages are recorded in the one shared idempotency store, so a
 * killed run resumes instead of redoing its work.
 */
export async function runBackfill(
  options: BackfillCommandOptions,
  runtime: BackfillRuntime = {},
): Promise<number> {
  const configDir = runtime.configDir === undefined ? {} : { configDir: runtime.configDir };
  const modelConfig = runtime.modelConfig ?? DEFAULT_MODEL_CONFIG;
  const shutdown = runtime.shutdown;
  const signal = shutdown?.signal;
  // Under a shutdown coordinator the adapter wait is raced against the signal, so an interrupt
  // during a 9.1 ladder rung ends it; without one the command keeps its exact behaviour.
  const sleep = shutdown === undefined ? runtime.sleep : abortableSleep(shutdown.signal, runtime.sleep);
  const adapterSleepSeam = sleep === undefined ? {} : { sleep };

  let taxonomy: Taxonomy;
  try {
    taxonomy = await loadTaxonomy({
      ...(runtime.taxonomyPath === undefined ? {} : { taxonomyPath: runtime.taxonomyPath }),
      ...configDir,
    });
  } catch (error) {
    process.stderr.write(`${errorLine(error)}\n`);
    return 1;
  }

  const fetchFn = runtime.fetchFn ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const tokenStore =
    runtime.tokenStore ?? new KeychainTokenStore({ promptPassphrase: createPassphrasePrompt(), ...configDir });
  const logPort = runtime.logPort ?? createConsoleLogPort();
  /**
   * Flushes the log buffer on an exit path, once the run has drained (Story 9.2). A logger that
   * will not flush must not reject the command: a handled shutdown still exits 0.
   */
  const finish = async (code: number): Promise<number> => {
    try {
      await logPort.flush?.();
    } catch {
      // A logger that will not flush must not fail the command.
    }
    return code;
  };
  let model: ModelPort;
  try {
    model = runtime.model ?? createModelAdapter(modelConfig, {
      log: logPort,
      ...defaultModelClientFactories,
    });
  } catch (error) {
    process.stderr.write(`${errorLine(error)}\n`);
    return finish(1);
  }

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
  const plans: Record<BackfillCommandOptions["source"], BackfillProviderPlan> = {
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
        ...adapterSleepSeam,
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
        // An explicitly empty `labels:` list is "unset", not "walk nothing" — an empty plan would
        // fall through to the orchestrator's m365 default ("Inbox"), which Gmail reads as a user label.
        folders: entry.labels && entry.labels.length > 0 ? entry.labels : ["INBOX"],
        ...(entry.batchSize === undefined ? {} : { batchSize: entry.batchSize }),
      }),
      port: new GmailAdapter({
        fetchFn,
        getAccessToken: gmailAuth.getAccessToken.bind(gmailAuth),
        logPort,
        ...adapterSleepSeam,
      }),
    },
  };
  const plan = plans[options.source];

  let listing: EnabledAccountsListing;
  try {
    listing = await plan.listEnabledAccounts();
  } catch (error) {
    process.stderr.write(`${plan.provider}: ${errorLine(error)}\n`);
    return finish(1);
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
    return finish(1);
  }

  // The lock and the store are taken only once this invocation is known to have accounts to run
  // (Story 8.2): a rejected selection reports its own hint rather than a busy lock, and a typo'd
  // account name never leaves an empty `idempotency.db` behind.
  const lock: RunLockOptions = { ...configDir, pid: process.pid };
  try {
    acquireRunLock(lock);
  } catch (error) {
    process.stderr.write(`${errorLine(error)}\n`);
    return finish(1);
  }
  let store: IdempotencyStore;
  try {
    store = new IdempotencyStore(configDir);
  } catch (error) {
    process.stderr.write(`${errorLine(error)}\n`);
    releaseLock(lock);
    return finish(1);
  }

  // The command-level flags are the same for every account: `--batch-size` is folded in first so
  // an account's own settings file still wins, and `--since` bounds every account's walk.
  const accounts = selected.map((entry) => {
    const planned = plan.planFor(entry);
    return {
      ...planned,
      ...(options.batchSize === undefined ? {} : { batchSize: planned.batchSize ?? options.batchSize }),
      ...(options.since === undefined ? {} : { since: options.since }),
    };
  });
  let result: BackfillResult;
  try {
    result = await runBackfillAccounts({
      accounts,
      store,
      mailPort: plan.port,
      taxonomy,
      model,
      config: modelConfig,
      logPort,
      source: plan.provider,
      ...(signal === undefined ? {} : { signal }),
    });
  } finally {
    // The lock covers the store and the per-account state files; every exit path releases it.
    store.close();
    releaseLock(lock);
  }

  // An interrupt stops the run at its account boundary; the deadline then covers the shutdown
  // step (close + flush) and the exit is 0, never a failure (Story 9.2).
  if (signal?.aborted) {
    shutdown?.beginShutdown();
    return finish(0);
  }

  const total = selected.length + relevantErrors.length;
  const totalFailures = result.failures + relevantErrors.length;
  if (totalFailures > 0) {
    process.stderr.write(`${totalFailures} of ${total} ${plan.provider} account(s) failed.\n`);
  }
  // The count of accounts that actually produced messages, not the number selected: a failed account
  // is already reported on stderr, and claiming it here would read as if it had fetched something.
  process.stdout.write(
    `Fetched ${result.fetched} message(s) from ${selected.length - result.failures} account(s): ` +
      `${result.labeled} labeled, ${result.skipped} skipped, ${result.alreadyDone} already done, ${result.errors} error(s).\n`,
  );
  return finish(totalFailures > 0 || result.errors > 0 ? 1 : 0);
}
