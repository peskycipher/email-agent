/** The commander options the entry point collects. */
export interface CliOptions {
  auth?: string;
  account?: string;
  syncCategories?: boolean;
  backfill?: boolean;
  cron?: boolean;
  source?: string;
}

/**
 * Which command the flags select — kept pure and exported so the entry point's routing, the
 * `--account` default and the mutually-exclusive flags stay testable without booting the CLI.
 * `src/cli/index.ts` calls `parseAsync` on import, so its action body cannot be imported by a test.
 */
export type CliCommand =
  | { kind: "auth"; provider: string; account: string }
  | { kind: "sync"; account: string }
  | { kind: "backfill"; source: "m365" | "gmail"; account: string }
  | { kind: "cron"; source: "m365" | "gmail"; account: string }
  | { kind: "error"; message: string };

const AUTH_FLAGS_REQUIRED =
  "--auth <provider> and --account <name|all> are both required (e.g. --auth gmail --account personal).";

/** Both providers have a backfill; Story 5.4 gave Gmail an incremental path too, but `--cron` still names its provider here. */
function resolveBackfill(options: CliOptions): CliCommand {
  if (options.auth !== undefined || options.syncCategories === true || options.cron === true) {
    const other =
      options.auth !== undefined ? "--auth" : options.syncCategories === true ? "--sync-categories" : "--cron";
    return {
      kind: "error",
      message: `--backfill and ${other} cannot be combined — run them as separate commands.`,
    };
  }
  const source = options.source ?? "m365";
  if (source === "all") {
    // Human decision (2026-10-09): `all` is not a provider — a backfill names one.
    return { kind: "error", message: `--source all is not supported — choose "m365" or "gmail".` };
  }
  if (source !== "m365" && source !== "gmail") {
    return { kind: "error", message: `Unknown --source "${source}" — supported sources are "m365" and "gmail".` };
  }
  // `--account` defaults to "all": backfill is meant to run for every enabled account.
  return { kind: "backfill", source, account: options.account ?? "all" };
}

/**
 * Both providers have an incremental path (Story 5.4 lifted Gmail's); `all` is not a provider, and
 * the multi-provider loop is Story 8.3's.
 */
function resolveCron(options: CliOptions): CliCommand {
  if (options.auth !== undefined || options.syncCategories === true || options.backfill === true) {
    const other =
      options.auth !== undefined ? "--auth" : options.syncCategories === true ? "--sync-categories" : "--backfill";
    return {
      kind: "error",
      message: `--cron and ${other} cannot be combined — run them as separate commands.`,
    };
  }
  const source = options.source ?? "m365";
  if (source === "all") {
    // Human decision (2026-10-09): a cron cycle names one provider; Story 8.3 owns the `all` loop.
    return { kind: "error", message: `--source all is not supported — choose "m365" or "gmail".` };
  }
  if (source !== "m365" && source !== "gmail") {
    return { kind: "error", message: `Unknown --source "${source}" — supported sources are "m365" and "gmail".` };
  }
  // `--account` defaults to "all": the cron cycle is meant to run for every enabled account.
  return { kind: "cron", source, account: options.account ?? "all" };
}

export function resolveCliCommand(options: CliOptions): CliCommand {
  if (options.backfill === true) return resolveBackfill(options);
  if (options.cron === true) return resolveCron(options);

  if (options.source !== undefined) {
    // Without this guard a stray `--source` would vanish and the run would fail for another reason.
    return { kind: "error", message: "--source requires --backfill or --cron (e.g. --backfill --source m365)." };
  }

  if (options.syncCategories === true) {
    if (options.auth !== undefined) {
      // Without this guard the sync would run and `--auth` would vanish unnoticed.
      return {
        kind: "error",
        message: "--auth and --sync-categories cannot be combined — run them as two commands.",
      };
    }
    // `--account` defaults to "all": the categories sync is meant to run for every account.
    return { kind: "sync", account: options.account ?? "all" };
  }

  const { auth: provider, account } = options;
  if (!provider || !account) return { kind: "error", message: AUTH_FLAGS_REQUIRED };
  return { kind: "auth", provider, account };
}
