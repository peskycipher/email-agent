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
import { acquireRunLock, releaseRunLock, type RunLockOptions } from "../../adapters/lock/runLock.js";
import { IdempotencyStore } from "../../adapters/idempotency/sqliteIdempotencyStore.js";
import { createModelAdapter, defaultModelClientFactories, DEFAULT_MODEL_CONFIG } from "../../adapters/model/modelAdapterFactory.js";
import { loadTaxonomy } from "../../adapters/config/taxonomy.js";
import { createScheduler } from "../../adapters/scheduler/scheduler.js";
import { KeychainTokenStore } from "../../adapters/token/KeychainTokenStore.js";
import type { ModelConfig } from "../../core/dto/ModelConfig.js";
import type { Taxonomy } from "../../core/dto/Taxonomy.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import type { ModelPort } from "../../core/ports/ModelPort.js";
import type { SchedulerPort } from "../../core/ports/SchedulerPort.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";
import { runCronCycle, type CategoryEnsureTarget, type CronCycleProvider, type CronCycleResult } from "../../orch/cron-cycle.js";
import { type LabelWriteTarget } from "../../orch/classification-run.js";
import { type MessageFetchTarget } from "../../orch/fetch.js";
import {
  type GmailIncrementalSeam,
  type IncrementalAccount,
} from "../../orch/incremental.js";
import { createPassphrasePrompt, errorLine } from "./auth.js";
import { createConsoleLogPort } from "./sync-categories.js";

export interface CronCommandOptions {
  /** The providers to run per cycle: one, or "all" composing both in the one loop (Story 8.3). */
  source: "m365" | "gmail" | "all";
  /** A per-account settings name, or "all" for every enabled account of the selected provider(s). */
  account: string;
  /** Minutes between cycles; dispatch validates 1–1440 and applies the default 15. */
  intervalMinutes: number;
}

