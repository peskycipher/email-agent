import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The sibling `stateFile.ts` writer's convention, duplicated per adapter rather than shared. */
const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "email-classify");

/** The lock's file, taken by `--backfill` and `--cron` for the whole run. */
const LOCK_FILE = "run.lock";

export type RunLockErrorCode = "RUN_LOCK_HELD" | "RUN_LOCK_UNAVAILABLE";

/** Typed at the adapter boundary so the CLI renders one actionable line naming the path (AD-4). */
export class RunLockError extends Error {
  readonly code: RunLockErrorCode;
  /** The `run.lock` path this error names. */
  readonly path: string;

  constructor(code: RunLockErrorCode, path: string, message: string) {
    super(message);
    this.name = "RunLockError";
    this.code = code;
    this.path = path;
  }
}

export interface RunLockOptions {
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
  /** The holder's pid: written on acquire and the proof of ownership on release. */
  pid: number;
}

/** The lock file's path — `<configDir>/run.lock`, beside `idempotency.db` and `state/`. */
export function runLockPath(options: RunLockOptions): string {
  return join(options.configDir ?? DEFAULT_CONFIG_DIR, LOCK_FILE);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** The pid the lock file names, or `undefined` when it holds none this run can trust. */
function readHolder(path: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Absent, or unreadable: neither is a holder this run may claim blocks it.
    return undefined;
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Whether `pid` names a live process. Node has no `flock`, so `kill(pid, 0)` is the only probe:
 * it throws `ESRCH` for a dead pid and `EPERM` for a live one owned by another user.
 */
function holderIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/**
 * Takes the process-level lock over the shared config directory — the idempotency store and the
 * per-account state files. A live holder is the AC's "another email-classify run is in progress"
 * error; a lock file left by a dead pid (or one this run cannot parse as a pid) is stale and is
 * stolen, so a killed run never blocks the next one.
 *
 * The create is the mutual-exclusion point (`flag: "wx"`), so two runs starting in the same
 * instant cannot both proceed. Known limit: two processes may still both judge one *stale* lock as
 * stale and both steal it — Node has no `flock` and the steal is not atomic.
 */
export function acquireRunLock(options: RunLockOptions): void {
  const path = runLockPath(options);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Exclusive create: exactly one of two simultaneous starters wins; the loser lands in the
    // `EEXIST` branch below, where the holder is judged before it may steal.
    writeFileSync(path, `${options.pid}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    return;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw new RunLockError(
        "RUN_LOCK_UNAVAILABLE",
        path,
        `Could not take the run lock (${path}) — check that the directory is writable.`,
      );
    }
  }
  // The file exists: it is either held by a live run or left behind by a dead one.
  const holder = readHolder(path);
  if (holder !== undefined && holderIsAlive(holder)) {
    throw new RunLockError(
      "RUN_LOCK_HELD",
      path,
      `another email-classify run is in progress (pid ${holder}) — wait for it to finish, or remove ${path} if that process is gone.`,
    );
  }
  try {
    writeFileSync(path, `${options.pid}\n`, { mode: 0o600 });
    // writeFile's mode applies only on creation; chmod guarantees 0600 on a rewrite.
    chmodSync(path, 0o600);
  } catch {
    throw new RunLockError(
      "RUN_LOCK_UNAVAILABLE",
      path,
      `Could not take the run lock (${path}) — check that the directory is writable.`,
    );
  }
}

/**
 * Releases the lock, and only when this process still holds it: a run that lost the double-steal
 * race the adapter documents must not delete the winner's live lock. A missing file is nothing to
 * release. A failed removal is a typed error the caller reports as one line; the stale-pid rule
 * frees the file on the next run either way.
 */
export function releaseRunLock(options: RunLockOptions): void {
  const path = runLockPath(options);
  if (readHolder(path) !== options.pid) return;
  try {
    rmSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw new RunLockError(
      "RUN_LOCK_UNAVAILABLE",
      path,
      `Could not release the run lock (${path}) — remove it before the next run.`,
    );
  }
}
