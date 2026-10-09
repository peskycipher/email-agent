import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Decrypter, Encrypter } from "age-encryption";
import type { TokenSet } from "../../core/dto/TokenSet.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";

/** The subset of the `keytar` module the store uses; injecting it keeps tests off the native module. */
export interface KeychainBinding {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * Resolves the age-fallback passphrase, or returns `undefined` when stdin is not
 * a TTY so no prompt can run (the store then names the env var and fails).
 */
export type PassphrasePrompt = () => Promise<string | undefined>;

export interface KeychainTokenStoreDeps {
  /** Keytar-backed by default (lazy dynamic import). */
  keychain?: KeychainBinding;
  /** `Config.tokenFallback.passphraseEnvVar` (AD-9). */
  passphraseEnvVar?: string;
  env?: Record<string, string | undefined>;
  promptPassphrase?: PassphrasePrompt;
  /** age scrypt work factor (log2); defaults to age's own 18, injectable so tests stay fast. */
  scryptWorkFactor?: number;
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
}

export type TokenStoreErrorCode =
  | "TOKEN_NOT_FOUND"
  | "TOKEN_READ_FAILED"
  | "TOKEN_WRITE_FAILED"
  | "TOKEN_DELETE_FAILED"
  | "PASSPHRASE_UNAVAILABLE";

/** Typed at the adapter boundary so the CLI can render one actionable line (AD-4). */
export class TokenStoreError extends Error {
  readonly code: TokenStoreErrorCode;
  readonly accountId: string;

  constructor(code: TokenStoreErrorCode, accountId: string, message: string) {
    super(message);
    this.name = "TokenStoreError";
    this.code = code;
    this.accountId = accountId;
  }
}

const DEFAULT_PASSPHRASE_ENV_VAR = "EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE";

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** Keytar is resolved lazily so a store built for a test never loads the native binding. */
class LazyKeytarBinding implements KeychainBinding {
  private module?: Promise<KeychainBinding>;

  private load(): Promise<KeychainBinding> {
    this.module ??= import("keytar").then((mod) => mod as unknown as KeychainBinding);
    return this.module;
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    return (await this.load()).getPassword(service, account);
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    return (await this.load()).setPassword(service, account, password);
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    return (await this.load()).deletePassword(service, account);
  }
}

/**
 * `TokenPort` implementation: OS keychain (keytar) is primary, with an
 * age-encrypted file fallback when the keychain is unavailable. Provider-agnostic
 * so Gmail auth (Story 3.1) reuses it.
 */
export class KeychainTokenStore implements TokenPort {
  private readonly keychain: KeychainBinding;
  private readonly passphraseEnvVar: string;
  private readonly env: Record<string, string | undefined>;
  private readonly promptPassphrase: PassphrasePrompt;
  private readonly scryptWorkFactor?: number;
  private readonly configDir: string;

  constructor(deps: KeychainTokenStoreDeps = {}) {
    this.keychain = deps.keychain ?? new LazyKeytarBinding();
    this.passphraseEnvVar = deps.passphraseEnvVar ?? DEFAULT_PASSPHRASE_ENV_VAR;
    this.env = deps.env ?? process.env;
    this.promptPassphrase = deps.promptPassphrase ?? (async () => undefined);
    this.scryptWorkFactor = deps.scryptWorkFactor;
    this.configDir = deps.configDir ?? join(homedir(), ".config", "email-classify");
  }

  async get(provider: "m365" | "gmail", accountId: string): Promise<TokenSet> {
    const fromKeychain = await this.readKeychain(provider, accountId);
    if (fromKeychain !== undefined) return this.parseTokenSet(fromKeychain, accountId);
    return this.readFallbackFile(provider, accountId);
  }

  async set(provider: "m365" | "gmail", accountId: string, tokens: TokenSet): Promise<void> {
    const payload = JSON.stringify(tokens);
    try {
      await this.keychain.setPassword(this.serviceName(provider, accountId), accountId, payload);
      return;
    } catch {
      // Keychain unavailable — fall through to the encrypted file.
    }
    await this.writeFallbackFile(provider, accountId, payload);
  }

