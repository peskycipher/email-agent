import { afterEach, beforeEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idempotencyKey } from "../../../src/adapters/idempotency/key.js";
import {
  IdempotencyStore,
  IdempotencyStoreError,
} from "../../../src/adapters/idempotency/sqliteIdempotencyStore.js";

let configDir: string;
let store: IdempotencyStore | undefined;

function open(): IdempotencyStore {
  return openAt(configDir);
}

function openAt(dir: string): IdempotencyStore {
  store = new IdempotencyStore({ configDir: dir });
  return store;
}

function storePath(): string {
  return join(configDir, "idempotency.db");
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "idempotency-store-"));
});

afterEach(async () => {
  try {
    store?.close();
  } catch {
    // A test that already closed its handle must not fail the teardown.
  }
  store = undefined;
  await chmod(configDir, 0o700).catch(() => undefined);
  await rm(configDir, { recursive: true, force: true });
});

test("the key is sha256 of the AC's exact string with the labels sorted (KEY)", () => {
  const expected = createHash("sha256").update("work|<m1@example.com>|Crypto,Receipts", "utf8").digest("hex");

  expect(idempotencyKey("work", "<m1@example.com>", ["Receipts", "Crypto"])).toBe(expected);
  // The account is baked into the hash: the same message id in two accounts is two rows.
  expect(idempotencyKey("personal", "<m1@example.com>", ["Crypto"])).not.toBe(
    idempotencyKey("work", "<m1@example.com>", ["Crypto"]),
  );
  // The input array is not reordered in place.
  const labels = ["B", "A"];
  idempotencyKey("work", "<m1@example.com>", labels);
  expect(labels).toEqual(["B", "A"]);
});

test("record then labelsFor answers per account and per message (FIRST_RUN, ACCOUNT_PARTITION)", async () => {
  const db = open();

  await db.record("work", "<m1@example.com>", ["Crypto"]);
  await db.record("work", "<m2@example.com>", []);
  await db.record("personal", "<m1@example.com>", ["Receipts"]);

  expect(await db.labelsFor("work", "<m1@example.com>")).toEqual(["Crypto"]);
  // An empty label set is a recorded outcome like any other.
  expect(await db.labelsFor("work", "<m2@example.com>")).toEqual([]);
  // One account's message never answers for another's, even with the same message id.
  expect(await db.labelsFor("personal", "<m1@example.com>")).toEqual(["Receipts"]);
  expect(await db.labelsFor("work", "<m3@example.com>")).toBeUndefined();
  expect(await db.labelsFor("ghost", "<m1@example.com>")).toBeUndefined();
});

test("a re-record of the same outcome is idempotent (ALREADY_DONE)", async () => {
  const db = open();

  await db.record("work", "<m1@example.com>", ["Crypto"]);
  await db.record("work", "<m1@example.com>", ["Crypto"]);

  expect(await db.has(idempotencyKey("work", "<m1@example.com>", ["Crypto"]))).toBe(true);
  expect(await db.labelsFor("work", "<m1@example.com>")).toEqual(["Crypto"]);
});

test("has/set implement the opaque port key, and a key-only row is never a classified message (KEY_ONLY)", async () => {
  const db = open();
  const key = idempotencyKey("work", "<m1@example.com>", ["Crypto"]);

  expect(await db.has(key)).toBe(false);

  await db.set(key);

  expect(await db.has(key)).toBe(true);
  // The pair columns stay NULL, so the pre-classify lookup cannot mistake it for a record.
  expect(await db.labelsFor("work", "<m1@example.com>")).toBeUndefined();
});

test("a corrupt store file fails the open with a typed error naming the path (STORE_UNAVAILABLE)", async () => {
  await writeFile(storePath(), "this is not a SQLite database", "utf8");

  const error = (() => {
    try {
      new IdempotencyStore({ configDir });
      return undefined;
    } catch (err: unknown) {
      return err;
    }
  })();

  expect(error).toBeInstanceOf(IdempotencyStoreError);
  expect((error as IdempotencyStoreError).code).toBe("STORE_UNAVAILABLE");
  expect((error as IdempotencyStoreError).path).toBe(storePath());
  expect((error as IdempotencyStoreError).message).toContain(storePath());
});

test("an unwritable config directory fails the open rather than half-opening (STORE_UNAVAILABLE)", async () => {
  // A read-only parent the store has to create its directory under. (The store's own config
  // directory is re-moded to 0700 on open, so only an ancestor can stay unwritable.)
  const lockedRoot = join(configDir, "locked");
  await mkdir(lockedRoot, { recursive: true });
  await chmod(lockedRoot, 0o500);
  const nested = join(lockedRoot, "email-classify");

  const error = (() => {
    try {
      new IdempotencyStore({ configDir: nested });
      return undefined;
    } catch (err: unknown) {
      return err;
    }
  })();

  expect(error).toBeInstanceOf(IdempotencyStoreError);
  expect((error as IdempotencyStoreError).code).toBe("STORE_UNAVAILABLE");
  expect((error as IdempotencyStoreError).path).toBe(join(nested, "idempotency.db"));
  expect((error as IdempotencyStoreError).message).toContain(join(nested, "idempotency.db"));

  await chmod(lockedRoot, 0o700);
});

test("opening restores 0700 on a pre-existing loose directory and 0600 on the file (PERMISSIONS)", async () => {
  await chmod(configDir, 0o755);

  open();

  expect((await stat(configDir)).mode & 0o777).toBe(0o700);
  expect((await stat(storePath())).mode & 0o777).toBe(0o600);
});

test("the store survives a close and reopen, keeping what it recorded (RESUME)", async () => {
  const first = open();
  await first.record("work", "<m1@example.com>", ["Crypto"]);
  first.close();

  const second = open();

  expect(await second.labelsFor("work", "<m1@example.com>")).toEqual(["Crypto"]);
  expect(await second.has(idempotencyKey("work", "<m1@example.com>", ["Crypto"]))).toBe(true);
  // The file is a real database on disk, not an in-memory handle.
  expect((await readFile(storePath())).length).toBeGreaterThan(0);
});

test("reading a closed handle is a typed read failure, never a crash (STORE_READ_FAILED)", async () => {
  const db = open();
  db.close();

  const error = await db.labelsFor("work", "<m1@example.com>").catch((err: unknown) => err);

  expect(error).toBeInstanceOf(IdempotencyStoreError);
  expect((error as IdempotencyStoreError).code).toBe("STORE_READ_FAILED");
  expect((error as IdempotencyStoreError).message).toContain(storePath());
});

test("writing to a closed handle is a typed write failure, never a crash (STORE_WRITE_FAILS)", async () => {
  const db = open();
  db.close();

  const recorded = await db.record("work", "<m1@example.com>", ["Crypto"]).catch((err: unknown) => err);
  const keyed = await db.set(idempotencyKey("work", "<m1@example.com>", ["Crypto"])).catch((err: unknown) => err);

  for (const error of [recorded, keyed]) {
    expect(error).toBeInstanceOf(IdempotencyStoreError);
    expect((error as IdempotencyStoreError).code).toBe("STORE_WRITE_FAILED");
    expect((error as IdempotencyStoreError).message).toContain(storePath());
  }
});

test("a missing config directory is created 0700 on the first run (FIRST_RUN)", async () => {
  const root = join(configDir, "nested", "email-classify");

  openAt(root);

  expect((await stat(root)).mode & 0o777).toBe(0o700);
  expect((await readFile(join(root, "idempotency.db"))).length).toBeGreaterThan(0);
});
