import { afterEach, beforeEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, releaseRunLock, runLockPath, RunLockError } from "../../../src/adapters/lock/runLock.js";

let configDir: string;

function lockPath(): string {
  return runLockPath({ configDir, pid: process.pid });
}

/** A pid no process holds: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  const pid = child.pid;
  if (pid === undefined) throw new Error("the probe child did not report a pid");
  return pid;
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "run-lock-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

test("acquire writes the pid and release removes the file (HAPPY)", async () => {
  acquireRunLock({ configDir, pid: process.pid });

  expect(await readFile(lockPath(), "utf8")).toBe(`${process.pid}\n`);

  releaseRunLock({ configDir, pid: process.pid });
  await expect(readFile(lockPath(), "utf8")).rejects.toThrow();
});

test("a lock held by a live pid is the AC's typed error, and nothing is overwritten (CONCURRENT_RUN)", async () => {
  acquireRunLock({ configDir, pid: process.pid });

  const error = (() => {
    try {
      acquireRunLock({ configDir, pid: process.pid });
      return undefined;
    } catch (err: unknown) {
      return err;
    }
  })();

  expect(error).toBeInstanceOf(RunLockError);
  expect((error as RunLockError).code).toBe("RUN_LOCK_HELD");
  expect((error as RunLockError).message).toContain("another email-classify run is in progress");
  // The holder is named, so a blocked user can look at the process rather than guess.
  expect((error as RunLockError).message).toContain(`pid ${process.pid}`);
  expect((error as RunLockError).path).toBe(lockPath());
  expect(await readFile(lockPath(), "utf8")).toBe(`${process.pid}\n`);
});

test("a lock file left by a dead pid is stolen, not an error (STALE_LOCK)", async () => {
  await writeFile(lockPath(), `${deadPid()}\n`, "utf8");

  acquireRunLock({ configDir, pid: process.pid });

  expect(await readFile(lockPath(), "utf8")).toBe(`${process.pid}\n`);
});

test("a lock file that names no usable pid is stale too (STALE_LOCK)", async () => {
  await writeFile(lockPath(), "not-a-pid\n", "utf8");

  acquireRunLock({ configDir, pid: process.pid });

  expect(await readFile(lockPath(), "utf8")).toBe(`${process.pid}\n`);
});

test("release leaves another process's lock alone (OWNERSHIP)", async () => {
  // The winner of the double-steal race the adapter documents holds a pid that is not ours.
  const other = deadPid();
  await writeFile(lockPath(), `${other}\n`, "utf8");

  releaseRunLock({ configDir, pid: process.pid });

  expect(await readFile(lockPath(), "utf8")).toBe(`${other}\n`);
});

test("release with nothing to release is a no-op (OWNERSHIP)", () => {
  expect(() => releaseRunLock({ configDir, pid: process.pid })).not.toThrow();
});

test("an unwritable config root fails the acquire with a typed error naming the path (LOCK_UNAVAILABLE)", async () => {
  const lockedRoot = join(configDir, "locked");
  await mkdir(lockedRoot, { recursive: true });
  await chmod(lockedRoot, 0o500);
  const nested = join(lockedRoot, "email-classify");

  const error = (() => {
    try {
      acquireRunLock({ configDir: nested, pid: process.pid });
      return undefined;
    } catch (err: unknown) {
      return err;
    }
  })();

  expect(error).toBeInstanceOf(RunLockError);
  expect((error as RunLockError).code).toBe("RUN_LOCK_UNAVAILABLE");
  expect((error as RunLockError).path).toBe(join(nested, "run.lock"));
  expect((error as RunLockError).message).toContain(join(nested, "run.lock"));

  await chmod(lockedRoot, 0o700);
});
