/** The commander options the entry point collects. */
export interface CliOptions {
  auth?: string;
  account?: string;
  syncCategories?: boolean;
}

/**
 * Which command the flags select — kept pure and exported so the entry point's routing, the
 * `--account` default and the mutually-exclusive flags stay testable without booting the CLI.
 * `src/cli/index.ts` calls `parseAsync` on import, so its action body cannot be imported by a test.
 */
export type CliCommand =
  | { kind: "auth"; provider: string; account: string }
  | { kind: "sync"; account: string }
  | { kind: "error"; message: string };

const AUTH_FLAGS_REQUIRED =
  "--auth <provider> and --account <name|all> are both required (e.g. --auth gmail --account personal).";

export function resolveCliCommand(options: CliOptions): CliCommand {
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