  async delete(provider: "m365" | "gmail", accountId: string): Promise<void> {
    let keychainFailed = false;
    try {
      await this.keychain.deletePassword(this.serviceName(provider, accountId), accountId);
    } catch {
      keychainFailed = true;
    }

    let fileExisted = false;
    try {
      await unlink(this.fallbackPath(provider, accountId));
      fileExisted = true;
    } catch (error) {
      if (!isEnoent(error)) {
        throw new TokenStoreError(
          "TOKEN_DELETE_FAILED",
          accountId,
          `Could not delete the stored token for account "${accountId}".`,
        );
      }
    }

    // If the keychain was inaccessible and the fallback file was already absent,
    // we cannot confirm the token is gone — the token may still live in the keychain.
    if (keychainFailed && !fileExisted) {
      throw new TokenStoreError(
        "TOKEN_DELETE_FAILED",
        accountId,
        `Could not delete the stored token for account "${accountId}".`,
      );
    }
  }

  private serviceName(provider: string, accountId: string): string {
    return `email-classify-${provider}-${accountId}`;
  }

  private fallbackPath(provider: string, accountId: string): string {
    return join(this.configDir, "accounts", provider, accountId, "tokens.json.age");
  }

  private async readKeychain(provider: string, accountId: string): Promise<string | undefined> {
    try {
      const value = await this.keychain.getPassword(this.serviceName(provider, accountId), accountId);
      return value ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async resolvePassphrase(accountId: string): Promise<string> {
    const fromEnv = this.env[this.passphraseEnvVar];
    if (fromEnv) return fromEnv;
    const prompted = await this.promptPassphrase();
    if (prompted) return prompted;
    throw new TokenStoreError(
      "PASSPHRASE_UNAVAILABLE",
      accountId,
      `Keychain is unavailable and ${this.passphraseEnvVar} is not set — set it or run on an interactive terminal.`,
    );
  }

  private async writeFallbackFile(provider: string, accountId: string, payload: string): Promise<void> {
    const passphrase = await this.resolvePassphrase(accountId);
    const path = this.fallbackPath(provider, accountId);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const encrypter = new Encrypter();
      if (this.scryptWorkFactor !== undefined) encrypter.setScryptWorkFactor(this.scryptWorkFactor);
      encrypter.setPassphrase(passphrase);
      const ciphertext = await encrypter.encrypt(payload);
      await writeFile(path, ciphertext, { mode: 0o600 });
      // writeFile's mode applies only on creation; chmod guarantees 0600 on rewrite.
      await chmod(path, 0o600);
    } catch {
      throw new TokenStoreError(
        "TOKEN_WRITE_FAILED",
        accountId,
        `Could not write the encrypted token file for account "${accountId}".`,
      );
    }
  }

  private async readFallbackFile(provider: string, accountId: string): Promise<TokenSet> {
    const path = this.fallbackPath(provider, accountId);
    let ciphertext: Uint8Array;
    try {
      ciphertext = await readFile(path);
    } catch (error) {
      if (isEnoent(error)) {
        throw new TokenStoreError("TOKEN_NOT_FOUND", accountId, `No stored token for account "${accountId}".`);
      }
      throw new TokenStoreError(
        "TOKEN_READ_FAILED",
        accountId,
        `Could not read the stored token for account "${accountId}".`,
      );
    }
    const passphrase = await this.resolvePassphrase(accountId);
    try {
      const decrypter = new Decrypter();
      decrypter.addPassphrase(passphrase);
      const plaintext = await decrypter.decrypt(new Uint8Array(ciphertext), "text");
      return this.parseTokenSet(plaintext, accountId);
    } catch (error) {
      if (error instanceof TokenStoreError) throw error;
      throw new TokenStoreError(
        "TOKEN_READ_FAILED",
        accountId,
        `Stored token for account "${accountId}" could not be decrypted.`,
      );
    }
  }

  private parseTokenSet(payload: string, accountId: string): TokenSet {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new TokenStoreError(
        "TOKEN_READ_FAILED",
        accountId,
        `Stored token for account "${accountId}" is corrupted.`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new TokenStoreError(
        "TOKEN_READ_FAILED",
        accountId,
        `Stored token for account "${accountId}" is corrupted.`,
      );
    }
    return parsed as TokenSet;
  }
}
