import { afterEach, beforeEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountStateDir,
  readAccountState,
  stateFileDisplayPath,
  StateFileError,
  writeLastRunTimestamp,
} from "../../../src/adapters/config/stateFile.js";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "state-file-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function statePath(account = "work"): string {
  return join(configDir, "state", `${account}.json`);
}

async function writeRawState(contents: string, account = "work"): Promise<void> {
  await mkdir(join(configDir, "state"), { recursive: true, mode: 0o700 });
  await writeFile(statePath(account), contents, "utf8");
}

test("a missing state file is an empty state, never an error", async () => {
  expect(await readAccountState("work", { configDir })).toEqual({});
});

test("the display path names the home form by default and the real file under an injected configDir", () => {
  expect(stateFileDisplayPath("work")).toBe("~/.config/email-classify/state/work.json");
  expect(stateFileDisplayPath("work", { configDir })).toBe(statePath());
});

test("writeLastRunTimestamp creates the file and readAccountState round-trips the ISO instant", async () => {
  await writeLastRunTimestamp("work", new Date("2026-10-09T06:30:00.000Z"), { configDir });

  expect(await readAccountState("work", { configDir })).toEqual({ lastRunTimestamp: "2026-10-09T06:30:00.000Z" });
});

test("malformed JSON is a typed error naming the account and path, and is never overwritten (STATE_INVALID)", async () => {
  await writeRawState("{ not json");

  const error = await readAccountState("work", { configDir }).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(StateFileError);
  expect((error as StateFileError).code).toBe("STATE_INVALID");
  expect((error as StateFileError).accountName).toBe("work");
  expect((error as StateFileError).message).toContain(statePath());

  // A write that cannot read the state must leave the broken file byte-for-byte in place.
  await expect(writeLastRunTimestamp("work", new Date(), { configDir })).rejects.toBeInstanceOf(StateFileError);
  expect(await readFile(statePath(), "utf8")).toBe("{ not json");
});

test("a present lastRunTimestamp that is not ISO-8601 fails without overwriting (STATE_INVALID)", async () => {
  await writeRawState(JSON.stringify({ lastRunTimestamp: "yesterday" }));

  const error = await readAccountState("work", { configDir }).catch((err: unknown) => err);

  expect((error as StateFileError).code).toBe("STATE_INVALID");
  expect((error as StateFileError).message).toContain("lastRunTimestamp");
  await expect(writeLastRunTimestamp("work", new Date(), { configDir })).rejects.toBeInstanceOf(StateFileError);
  expect(await readFile(statePath(), "utf8")).toBe(JSON.stringify({ lastRunTimestamp: "yesterday" }));
});

test("a present non-string id is a typed error naming the key (STATE_INVALID)", async () => {
  await writeRawState(JSON.stringify({ lastHistoryId: 42 }));

  const error = await readAccountState("work", { configDir }).catch((err: unknown) => err);

  expect((error as StateFileError).code).toBe("STATE_INVALID");
  expect((error as StateFileError).message).toContain("lastHistoryId");
});

test("a non-object state file is a typed error, never an empty state (STATE_INVALID)", async () => {
  await writeRawState(JSON.stringify(["not", "an", "object"]));

  await expect(readAccountState("work", { configDir })).rejects.toBeInstanceOf(StateFileError);
});

test("writing merges, preserving a key owned by another provider (STATE_MERGE)", async () => {
  await writeRawState(JSON.stringify({ lastHistoryId: "42" }));

  await writeLastRunTimestamp("work", new Date("2026-10-09T06:30:00.000Z"), { configDir });

  expect(await readAccountState("work", { configDir })).toEqual({
    lastHistoryId: "42",
    lastRunTimestamp: "2026-10-09T06:30:00.000Z",
  });
});

test("an absent key stays absent, so one read never invents another provider's key", async () => {
  await writeLastRunTimestamp("work", new Date("2026-10-09T06:30:00.000Z"), { configDir });

  const state = await readAccountState("work", { configDir });

  expect(state).toEqual({ lastRunTimestamp: "2026-10-09T06:30:00.000Z" });
  expect("lastHistoryId" in state).toBe(false);
  expect("lastProcessedMessageId" in state).toBe(false);
});

test("the state file is 0600 inside a 0700 directory", async () => {
  await writeLastRunTimestamp("work", new Date(), { configDir });

  expect((await stat(statePath())).mode & 0o777).toBe(0o600);
  expect((await stat(accountStateDir({ configDir }))).mode & 0o777).toBe(0o700);
});

test("a rewrite restores 0600 even if the file was loosened (chmod)", async () => {
  await writeLastRunTimestamp("work", new Date(), { configDir });
  await chmod(statePath(), 0o644);

  await writeLastRunTimestamp("work", new Date(), { configDir });

  expect((await stat(statePath())).mode & 0o777).toBe(0o600);
});

test("a regex-shaped but impossible instant is STATE_INVALID, never a later RangeError (STATE_INVALID)", async () => {
  await writeRawState(JSON.stringify({ lastRunTimestamp: "2026-13-01T00:00:00Z" }));

  const error = await readAccountState("work", { configDir }).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(StateFileError);
  expect((error as StateFileError).code).toBe("STATE_INVALID");
  expect((error as StateFileError).message).toContain("lastRunTimestamp");
  await expect(writeLastRunTimestamp("work", new Date(), { configDir })).rejects.toBeInstanceOf(StateFileError);
});

test("an account name that could escape the state directory is rejected (STATE_INVALID)", async () => {
  await expect(readAccountState("../escape", { configDir })).rejects.toBeInstanceOf(StateFileError);
  await expect(writeLastRunTimestamp("../escape", new Date(), { configDir })).rejects.toBeInstanceOf(StateFileError);
});

test("writing restores 0700 on a pre-existing loose state directory", async () => {
  await mkdir(join(configDir, "state"), { recursive: true });
  await chmod(join(configDir, "state"), 0o755);

  await writeLastRunTimestamp("work", new Date(), { configDir });

  expect((await stat(accountStateDir({ configDir }))).mode & 0o777).toBe(0o700);
});

test("an unwritable config root fails the write with STATE_WRITE_FAILED (STATE_WRITE_FAILS)", async () => {
  // The read sees ENOENT (no state yet); creating the directory under a read-only root then fails.
  await chmod(configDir, 0o500);

  const error = await writeLastRunTimestamp("work", new Date(), { configDir }).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(StateFileError);
  expect((error as StateFileError).code).toBe("STATE_WRITE_FAILED");
  expect((error as StateFileError).accountName).toBe("work");
  expect((error as StateFileError).message).toContain(statePath());

  await chmod(configDir, 0o700);
});
