import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { IdempotencyPort } from "../../core/ports/IdempotencyPort.js";
import { idempotencyKey } from "./key.js";

/** The sibling `stateFile.ts` writer's convention, duplicated per adapter rather than shared. */
const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "email-classify");

/** The one shared store's file, under the same config root as `state/` and the run lock. */
const STORE_FILE = "idempotency.db";

export type IdempotencyStoreErrorCode = "STORE_UNAVAILABLE" | "STORE_READ_FAILED" | "STORE_WRITE_FAILED";

/** Typed at the adapter boundary so the CLI renders one actionable line naming the path (AD-4). */
export class IdempotencyStoreError extends Error {
  readonly code: IdempotencyStoreErrorCode;
  /** The `idempotency.db` path every one of these lines names. */
  readonly path: string;

  constructor(code: IdempotencyStoreErrorCode, path: string, message: string) {
    super(message);
    this.name = "IdempotencyStoreError";
    this.code = code;
    this.path = path;
  }
}

export interface IdempotencyStoreOptions {
  /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
  configDir?: string;
}

/**
 * The AC's one shared idempotency store: `better-sqlite3` over `<configDir>/idempotency.db`,
 * whose single table is keyed by `idempotencyKey` and carries the `(accountId,
 * internetMessageId)` pair as an index. It opens eagerly and synchronously in the constructor —
 * `better-sqlite3` has no async API — so a corrupt file or an unwritable directory fails before
 * the caller fetches anything.
 *
 * `has`/`set` implement `IdempotencyPort` over the AC's opaque key; `labelsFor`/`record` are what
 * the backfill loop uses, because the pre-classify skip happens when the labels the key would
 * need are not yet known. A key-only row written by `set` leaves the pair columns NULL, so it can
 * never be read back as a classified message.
 */
export class IdempotencyStore implements IdempotencyPort {
  private readonly db: BetterSqlite3.Database;
  /** The database file this store owns; the path every typed error names. */
  readonly path: string;

  constructor(options: IdempotencyStoreOptions = {}) {
    const dir = options.configDir ?? DEFAULT_CONFIG_DIR;
    this.path = join(dir, STORE_FILE);
    let db: BetterSqlite3.Database;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // mkdir's mode applies only on creation; chmod restores 0700 on a pre-existing directory.
      chmodSync(dir, 0o700);
      db = new BetterSqlite3(this.path);
      db.exec(
        `CREATE TABLE IF NOT EXISTS classified_messages (
           key TEXT PRIMARY KEY,
           accountId TEXT,
           internetMessageId TEXT,
           labels TEXT
         );
         CREATE INDEX IF NOT EXISTS classified_messages_pair
           ON classified_messages (accountId, internetMessageId);`,
      );
      // The store holds this user's message ids; 0600 like the per-account state files.
      chmodSync(this.path, 0o600);
    } catch {
      throw new IdempotencyStoreError(
        "STORE_UNAVAILABLE",
        this.path,
        `Could not open the idempotency store (${this.path}) — check that it is a valid SQLite database and that its directory is writable.`,
      );
    }
    this.db = db;
  }

  /** `IdempotencyPort`: whether the AC's opaque key has ever been stored. */
  async has(key: string): Promise<boolean> {
    try {
      return this.db.prepare("SELECT 1 FROM classified_messages WHERE key = ?").get(key) !== undefined;
    } catch {
      throw new IdempotencyStoreError("STORE_READ_FAILED", this.path, `Could not read the idempotency store (${this.path}).`);
    }
  }

  /**
   * `IdempotencyPort`: stores the AC's opaque key alone. `INSERT OR IGNORE`, never `REPLACE` — a
   * key `record` already stored must keep its pair and labels, or `labelsFor` would answer
   * `undefined` and the message would be classified a second time. A repeated `set` stays a no-op,
   * and a key-only row keeps NULL pair columns, so it is never read back as a classified message.
   */
  async set(key: string): Promise<void> {
    try {
      this.db.prepare("INSERT OR IGNORE INTO classified_messages (key) VALUES (?)").run(key);
    } catch {
      throw new IdempotencyStoreError(
        "STORE_WRITE_FAILED",
        this.path,
        `Could not write to the idempotency store (${this.path}).`,
      );
    }
  }

  /**
   * The labels recorded for one account's message, or `undefined` when the pair was never
   * recorded. This is the pre-classify lookup: `internetMessageId` is known before the labels
   * are. The first row for a pair wins, which is stable across the extra rows a re-record under
   * a different outcome would add.
   */
  async labelsFor(accountId: string, internetMessageId: string): Promise<string[] | undefined> {
    try {
      const row = this.db
        .prepare(
          "SELECT labels FROM classified_messages WHERE accountId = ? AND internetMessageId = ? ORDER BY rowid LIMIT 1",
        )
        .get(accountId, internetMessageId) as { labels?: unknown } | undefined;
      if (row === undefined || typeof row.labels !== "string") return undefined;
      const parsed: unknown = JSON.parse(row.labels);
      return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === "string") : undefined;
    } catch {
      throw new IdempotencyStoreError("STORE_READ_FAILED", this.path, `Could not read the idempotency store (${this.path}).`);
    }
  }

  /**
   * Records a finished message — labels or an empty set — under the AC's hash, with the pair
   * indexed for the lookup. Re-recording the identical outcome rewrites the same primary key.
   */
  async record(accountId: string, internetMessageId: string, labels: string[]): Promise<void> {
    try {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO classified_messages (key, accountId, internetMessageId, labels) VALUES (?, ?, ?, ?)",
        )
        .run(idempotencyKey(accountId, internetMessageId, labels), accountId, internetMessageId, JSON.stringify(labels));
    } catch {
      throw new IdempotencyStoreError(
        "STORE_WRITE_FAILED",
        this.path,
        `Could not write to the idempotency store (${this.path}).`,
      );
    }
  }

  /** Closes the handle; the run owns the store's lifetime and a test must not leak one per case. */
  close(): void {
    this.db.close();
  }
}
