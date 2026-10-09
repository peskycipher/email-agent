import { afterEach, beforeEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountStateDir,
  readAccountState,
  stateFileDisplayPath,
  StateFileError,
  writeLastHistoryId,
  writeLastRunTimestamp,
} from "../../../src/adapters/config/stateFile.js";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "state-file-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

/** The per-provider cursor file (Story 5.4 decision 2-A): `m365-<name>.json` / `gmail-<name>.json`. */
function statePath(account = "work", provider: "m365" | "gmail" = "m365"): string {
  return join(configDir, "state", `${provider}-${account}.json`);
}

/** The legacy file name Stories 5.1/5.2 wrote; read back for m365 only, never written again. */
function legacyStatePath(account = "work"): string {
  return join(configDir, "state", `${account}.json`);
}

async function writeRawState(contents: string, path: string): Promise<void> {
  await mkdir(join(configDir, "state"), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, "utf8");
}

test("a missing state file is an empty state, never an error", async () => {
  expect(await readAccountState("work", { configDir })).toEqual({});
});

test("a missing gmail cursor file is an empty state too, and the legacy name is never read (EC2)", async () => {
  await writeRawState(JSON.stringify({ lastRunTimestamp: "2026-10-08T08:00:00.000Z" }), legacyStatePath());

  expect(await readAccountState("work", { configDir, provider: "gmail" })).toEqual({});
});

test("the display path names the home form by default and the real file under an injected configDir", () => {
  expect(stateFileDisplayPath("work")).toBe("~/.config/email-classify/state/m365-work.json");
  expect(stateFileDisplayPath("work", { configDir })).toBe(statePath());
  expect(stateFileDisplayPath("work", { configDir, provider: "gmail" })).toBe(statePath("work", "gmail"));
});

test("writeLastRunTimestamp creates the namespaced file and readAccountState round-trips the ISO instant", async () => {
  await writeLastRunTimestamp("work", new Date("2026-10-09T06:30:00.000Z"), { configDir });

  expect(await readAccountState("work", { configDir })).toEqual({ lastRunTimestamp: "2026-10-09T06:30:00.000Z" });
});

test("the m365 reader falls back to the legacy cursor file, so 5.2's cursors survive (EC2)", async () => {
  await writeRawState(JSON.stringify({ lastRunTimestamp: "2026-10-08T08:00:00.000Z" }), legacyStatePath());

  expect(await readAccountState("work", { configDir })).toEqual({ lastRunTimestamp: "2026-10-08T08:00:00.000Z" });
});

test("an m365 read prefers the namespaced file once it exists, and writes never touch the legacy file (EC2)", async () => {
  await writeRawState(JSON.stringify({ lastRunTimestamp: "2026-10-07T08:00:00.000Z" }), legacyStatePath());
  await writeLastRunTimestamp("work", new Date("2026-10-09T06:30:00.000Z"), { configDir });

  expect(await readAccountState("work", { configDir })).toEqual({ lastRunTimestamp: "2026-10-09T06:30:00.000Z" });
  // The legacy file is read-only from here on — no migration step ever rewrites it.
  expect(await readFile(legacyStatePath(), "utf8")).toBe(JSON.stringify({ lastRunTimestamp: "2026-10-07T08:00:00.000Z" }));
});

test("malformed JSON is a typed error naming the account and path, and is never overwritten (STATE_INVALID)", async () => {
  await writeRawState("{ not json", statePath());

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
  await writeRawState(JSON.stringify({ lastRunTimestamp: "yesterday" }), statePath());

  const error = await readAccountState("work", { configDir }).catch((err: unknown) => err);

  expect((error as StateFileError).code).toBe("STATE_INVALID");
  expect((error as StateFileError).message).toContain("lastRunTimestamp");
  await expect(writeLastRunTimestamp("work", new Date(), { configDir })).rejects.toBeInstanceOf(StateFileError);
  expect(await readFile(statePath(), "utf8")).toBe(JSON.stringify({ lastRunTimestamp: "yesterday" }));
});

test("a present non-string id is a typed error naming the key (STATE_INVALID)", async () => {
  await writeRawState(JSON.stringify({ lastHistoryId: 42 }), statePath());

  const error = await readAccountState("work", { configDir }).catch((err: unknown) => err);

  expect((error as StateFileError).code).toBe("STATE_INVALID");
  expect((error as StateFileError).message).toContain("lastHistoryId");
});

test("a non-object state file is a typed error, never an empty state (STATE_INVALID)", async () => {
  await writeRawState(JSON.stringify(["not", "an", "object"]), statePath());

  await expect(readAccountState("work", { configDir })).rejects.toBeInstanceOf(StateFileError);
});

test("writing merges, preserving a key owned by another provider (STATE_MERGE)", async () => {
  await writeRawState(JSON.stringify({ lastHistoryId: "42" }), statePath());

  await writeLastRunTimestamp("work", new Date("2026-10-09T06:30:00.000Z"), { configDir });

  expect(await readAccountState("work", { configDir })).toEqual({
    lastHistoryId: "42",
    lastRunTimestamp: "2026-10-09T06:30:00.000Z",
  });
});

