/** The commander options the entry point collects. */
export interface CliOptions {
  auth?: string;
  account?: string;
  syncCategories?: boolean;
  backfill?: boolean;
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
  | { kind: "backfill"; source: "m365"; account: string }
  | { kind: "error"; message: string };

const AUTH_FLAGS_REQUIRED =
  "--auth <provider> and --account <name|all> are both required (e.g. --auth gmail --account personal).";

/** Only M365 backfill exists yet; the Gmail half is a later story, named so the line is actionable. */
function resolveBackfill(options: CliOptions): CliCommand {
  if (options.auth !== undefined || options.syncCategories === true) {
    const other = options.auth !== undefined ? "--auth" : "--sync-categories";
    return {
      kind: "error",
      message: `--backfill and ${other} cannot be combined — run them as separate commands.`,
    };
  }
  const source = options.source ?? "m365";
  if (source === "gmail" || source === "all") {
    return {
      kind: "error",
      message: `--source ${source} is not supported yet — Gmail message fetch is Story 5.3; use --source m365.`,
    };
  }
  if (source !== "m365") {
    return { kind: "error", message: `Unknown --source "${source}" — supported sources are "m365" and "gmail" (Story 5.3).` };
  }
  // `--account` defaults to "all": backfill is meant to run for every enabled account.
  return { kind: "backfill", source: "m365", account: options.account ?? "all" };
}

export function resolveCliCommand(options: CliOptions): CliCommand {
  if (options.backfill === true) return resolveBackfill(options);

  if (options.source !== undefined) {
    // Without this guard a stray `--source` would vanish and the run would fail for another reason.
    return { kind: "error", message: "--source requires --backfill (e.g. --backfill --source m365)." };
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
