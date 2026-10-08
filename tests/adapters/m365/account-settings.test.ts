import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountSettingsError,
  listEnabledAccounts,
  readAccountSettings,
} from "../../../src/adapters/m365/accountSettings.js";

let configDir: string;

function dir(): string {
  return join(configDir, "accounts", "m365");
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "account-settings-"));
  await mkdir(dir(), { recursive: true });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function yamlFor(name: string, enabled = true): string {
  return `name: ${name}\nenabled: ${enabled}\ntenantId: tenant-1\nclientId: client-1\n`;
}

async function writeAccount(name: string, body: string): Promise<void> {
  await writeFile(join(dir(), `${name}.yaml`), body, "utf8");
}

test("reads and validates a settings file", async () => {
  await writeAccount("work", yamlFor("work"));

  const settings = await readAccountSettings("work", { configDir });

  expect(settings).toEqual({
    name: "work",
    enabled: true,
    tenantId: "tenant-1",
    clientId: "client-1",
  });
});

test("missing settings name the expected per-account path", async () => {
  const error = await readAccountSettings("work", { configDir }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(AccountSettingsError);
  expect((error as AccountSettingsError).code).toBe("SETTINGS_NOT_FOUND");
  expect((error as Error).message).toContain("~/.config/email-classify/accounts/m365/work.yaml");
});

test("malformed YAML is rejected as SETTINGS_INVALID", async () => {
  await writeAccount("work", "name: [unclosed");

  const error = await readAccountSettings("work", { configDir }).catch((e: unknown) => e);

  expect((error as AccountSettingsError).code).toBe("SETTINGS_INVALID");
});

test("a schema-violating field is rejected as SETTINGS_INVALID", async () => {
  await writeAccount("work", "name: work\nenabled: true\ntenantId: ''\nclientId: client-1\n");

  const error = await readAccountSettings("work", { configDir }).catch((e: unknown) => e);

  expect((error as AccountSettingsError).code).toBe("SETTINGS_INVALID");
});

test("a file whose name field disagrees with its filename is rejected", async () => {
  await writeAccount("work", yamlFor("personal"));

  const error = await readAccountSettings("work", { configDir }).catch((e: unknown) => e);

  expect((error as AccountSettingsError).code).toBe("SETTINGS_INVALID");
  expect((error as Error).message).toContain("must match");
});

test("rejects an invalid account name before any filesystem lookup", async () => {
  const error = await readAccountSettings("Work!", { configDir }).catch((e: unknown) => e);

  expect((error as AccountSettingsError).code).toBe("INVALID_ACCOUNT_NAME");
});

test("listEnabledAccounts keeps only enabled, valid entries and reports the invalid one", async () => {
  await writeAccount("a", yamlFor("a"));
  await writeAccount("b", yamlFor("b", false));
  await writeAccount("c", "name: [unclosed");
  await writeFile(join(dir(), "notes.txt"), "ignore me", "utf8");

  const { accounts, errors } = await listEnabledAccounts({ configDir });

  expect(accounts.map((account) => account.name)).toEqual(["a"]);
  expect(errors.map((error) => error.accountName)).toEqual(["c"]);
});

test("listEnabledAccounts returns empty when the directory is missing", async () => {
  await rm(dir(), { recursive: true, force: true });

  expect(await listEnabledAccounts({ configDir })).toEqual({ accounts: [], errors: [] });
});

test("listEnabledAccounts propagates a non-ENOENT readdir failure", async () => {
  await rm(dir(), { recursive: true, force: true });
  await writeFile(dir(), "not a directory", "utf8");

  await expect(listEnabledAccounts({ configDir })).rejects.toBeInstanceOf(Error);
});
