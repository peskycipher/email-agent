import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeychainTokenStore,
  TokenStoreError,
  type KeychainBinding,
} from "../../../src/adapters/token/KeychainTokenStore.js";
import type { TokenSet } from "../../../src/core/dto/TokenSet.js";

const PASSPHRASE_ENV = "EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE";

const TOKENS: TokenSet = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 1_800_000_000_000,
  scopes: ["Mail.ReadWrite", "MailboxSettings.ReadWrite"],
};

function memoryKeychain(): KeychainBinding & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const key = (service: string, account: string) => `${service}\u0000${account}`;
  return {
    entries,
    async getPassword(service, account) {
      return entries.get(key(service, account)) ?? null;
    },
    async setPassword(service, account, password) {
      entries.set(key(service, account), password);
    },
    async deletePassword(service, account) {
      return entries.delete(key(service, account));
    },
  };
}

function unavailableKeychain(): KeychainBinding {
  const fail = (): never => {
    throw new Error("keychain unavailable");
  };
  return { getPassword: fail, setPassword: fail, deletePassword: fail };
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "token-store-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function fallbackFile(): string {
  return join(configDir, "accounts", "m365", "work", "tokens.json.age");
}

test("uses the OS keychain when available and writes no fallback file", async () => {
  const keychain = memoryKeychain();
  const store = new KeychainTokenStore({ keychain, configDir });

  await store.set("m365", "work", TOKENS);

  expect(await store.get("m365", "work")).toEqual(TOKENS);
  expect(keychain.entries.size).toBe(1);
  await expect(stat(fallbackFile())).rejects.toThrow();
});

test("falls back to a 0600 age file under 0700 parents when the keychain is unavailable", async () => {
  const store = new KeychainTokenStore({
    keychain: unavailableKeychain(),
    env: { [PASSPHRASE_ENV]: "correct horse battery staple" },
    promptPassphrase: async () => undefined,
    scryptWorkFactor: 12,
    configDir,
  });

  await store.set("m365", "work", TOKENS);

  const fileStat = await stat(fallbackFile());
  expect(fileStat.mode & 0o777).toBe(0o600);
  const accountDirStat = await stat(join(configDir, "accounts", "m365", "work"));
  expect(accountDirStat.mode & 0o777).toBe(0o700);
  const providerDirStat = await stat(join(configDir, "accounts", "m365"));
  expect(providerDirStat.mode & 0o777).toBe(0o700);

  // Round-trips through age, so the passphrase chain actually decrypts.
  expect(await store.get("m365", "work")).toEqual(TOKENS);
});

test("with no passphrase and a non-TTY stdin, fails naming the env var and writes nothing", async () => {
  const store = new KeychainTokenStore({
    keychain: unavailableKeychain(),
    env: {},
    promptPassphrase: async () => undefined,
    configDir,
  });

  const error = await store.set("m365", "work", TOKENS).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(TokenStoreError);
  expect((error as TokenStoreError).code).toBe("PASSPHRASE_UNAVAILABLE");
  expect((error as Error).message).toContain(PASSPHRASE_ENV);
  await expect(stat(fallbackFile())).rejects.toThrow();
});

test("reports a missing token as TOKEN_NOT_FOUND", async () => {
  const store = new KeychainTokenStore({ keychain: unavailableKeychain(), configDir });

  const error = await store.get("m365", "work").catch((err: unknown) => err);

  expect(error).toBeInstanceOf(TokenStoreError);
  expect((error as TokenStoreError).code).toBe("TOKEN_NOT_FOUND");
});

test("keeps two independently authenticated accounts in separate fallback files", async () => {
  const store = new KeychainTokenStore({
    keychain: unavailableKeychain(),
    env: { [PASSPHRASE_ENV]: "correct horse battery staple" },
    scryptWorkFactor: 12,
    configDir,
  });
  const personal: TokenSet = { accessToken: "personal-access", expiresAt: 1, scopes: ["Mail.ReadWrite"] };

  await store.set("m365", "personal", personal);
  await store.set("m365", "work", TOKENS);

  expect(await store.get("m365", "personal")).toEqual(personal);
  expect(await store.get("m365", "work")).toEqual(TOKENS);
  await stat(join(configDir, "accounts", "m365", "personal", "tokens.json.age"));
  await stat(fallbackFile());
});
