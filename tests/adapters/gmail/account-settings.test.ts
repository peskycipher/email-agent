import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountSettingsError,
  listEnabledAccounts,
  readAccountSettings,
} from "../../../src/adapters/gmail/accountSettings.js";

let configDir: string;

function dir(): string {
  return join(configDir, "accounts", "gmail");
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "gmail-account-settings-"));
  await mkdir(dir(), { recursive: true });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function yamlFor(name: string, enabled = true): string {
  return `name: ${name}\nenabled: ${enabled}\nclientId: client-1\nclientSecretEnvVar: GMAIL_SECRET\n`;
}

async function writeAccount(name: string, body: string): Promise<void> {
  await writeFile(join(dir(), `${name}.yaml`), body, "utf8");
}

test("reads and validates a gmail settings file", async () => {
  await writeAccount("personal", yamlFor("personal"));

  const settings = await readAccountSettings("personal", { configDir });

  expect(settings).toEqual({
    name: "personal",
    enabled: true,
    clientId: "client-1",
    clientSecretEnvVar: "GMAIL_SECRET",
  });
});

test("parses the optional Story 5.3 labels and batchSize keys", async () => {
  await writeAccount(
    "personal",
    `name: personal\nenabled: true\nclientId: client-1\nclientSecretEnvVar: GMAIL_SECRET\nlabels: [INBOX, Label_5]\nbatchSize: 50\n`,
  );

  const settings = await readAccountSettings("personal", { configDir });

  expect(settings.clientId).toBe("client-1");
  expect(settings.labels).toEqual(["INBOX", "Label_5"]);
  expect(settings.batchSize).toBe(50);
});

test("leaves labels and batchSize undefined when the file omits them", async () => {
  await writeAccount("personal", yamlFor("personal"));

  const settings = await readAccountSettings("personal", { configDir });

  expect(settings.labels).toBeUndefined();
  expect(settings.batchSize).toBeUndefined();
});

const invalidFetchKeys: Array<[string, string, string]> = [
  ["batchSize 0", "batchSize: 0", "batchSize"],
  ["batchSize 101", "batchSize: 101", "batchSize"],
  ["an empty labels list", "labels: []", "labels"],
  ["a labels list with an empty string", 'labels: [""]', "labels"],
];

test.each(invalidFetchKeys)("rejects %s as SETTINGS_INVALID", async (_label, extra, field) => {
  await writeAccount(
    "personal",
    `name: personal\nenabled: true\nclientId: client-1\nclientSecretEnvVar: GMAIL_SECRET\n${extra}\n`,
  );

  const error = await readAccountSettings("personal", { configDir }).catch((e: unknown) => e);

  expect((error as AccountSettingsError).code).toBe("SETTINGS_INVALID");
  expect((error as Error).message).toContain(field);
});

test("missing settings name the expected gmail path", async () => {
  const error = await readAccountSettings("personal", { configDir }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(AccountSettingsError);
  expect((error as AccountSettingsError).code).toBe("SETTINGS_NOT_FOUND");
  expect((error as Error).message).toContain("~/.config/email-classify/accounts/gmail/personal.yaml");
});

test("a missing clientSecretEnvVar is rejected as SETTINGS_INVALID", async () => {
  await writeAccount("personal", "name: personal\nenabled: true\nclientId: client-1\n");

  const error = await readAccountSettings("personal", { configDir }).catch((e: unknown) => e);

  expect((error as AccountSettingsError).code).toBe("SETTINGS_INVALID");
  expect((error as Error).message).toContain("clientSecretEnvVar");
});

test("malformed YAML is rejected as SETTINGS_INVALID", async () => {
  await writeAccount("personal", "name: [unclosed");

  const error = await readAccountSettings("personal", { configDir }).catch((e: unknown) => e);

  expect((error as AccountSettingsError).code).toBe("SETTINGS_INVALID");
});

test("a file whose name field disagrees with its filename is rejected", async () => {
  await writeAccount("personal", yamlFor("work"));

  const error = await readAccountSettings("personal", { configDir }).catch((e: unknown) => e);

  expect((error as AccountSettingsError).code).toBe("SETTINGS_INVALID");
  expect((error as Error).message).toContain("must match");
});

test("rejects an invalid account name before any filesystem lookup", async () => {
  const error = await readAccountSettings("Bad_Name", { configDir }).catch((e: unknown) => e);

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

test("listEnabledAccounts reports an invalid-named file instead of silently skipping it", async () => {
  await writeAccount("a", yamlFor("a"));
  await writeFile(join(dir(), "My_Account.yaml"), yamlFor("My_Account"), "utf8");

  const { accounts, errors } = await listEnabledAccounts({ configDir });

  expect(accounts.map((account) => account.name)).toEqual(["a"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(AccountSettingsError);
  expect(errors[0]?.code).toBe("INVALID_ACCOUNT_NAME");
  expect(errors[0]?.accountName).toBe("My_Account");
});

test("listEnabledAccounts propagates a non-ENOENT readdir failure", async () => {
  await rm(dir(), { recursive: true, force: true });
  await writeFile(dir(), "not a directory", "utf8");

  await expect(listEnabledAccounts({ configDir })).rejects.toBeInstanceOf(Error);
});

test("listEnabledAccounts returns empty when the directory is missing", async () => {
  await rm(dir(), { recursive: true, force: true });

  expect(await listEnabledAccounts({ configDir })).toEqual({ accounts: [], errors: [] });
});
