import {
  listEnabledAccounts,
  readAccountSettings,
  accountsDirDisplayPath,
} from "../../adapters/m365/accountSettings.js";
import { M365AuthAdapter, type FetchLike } from "../../adapters/m365/M365AuthAdapter.js";
import { KeychainTokenStore } from "../../adapters/token/KeychainTokenStore.js";

export interface AuthCommandOptions {
  provider: string;
  account: string;
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

async function authenticateOne(adapter: M365AuthAdapter, accountName: string): Promise<number> {
  try {
    const tokens = await adapter.authenticate(accountName);
    process.stdout.write(`m365 ${accountName}: authenticated (scopes: ${tokens.scopes.join(", ")})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`m365 ${accountName}: ${errorLine(error)}\n`);
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
  adapter: { authenticate(accountName: string): Promise<{ scopes: string[] }> },
  accountNames: string[],
  report: (outcome: AccountAuthOutcome) => void,
): Promise<number> {
  let failures = 0;
  for (const account of accountNames) {
    try {
      const tokens = await adapter.authenticate(account);
      report({ account, ok: true, line: `m365 ${account}: authenticated (scopes: ${tokens.scopes.join(", ")})` });
    } catch (error) {
      failures += 1;
      report({ account, ok: false, line: `m365 ${account}: FAILED — ${errorLine(error)}` });
    }
  }
  return failures;
}

async function authenticateAll(adapter: M365AuthAdapter): Promise<number> {
  let accounts;
  try {
    accounts = await listEnabledAccounts();
  } catch (error) {
    process.stderr.write(`m365: ${errorLine(error)}\n`);
    return 1;
  }
  if (accounts.length === 0) {
    process.stderr.write(
      `No enabled m365 accounts found — add ${accountsDirDisplayPath()}/<name>.yaml with "enabled: true".\n`,
    );
    return 1;
  }

  const failures = await authenticateAccounts(
    adapter,
    accounts.map((account) => account.name),
    (outcome) => {
      if (outcome.ok) process.stdout.write(`${outcome.line}\n`);
      else process.stderr.write(`${outcome.line}\n`);
    },
  );
  if (failures > 0) {
    process.stderr.write(`${failures} of ${accounts.length} m365 account(s) failed.\n`);
    return 1;
  }
  return 0;
}

export async function runAuth(options: AuthCommandOptions): Promise<number> {
  if (options.provider !== "m365") {
    process.stderr.write(`Unknown auth provider "${options.provider}" — only "m365" is supported.\n`);
    return 1;
  }

  const fetchFn = (globalThis as unknown as { fetch: FetchLike }).fetch;
  const tokenStore = new KeychainTokenStore({ promptPassphrase: createPassphrasePrompt() });
  const adapter = new M365AuthAdapter({
    fetchFn,
    tokenStore,
    accountSettings: { read: (accountName) => readAccountSettings(accountName) },
    onDeviceCode: ({ accountName, userCode, verificationUri }) => {
      process.stdout.write(
        `Sign in to m365 account "${accountName}" at ${verificationUri} with code ${userCode}\n`,
      );
    },
  });

  if (options.account === "all") return authenticateAll(adapter);
  return authenticateOne(adapter, options.account);
}
