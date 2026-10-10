/** The commander options the entry point collects. */
export interface CliOptions {
  auth?: string;
  account?: string;
  syncCategories?: boolean;
  backfill?: boolean;
  cron?: boolean;
  source?: string;
  /** `--backfill` lower time bound (Story 8.1); parsed to a `Date` in the resolver. */
  since?: string;
  /** `--backfill` per-account fetch batch; validated here, clamped by the adapter. */
  batchSize?: string;
  /** `--cron` minutes between cycles; validated here (1–1440), defaulted to 15. */
  interval?: string;
}

/**
 * Which command the flags select — kept pure and exported so the entry point's routing, the
 * `--account` default and the mutually-exclusive flags stay testable without booting the CLI.
 * `src/cli/index.ts` calls `parseAsync` on import, so its action body cannot be imported by a test.
 */
export type CliCommand =
  | { kind: "auth"; provider: string; account: string }
  | { kind: "sync"; account: string }
  | { kind: "backfill"; source: "m365" | "gmail"; account: string; since?: Date; batchSize?: number }
  | { kind: "cron"; source: "m365" | "gmail" | "all"; account: string; intervalMinutes: number }
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
  // The two optional bounds are validated here so a malformed one fails before any account is listed.
  const since = parseSince(options.since);
  if (since === null) {
    return { kind: "error", message: `--since "${options.since}" is not a valid date — use an ISO-8601 date (e.g. 2026-01-01).` };
  }
  const batchSize = parseBatchSize(options.batchSize);
  if (batchSize === null) {
    return { kind: "error", message: `--batch-size "${options.batchSize}" is not a positive integer.` };
  }
  return {
    kind: "backfill",
    source,
    account: options.account ?? "all",
    ...(since === undefined ? {} : { since }),
    ...(batchSize === undefined ? {} : { batchSize }),
  };
}

/** `undefined` when unset; `null` when set but unparseable, so the caller can name the bad value. */
function parseSince(raw: string | undefined): Date | undefined | null {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

/** `undefined` when unset; `null` when set but not a positive integer. The ceiling stays the adapter's. */
function parseBatchSize(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * `undefined` when unset (the caller applies the 15-minute default); `null` when set but not a
 * whole number of minutes within the AC's bounds. The bounds are the validator's, not the
 * adapter's: a sleep of zero or of more than a day is a user typo, not a provider ceiling.
 */
function parseInterval(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 1440 ? value : null;
}

/**
 * The cron loop's recurring mode (Story 8.3): `--cron` always loops, sleeping `--interval` minutes
 * (default 15, bounds 1–1440) between cycles. Both providers have an incremental path (Story 5.4
 * lifted Gmail's), and `--source all` composes both in the one loop — the 8.1 decision's deferred
 * cross-provider case.
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
  if (source !== "m365" && source !== "gmail" && source !== "all") {
    return {
      kind: "error",
      message: `Unknown --source "${source}" — supported sources are "m365", "gmail" and "all".`,
    };
  }
  const interval = parseInterval(options.interval);
  if (interval === null) {
    return {
      kind: "error",
      message: `--interval "${options.interval}" is not a whole number of minutes between 1 and 1440 (e.g. --interval 15).`,
    };
  }
  // `--account` defaults to "all": the cron cycle is meant to run for every enabled account.
  return { kind: "cron", source, account: options.account ?? "all", intervalMinutes: interval ?? 15 };
}

export function resolveCliCommand(options: CliOptions): CliCommand {
  if (options.backfill !== true && (options.since !== undefined || options.batchSize !== undefined)) {
    return { kind: "error", message: "--since/--batch-size require --backfill." };
  }

  if (options.cron !== true && options.interval !== undefined) {
    return { kind: "error", message: "--interval requires --cron." };
  }

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