/** Test seam mirroring `runBackfill`'s: mocked network, in-memory tokens, temp config, recording logger. */
export interface CronRuntime {
  fetchFn?: FetchLike;
  tokenStore?: TokenPort;
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
  taxonomyPath?: string | URL;
  logPort?: LogPort;
  /** Clock seam; injectable so the cycle line's timestamps are deterministic in tests. */
  now?: () => Date;
  /** The model config a run classifies with; defaults to the ratified `DEFAULT_MODEL_CONFIG` (Epic 11 owns real settings). */
  modelConfig?: ModelConfig;
  /** Model adapter seam; injectable so a test never reaches a provider SDK or the network. */
  model?: ModelPort;
  /** The scheduler that runs the first cycle and then the loop; injectable so tests never start a real interval. */
  scheduler?: SchedulerPort;
  /**
   * The single 30s flat-retry seam, threaded into the cycle *and* into the provider adapters as
   * Story 9.1's ladder seam; injectable so tests never really sleep. One recorder therefore sees
   * both mechanisms' waits, and a wait cannot be attributed to either from it alone.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Story 9.1's adapter backoff seam, threaded into the provider adapters only when injected. */
function adapterSleep(runtime: CronRuntime): { sleep?: (ms: number) => Promise<void> } {
  return runtime.sleep === undefined ? {} : { sleep: runtime.sleep };
}

/** The part of a per-account listing this command reads; both providers return one. */
interface EnabledAccountSettings {
  name: string;
  /** m365's configured folders (Story 5.1). */
  folders?: string[];
  /** Gmail labels configured per account (Story 5.3) — a backfill key; the cron window is INBOX only. */
  labels?: string[];
  batchSize?: number;
}

interface EnabledAccountsListing {
  accounts: EnabledAccountSettings[];
  errors: Array<{ accountName: string; message: string }>;
}

/**
 * One provider's half of the loop: its listing, its fetch+write port and, for Gmail, its history
 * seam (`users.history.list`/getProfile plus the `lastHistoryId` write); absent for m365.
 */
interface CronProviderPlan {
  provider: "m365" | "gmail";
  accountsDirDisplayPath(): string;
  listEnabledAccounts(): Promise<EnabledAccountsListing>;
  planFor(entry: EnabledAccountSettings): IncrementalAccount;
  port: MessageFetchTarget & LabelWriteTarget & CategoryEnsureTarget;
  /** Story 5.4's Gmail half; the orchestrator throws when a gmail run arrives without it. */
  gmail?: GmailIncrementalSeam;
}

/** Provider-specific setup hint, for when the selection has no account to fetch. */
function noAccountsHint(plan: CronProviderPlan, account: string): string {
  const file = account === "all" ? "<name>.yaml" : `${account}.yaml`;
  return account === "all"
    ? `No enabled ${plan.provider} accounts found — add ${plan.accountsDirDisplayPath()}/${file} with "enabled: true".`
    : `No enabled ${plan.provider} account named "${account}" found — add ${plan.accountsDirDisplayPath()}/${file} with "enabled: true", then re-run.`;
}

/**
 * Releases the run lock, reporting a failure as one line without changing the run's exit code:
 * the stale-pid rule frees the file on the next run either way. Duplicated in `backfill.ts`,
 * which takes the same lock.
 */
function releaseLock(options: RunLockOptions): void {
  try {
    releaseRunLock(options);
  } catch (error) {
    process.stderr.write(`${errorLine(error)}\n`);
  }
}

/**
 * The recurring `--cron` mode (Story 8.3): `--cron --source <m365|gmail|all> --account <name|all>
 * [--interval <minutes>]` lists the enabled accounts once, then loops — the first cycle inline, the
 * rest at the interval through the scheduler, default 15 minutes. Each cycle takes the 8.2 run
 * lock around itself (never for the whole loop, so `--backfill` may interleave between cycles),
 * then runs `runCronCycle` over the selected accounts: fetch what is new per account, classify it,
 * write the labels back through the 8.1/8.2 stages, and commit each account's cursor only when its
 * cycle finished clean — with per-account isolation, a 30s backoff and one retry for fetch or write
 * failures, and the re-queue being the held cursor. `--source all` runs both providers' accounts in
 * every cycle, each through its own namespaced cursor file.
 *
 * The first cycle runs inline so a lock held by another invocation exits 1 with the 8.2 line before
 * anything is fetched and before any interval starts. A later cycle that finds the lock held (a
 * backfill started in a gap) logs the same line, skips its tick and loops on. Because the loop never
 * ends on its own, an account that failed a cycle is named in that cycle's lines and the loop
 * continues — only the lock failure has a terminal exit code. Replaced by Epic 11's DI container.
 */
export async function runCron(options: CronCommandOptions, runtime: CronRuntime = {}): Promise<number> {
  const configDir = runtime.configDir === undefined ? {} : { configDir: runtime.configDir };
  const modelConfig = runtime.modelConfig ?? DEFAULT_MODEL_CONFIG;

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
  let model: ModelPort;
  try {
    model = runtime.model ?? createModelAdapter(modelConfig, {
      log: logPort,
      ...defaultModelClientFactories,
    });
  } catch (error) {
    process.stderr.write(`${errorLine(error)}\n`);
    return 1;
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
  const gmailAdapter = new GmailAdapter({
    fetchFn,
    getAccessToken: gmailAuth.getAccessToken.bind(gmailAuth),
    logPort,
    ...adapterSleep(runtime),
  });
  const plans: Record<"m365" | "gmail", CronProviderPlan> = {
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
        ...adapterSleep(runtime),
      }),
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

  // The selection is resolved once, before the loop: the settings files the accounts come from
  // are read at startup, and every cycle then runs the same accounts.
  const account = options.account;
  const providers: CronCycleProvider[] = [];
  for (const providerId of options.source === "all" ? (["m365", "gmail"] as const) : [options.source]) {
    const plan = plans[providerId];
    let listing: EnabledAccountsListing;
    try {
      listing = await plan.listEnabledAccounts();
    } catch (error) {
      // One provider's listing failure costs that provider, not the whole run; the hint below
      // still points at the provider that listed cleanly but had nothing selected.
      process.stderr.write(`${plan.provider}: ${errorLine(error)}\n`);
      continue;
    }
    const selected = account === "all" ? listing.accounts : listing.accounts.filter((entry) => entry.name === account);
    const relevantErrors = account === "all" ? listing.errors : listing.errors.filter((e) => e.accountName === account);
    for (const error of relevantErrors) {
      process.stderr.write(`${plan.provider} ${error.accountName}: ${error.message}\n`);
    }
    if (selected.length === 0) {
      // Reported as it is discovered: under `--source all` a provider with nothing selected says
      // so while the other provider's cycle still runs (its hint must not wait for the loop to end).
      if (relevantErrors.length === 0) process.stderr.write(`${noAccountsHint(plan, account)}\n`);
      continue;
    }
    if (plan.provider === "gmail") {
      // The cron window is Gmail's INBOX only (Story 5.4): a configured `labels` list is a backfill
      // key and is not honoured here — said once per configured account, not silently ignored.
      for (const entry of selected) {
        const configured = (entry as { labels?: string[] }).labels;
        if (Array.isArray(configured) && configured.length > 0) {
          logPort.warn(
            `Account "${entry.name}" has \`labels:\` configured — the cron window is the account's INBOX only; labels are honoured by --backfill.`,
            { accountId: entry.name },
          );
        }
      }
    }
    // Per-provider state files (Story 5.4 decision 2-A): each provider only reads and writes its
    // own `state/<provider>-<name>.json`, so same-named accounts never share a cursor.
    const stateOptions: StateFileOptions = { ...configDir, provider: plan.provider };
    providers.push({
      source: plan.provider,
      accounts: selected.map((entry) => plan.planFor(entry)),
      mailPort: plan.port,
      readAccountState: (accountName) => readAccountState(accountName, stateOptions),
      writeLastRunTimestamp: (accountName, date) => writeLastRunTimestamp(accountName, date, stateOptions),
      ...(plan.gmail === undefined ? {} : { gmail: plan.gmail }),
    });
  }

  if (providers.length === 0) {
    // A rejected selection reports its own hints rather than a busy lock (Story 8.2); nothing has
    // been locked, fetched or classified yet.
    return 1;
  }

  const lock: RunLockOptions = { ...configDir, pid: process.pid };
  const scheduler = runtime.scheduler ?? createScheduler();
  const now = runtime.now ?? (() => new Date());
  const intervalMs = options.intervalMinutes * 60_000;
  const totalAccounts = providers.reduce((total, provider) => total + provider.accounts.length, 0);
  // The store opens only once a cycle actually holds the lock — the same lock→store order the
  // backfill runs — so a start blocked by another invocation never leaves an empty `idempotency.db`
  // behind (Story 8.2's promise, which a whole-loop store open would have broken). It then stays
  // open for the daemon's lifetime: after the loop starts there is no exit path through this
  // command, only ticks.
  let store: IdempotencyStore | undefined;
  // Whether the cycle just run was blocked by another invocation's lock or escaped as a fault;
  // only the first cycle's value is read, to decide whether the loop may start at all.
  let blockedByLock = false;
  let firstCycleFailed = false;

  /**
   * One cycle: take the 8.2 lock, open the store on first success, run `runCronCycle` over the
   * selection, release the lock on every path, then write the AC's one line — the cycle's start,
   * its counters, its duration and the next cycle's time. A cycle that cannot take the lock (a
   * backfill in a gap) logs the 8.2 line, skips its tick and lets the loop carry on; a cycle that
   * faults surfaces one line, never a stack (AD-4), and the first one is terminal.
   */
  const runCycle = async (): Promise<void> => {
    try {
      acquireRunLock(lock);
    } catch (error) {
      blockedByLock = true;
      process.stderr.write(`${errorLine(error)}\n`);
      return;
    }
    blockedByLock = false;
    if (store === undefined) {
      try {
        store = new IdempotencyStore(configDir);
      } catch (error) {
        releaseLock(lock);
        firstCycleFailed = true;
        process.stderr.write(`${errorLine(error)}\n`);
        return;
      }
    }
    let report: CronCycleResult;
    try {
      report = await runCronCycle({
        providers,
        store,
        taxonomy,
        model,
        config: modelConfig,
        logPort,
        ...(runtime.now === undefined ? {} : { now: runtime.now }),
        ...(runtime.sleep === undefined ? {} : { sleep: runtime.sleep }),
      });
    } catch (error) {
      // A fault outside the cycle's per-account isolation (its wiring-fault contract): one line,
      // never a stack trace; the first cycle's is terminal, later ones log and loop on.
      firstCycleFailed = true;
      process.stderr.write(`${errorLine(error)}\n`);
      return;
    } finally {
      // The lock covers the store and the per-account state files this cycle writes; every exit
      // path releases it, so the gap before the next cycle stays free for `--backfill`.
      releaseLock(lock);
    }
    const nextAt = new Date(now().getTime() + intervalMs);
    process.stdout.write(
      `Cron cycle started ${report.startedAt.toISOString()}: ${report.fetched} fetched, ${report.labeled} labeled, ` +
        `${report.skipped} skipped, ${report.alreadyDone} already done, ${report.errors} error(s), ` +
        `took ${report.durationMs}ms — next cycle at ${nextAt.toISOString()}.\n`,
    );
    if (report.failures > 0) {
      process.stderr.write(
        `${report.failures} of ${totalAccounts} account(s) failed this cycle: ${report.failedAccounts.join(", ")}.\n`,
      );
    }
  };

  // The first cycle runs inline through `runOnce`, so a lock held by another invocation exits 1
  // with the 8.2 line and fetches nothing, before any interval exists.
  await scheduler.runOnce(runCycle);
  if (blockedByLock || firstCycleFailed) {
    store?.close();
    return 1;
  }
  // The loop: the interval keeps the process alive; Ctrl+C kills it with no handler (Story 9.2
  // owns graceful shutdown), and the per-cycle state stays consistent by construction. Awaiting the
  // scheduler's promise is free in production (the adapter resolves immediately, the interval then
  // runs on its own) and lets an injected scheduler finish its ticks before the command returns.
  await scheduler.runInterval(runCycle, intervalMs);
  return 0;
}