test("writeLastHistoryId defaults to the gmail namespace and round-trips through it", async () => {
  await writeLastHistoryId("work", "12345", { configDir });

  expect(await readAccountState("work", { configDir, provider: "gmail" })).toEqual({ lastHistoryId: "12345" });
  // A Gmail write creates no m365 cursor file.
  await expect(readFile(statePath("work", "m365"), "utf8")).rejects.toThrow();
});

test("a Gmail cycle records both of its keys in one read-merge-written file (STATE_MERGE)", async () => {
  await writeLastHistoryId("work", "H1", { configDir });
  await writeLastRunTimestamp("work", new Date("2026-10-09T06:30:00.000Z"), { configDir, provider: "gmail" });

  expect(await readAccountState("work", { configDir, provider: "gmail" })).toEqual({
    lastHistoryId: "H1",
    lastRunTimestamp: "2026-10-09T06:30:00.000Z",
  });

  await writeLastRunTimestamp("work", new Date("2026-10-09T07:30:00.000Z"), { configDir, provider: "gmail" });

  expect(await readAccountState("work", { configDir, provider: "gmail" })).toEqual({
    lastHistoryId: "H1",
    lastRunTimestamp: "2026-10-09T07:30:00.000Z",
  });
});

test("a gmail cycle's keys never land in an m365 account's file, for the same name (EC2)", async () => {
  await writeLastHistoryId("shared", "H1", { configDir, provider: "gmail" });
  await writeLastRunTimestamp("shared", new Date("2026-10-09T06:30:00.000Z"), { configDir, provider: "m365" });

  expect(await readAccountState("shared", { configDir, provider: "gmail" })).toEqual({ lastHistoryId: "H1" });
  expect(await readAccountState("shared", { configDir, provider: "m365" })).toEqual({
    lastRunTimestamp: "2026-10-09T06:30:00.000Z",
  });
});

test("an empty history id is rejected by the writer, never persisted for its reader to trip on (STATE_INVALID)", async () => {
  await expect(writeLastHistoryId("work", "", { configDir })).rejects.toBeInstanceOf(StateFileError);
  await expect(readFile(statePath(), "utf8")).rejects.toThrow();
});

test("an invalid existing file blocks writeLastHistoryId too, and is never overwritten (STATE_INVALID)", async () => {
  await writeRawState("{ not json", statePath("work", "gmail"));

  await expect(writeLastHistoryId("work", "12345", { configDir })).rejects.toBeInstanceOf(StateFileError);
  expect(await readFile(statePath("work", "gmail"), "utf8")).toBe("{ not json");
});

test("a corrupted legacy cursor read by the m365 fallback is a typed error naming the legacy path, never empty state (STATE_INVALID)", async () => {
  await writeRawState("{ not json", legacyStatePath());

  const error = (await readAccountState("work", { configDir }).catch((err: unknown) => err)) as StateFileError;

  expect(error).toBeInstanceOf(StateFileError);
  expect(error.message).toContain(legacyStatePath());
});

test("the history-id write uses the same 0600/0700 body as the timestamp write", async () => {
  await writeLastHistoryId("work", "12345", { configDir });

  expect((await stat(statePath("work", "gmail"))).mode & 0o777).toBe(0o600);
  expect((await stat(accountStateDir({ configDir }))).mode & 0o777).toBe(0o700);
});

test("the gmail provider's write also uses 0600/0700", async () => {
  await writeLastHistoryId("work", "12345", { configDir, provider: "gmail" });

  expect((await stat(statePath("work", "gmail"))).mode & 0o777).toBe(0o600);
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
  await writeRawState(JSON.stringify({ lastRunTimestamp: "2026-13-01T00:00:00Z" }), statePath());

  const error = await readAccountState("work", { configDir }).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(StateFileError);
  expect((error as StateFileError).code).toBe("STATE_INVALID");
  expect((error as StateFileError).message).toContain("lastRunTimestamp");
  await expect(writeLastRunTimestamp("work", new Date(), { configDir })).rejects.toBeInstanceOf(StateFileError);
});

test("an account name that could escape the state directory is rejected by every reader and writer (STATE_INVALID)", async () => {
  await expect(readAccountState("../escape", { configDir })).rejects.toBeInstanceOf(StateFileError);
  await expect(writeLastRunTimestamp("../escape", new Date(), { configDir })).rejects.toBeInstanceOf(StateFileError);
  await expect(writeLastHistoryId("../escape", "12345", { configDir })).rejects.toBeInstanceOf(StateFileError);
});

test("the same escape rule holds for the gmail provider namespace (STATE_INVALID)", async () => {
  await expect(readAccountState("../escape", { configDir, provider: "gmail" })).rejects.toBeInstanceOf(StateFileError);
  await expect(writeLastHistoryId("../escape", "12345", { configDir, provider: "gmail" })).rejects.toBeInstanceOf(
    StateFileError,
  );
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
