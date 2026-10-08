import {
  listEnabledAccounts as listM365Accounts,
  readAccountSettings as readM365AccountSettings,
  accountsDirDisplayPath as m365AccountsDirDisplayPath,
} from "../../adapters/m365/accountSettings.js";
import { M365AuthAdapter, type FetchLike } from "../../adapters/m365/M365AuthAdapter.js";
import {
  listEnabledAccounts as listGmailAccounts,
  readAccountSettings as readGmailAccountSettings,
  accountsDirDisplayPath as gmailAccountsDirDisplayPath,
} from "../../adapters/gmail/accountSettings.js";
import {
  authorizeWithLoopback,
  GmailAuthAdapter,
  type AuthorizeFn,
} from "../../adapters/gmail/GmailAuthAdapter.js";
import { KeychainTokenStore } from "../../adapters/token/KeychainTokenStore.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";

export type AuthProvider = "m365" | "gmail";

export interface AuthCommandOptions {
  provider: string;
  account: string;
}

/** The provider-specific method the `authenticate*` helpers need; both auth adapters implement it. */
export interface Authenticator {
  authenticate(accountName: string): Promise<{ scopes: string[] }>;
}

/** The `--account all` source shape, narrowed to what the command renders. */
export interface AccountsListingLike {
  accounts: Array<{ name: string }>;
  errors: Array<{ accountName: string; message: string }>;
}

/**
 * Test seam: lets a harness drive `runAuth` with a mocked network, a canned
 * authorization code and an in-memory token store. Production passes nothing.
 */
export interface AuthCommandRuntime {
  fetchFn?: FetchLike;
  authorize?: AuthorizeFn;
  tokenStore?: TokenPort;
  env?: Record<string, string | undefined>;
  /** Root of `~/.config/email-classify` for the temporary per-account readers. */
  configDir?: string;
}

/** Prints one actionable line — never a stack trace or raw payload (AD-4). */
function errorLine(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createPassphrasePrompt(): () => Promise<string | undefined> {
  let cached: string | undefined;
  return async () => {
    if (cached) return cached;
    if (!process.stdin.isTTY) return undefined;
    const value = await readHiddenLine("Token fallback passphrase: ");
    if (value) cached = value;
    return value;
  };
}

function readHiddenLine(prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    stderr.write(prompt);

    let value = "";
    const previousRaw = stdin.isRaw;

    function finish(result: string | undefined): void {
      stdin.off("data", onData);
      stdin.setRawMode?.(previousRaw ?? false);
      stdin.pause();
      stderr.write("\n");
      resolve(result);
    }

    function onData(chunk: string): void {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish(value);
          return;
        }
        if (char === "\u0003") {
          finish(undefined); // Ctrl-C
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

async function authenticateOne(adapter: Authenticator, provider: AuthProvider, accountName: string): Promise<number> {
  try {
    const tokens = await adapter.authenticate(accountName);
    process.stdout.write(`${provider} ${accountName}: authenticated (scopes: ${tokens.scopes.join(", ")})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${provider} ${accountName}: ${errorLine(error)}\n`);
    return 1;
  }
}

export interface AccountAuthOutcome {
  account: string;
  ok: boolean;
  line: string;
}

/**
 * Runs auth for each account independently: one failure never aborts the run
 * (I/O matrix row 8). Returns the failure count so the CLI can aggregate.
 */
export async function authenticateAccounts(
  adapter: Authenticator,
  provider: AuthProvider,
  accountNames: string[],
  report: (outcome: AccountAuthOutcome) => void,
): Promise<number> {
  let failures = 0;
  for (const account of accountNames) {
    try {
      const tokens = await adapter.authenticate(account);
      report({ account, ok: true, line: `${provider} ${account}: authenticated (scopes: ${tokens.scopes.join(", ")})` });
    } catch (error) {
      failures += 1;
      report({ account, ok: false, line: `${provider} ${account}: FAILED — ${errorLine(error)}` });
    }
  }
  return failures;
}

async function authenticateAll(
  adapter: Authenticator,
  provider: AuthProvider,
  listEnabledAccounts: () => Promise<AccountsListingLike>,
  accountsDirDisplayPath: string,
): Promise<number> {
  let listing: AccountsListingLike;
  try {
    listing = await listEnabledAccounts();
  } catch (error) {
    process.stderr.write(`${provider}: ${errorLine(error)}\n`);
    return 1;
  }
  const { accounts, errors } = listing;
  for (const error of errors) {
    process.stderr.write(`${provider} ${error.accountName}: ${error.message}\n`);
  }
  if (accounts.length === 0) {
    process.stderr.write(
      errors.length > 0
        ? `${errors.length} ${provider} account(s) have invalid settings — fix or remove them, then re-run.\n`
        : `No enabled ${provider} accounts found — add ${accountsDirDisplayPath}/<name>.yaml with "enabled: true".\n`,
    );
    return 1;
  }

  const failures = await authenticateAccounts(
    adapter,
    provider,
    accounts.map((account) => account.name),
    (outcome) => {
      if (outcome.ok) process.stdout.write(`${outcome.line}\n`);
      else process.stderr.write(`${outcome.line}\n`);
    },
  );
  const totalFailureCount = failures + errors.length;
  if (totalFailureCount > 0) {
    process.stderr.write(`${totalFailureCount} of ${accounts.length + errors.length} ${provider} account(s) failed.\n`);
    return 1;
  }
  return 0;
}

export async function runAuth(options: AuthCommandOptions, runtime: AuthCommandRuntime = {}): Promise<number> {
  if (options.provider !== "m365" && options.provider !== "gmail") {
    process.stderr.write(
      `Unknown auth provider "${options.provider}" — supported providers are "m365" and "gmail".\n`,
    );
    return 1;
  }
  const provider = options.provider;
  const configDir = runtime.configDir === undefined ? {} : { configDir: runtime.configDir };
  const fetchFn = runtime.fetchFn ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const tokenStore =
    runtime.tokenStore ?? new KeychainTokenStore({ promptPassphrase: createPassphrasePrompt(), ...configDir });

  const adapter =
    provider === "gmail"
      ? new GmailAuthAdapter({
          fetchFn,
          tokenStore,
          accountSettings: { read: (accountName) => readGmailAccountSettings(accountName, configDir) },
          authorize: runtime.authorize ?? authorizeWithLoopback,
          env: runtime.env ?? process.env,
        })
      : new M365AuthAdapter({
          fetchFn,
          tokenStore,
          accountSettings: { read: (accountName) => readM365AccountSettings(accountName, configDir) },
          onDeviceCode: ({ accountName, userCode, verificationUri }) => {
            process.stdout.write(
              `Sign in to m365 account "${accountName}" at ${verificationUri} with code ${userCode}\n`,
            );
          },
        });

  if (options.account === "all") {
    return provider === "gmail"
      ? authenticateAll(adapter, "gmail", () => listGmailAccounts(configDir), gmailAccountsDirDisplayPath())
      : authenticateAll(adapter, "m365", () => listM365Accounts(configDir), m365AccountsDirDisplayPath());
  }
  return authenticateOne(adapter, provider, options.account);
}
