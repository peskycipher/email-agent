---
title: 'Story 8.2: Idempotency & Resume (Multi-Account)'
type: 'feature'
created: '2026-10-10'
status: 'done'
route: 'dispatch'
baseline_commit: '0e9b35797ce63fae4df7f46d59e6a61bdcc0a0f3'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Backfill (Story 8.1) forgets everything when it dies: a killed run reclassifies from the start, and nothing stops a second invocation writing the same labels and racing on `~/.config/email-classify/state/`. `IdempotencyPort` and `src/adapters/idempotency/` already exist and hold nothing.

**Approach:** Give backfill a durable per-message record in one shared SQLite store at `~/.config/email-classify/idempotency.db`, looked up by account and message *before* classification so a resumed run skips work instead of redoing it, and stored under the key `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))` with the `accountId` baked in. Add a process-level file lock, taken by `--backfill` and `--cron` alike, over that store and the per-account state files, so a concurrent invocation exits 1 instead of racing.

## Boundaries & Constraints

**Always:** AD-10 holds — `core` imports nothing, `orch` reaches `core` only, the CLI wires adapters; the store, the key builder and the lock are adapters, because `core` may not import `node:crypto`. One database for all accounts, with the `accountId` baked into every key and no per-account store files. 8.1's isolation survives verbatim: one account's failure never aborts another's, and a failed account never reads as a successful one. Every failure is one actionable line naming the account or the path (AD-4), and the exit code reflects whether anything failed.

**Never:** no label removal, no taxonomy change, no change to `--since` / `--batch-size` semantics or the `--source all` guard (`src/cli/dispatch.ts:36`). Do not merge idempotency into `src/adapters/config/stateFile.ts`'s cursor writer, and do not touch `src/orch/fetch.ts`, `classify.ts` or `incremental.ts`. No SIGINT/SIGTERM handler in this story. Out of scope, each owned elsewhere: the interval loop (8.3), graceful shutdown — finish the current message, flush logs, exit 0 within 5 s (9.2), rate-limit backoff (9.1), the real logger and metrics (Epic 10), the DI container (Epic 11).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FIRST_RUN | Empty store; one account, 3 messages | All 3 classified; each recorded once done; `alreadyDone` 0 | N/A |
| ALREADY_DONE | The store already records the message | Nothing is classified and no write is attempted; `alreadyDone` increments | N/A |
| NO_WRITE_ALSO_RECORDED | Classifier returns `{ labels: [] }` | No write call, `skipped` increments, and the empty outcome is recorded so a re-run counts it `alreadyDone` | N/A |
| FAILED_NOT_RECORDED | `classify` or `writeLabels` throws for a message | `errors` increments and **nothing is recorded**, so the next run retries it | Isolated; account's remaining messages continue |
| CONCURRENT_RUN | A live run holds the lock; a second `--backfill` or `--cron` starts | "another email-classify run is in progress"; nothing fetched; exit 1 | N/A |
| STALE_LOCK | A lock file left by a dead pid | The new run takes it and proceeds | Not an error |
| STORE_UNAVAILABLE | `idempotency.db` corrupt, or its directory unwritable | One line naming the path; exit 1 before any fetch | Typed store error |
| STORE_WRITE_FAILS | `record` throws after a successful write | Line naming the account and message; that account's remaining messages continue | Isolated; counted as an error; exit non-zero |
| STALE_TAXONOMY | The message was recorded under an earlier taxonomy | It stays `alreadyDone` — the record is keyed by message, not by taxonomy version | Known limit; deleting `idempotency.db` is the remedy |
| SIGINT | Interrupted mid-account | Every message already done stays recorded and the next run skips it | No handler here — the synchronous per-message commit is the guarantee (Epic 9.2 owns graceful shutdown) |

## Decisions (human, 2026-10-10)

- **The check is pre-classify; the AC's key is what gets stored.** A lookup by `(accountId, internetMessageId)` runs before `classify`, so a resumed run saves the model calls and not merely the writes. The AC's `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))` is the row's primary key, with the pair indexed for the lookup; the epic's "if the key exists, the message is skipped" is reconciled to this reading.
- **`alreadyDone` is a new counter**, added to `AccountProgress`, `BackfillResult` and the progress line. It stays out of `processed`, which keeps its 8.1 meaning, so `processed = labeled + skipped` still holds and `fetched = labeled + skipped + alreadyDone + errors`.
- **The lock is taken by `--backfill` and `--cron`**, the two commands that mutate the shared config dir. `--auth` and `--sync-categories` stay lock-free so an auth prompt never blocks a long backfill.
- **No SIGINT handler.** Each message is committed to SQLite synchronously before the next begins, so everything completed is already durable and the AC's "progress is saved per account" holds without touching signals. Epic 9.2 owns the handler, the log flush and the exit code. The epic's 8.2 wording is left as-is — `_bmad-output/planning-artifacts/**` is human-owned.

</frozen-after-approval>

## Code Map

- `src/core/ports/IdempotencyPort.ts:1` — `has(key)` / `set(key)`, already re-exported at `src/core/index.ts:4`. Implement it unchanged; the pre-classify lookup is an extra method on the adapter, not a change to the port.
- `src/adapters/idempotency/` — empty but for `.gitkeep`; where the store goes. Mirror `src/adapters/token/KeychainTokenStore.ts`: a typed error carrying a `code`, and an options object with an injectable `configDir`.
- `src/adapters/config/stateFile.ts:5` — `DEFAULT_CONFIG_DIR = join(homedir(), ".config", "email-classify")`, the path convention to copy (duplicated per adapter, not shared). The `ponytail:` comment at `:198` claims "no concurrent runner exists until Story 8.3 owns one" — stale, correct it to 8.2.
- `src/orch/classification-run.ts:113-115` — the seam between the fetch loop's end and the `classify` call, where the pre-classify lookup goes. `BackfillOptions` (`:29`) gains the store seam; `AccountProgress` (`:22`) and `BackfillResult` (`:44`) gain `alreadyDone`; `logProgress` (`:60`) and the final line (`:173`) print it. Isolation already lives at `:117-121`, `:129-133` and `:154-161`.
- `src/cli/commands/backfill.ts:98` — `runBackfill(options, runtime)`; `BackfillRuntime` (`:55`) already carries `configDir`, the seam the store and lock take. Its doc comment at `:89-97` ends "Nothing is persisted yet — resume is Story 8.2's" and changes here.
- `src/cli/commands/cron.ts:89` — `runCron(options, runtime)`, which takes the same lock; its `CronRuntime` (`:36`) also carries `configDir` and `now`.
- `src/cli/main.ts:46,54` — the `--backfill` option text and `addHelpText`; `CliHandlers.runBackfill` (`:17`) is the pinned handler signature. `src/cli/dispatch.ts:31` — `resolveBackfill`, touched only if a new flag appears.
- `src/adapters/gmail/messageMapper.ts:80` + `src/adapters/gmail/gmailWire.ts:206` — **the identity trap.** The mapper reads a *top-level* `internetMessageId` that Gmail's `Message` resource never returns, `readString` (`messageMapper.ts:7`) degrades a missing field to `""`, and the batch request asks for `metadataHeaders=From,Subject` only. So every Gmail message carries `internetMessageId: ""` and a pair lookup degenerates. Repair both files here. m365 is fine — `src/adapters/m365/M365Adapter.ts:17` selects the field. The fixtures hide this: `tests/adapters/gmail/harness.ts:122`, `tests/cli/backfill.test.ts:162` and `tests/cli/cron.test.ts:325` invent a top-level `internetMessageId`, while `tests/adapters/gmail/message-mapper.test.ts:48` already pins the empty degradation.
- Tests: `tests/cli/cron.test.ts:97-107` is the temp-`configDir` `beforeEach`/`afterEach` to copy for the store test; extend `tests/cli/backfill.test.ts` and `tests/orch/classification-run.test.ts`.
- **Out of bounds:** `src/core/**` beyond the existing port; `src/orch/fetch.ts`, `classify.ts`, `incremental.ts`; signal handling anywhere; `src/adapters/gmail/**` beyond the `internetMessageId` repair this story needs.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/idempotency/sqliteIdempotencyStore.ts` — `IdempotencyStore implements IdempotencyPort` over `better-sqlite3` at `<configDir>/idempotency.db`: one table keyed by the AC's hash with `accountId`/`internetMessageId`/`labels` columns and an index on the pair, plus `labelsFor(accountId, internetMessageId)`, a typed `IdempotencyStoreError`, 0700/0600 permissions and a `close()` for tests — it is the AC's single shared store.
- [x] `src/adapters/idempotency/key.ts` — the pure `idempotencyKey(accountId, internetMessageId, labels)` hashing exactly the AC's string with `node:crypto` — the frozen formula, kept out of `core`.
- [x] `src/adapters/lock/runLock.ts` — `acquireRunLock({ configDir, pid })` creating or taking `<configDir>/run.lock` and stealing it from a dead holder, throwing the AC's typed "another email-classify run is in progress" error; plus `releaseRunLock()`.
- [x] `src/orch/classification-run.ts` — thread the store seam through `BackfillOptions` and the message loop: look up before `classify`, record after a write or an empty label set, never record a failure, treat an empty `internetMessageId` as never recorded (skip both the lookup and the record, so two messages can never collapse onto one pair), and add `alreadyDone` to both counters and the progress line.
- [x] `src/adapters/gmail/gmailWire.ts`, `src/adapters/gmail/messageMapper.ts` — add `Message-ID` to the batch request's `metadataHeaders` and map that header into `MessageDTO.internetMessageId`, empty only when the header is genuinely absent — the pre-classify lookup is only as good as this identity, which today is `""` for every Gmail message.
- [x] `tests/adapters/gmail/harness.ts`, `tests/cli/backfill.test.ts`, `tests/cli/cron.test.ts` — model the real `format=metadata` shape (the `Message-ID` header inside `payload.headers`, no top-level field) and add a Gmail-source resume test — the fixture, not the provider, is what makes the current dedupe look correct.
- [x] `src/cli/commands/backfill.ts` — build the store and the lock from `configDir`, pass the store to the loop, release the lock on every exit path, and map a store or lock failure to one line plus exit 1.
- [x] `src/cli/commands/cron.ts` — take and release the same lock around its run.
- [x] `src/adapters/index.ts` — re-export both new adapters and their error types, per the barrel convention.
- [x] `tests/orch/classification-run.test.ts` — pin every row of the I/O matrix.
- [x] `tests/adapters/idempotency/sqliteIdempotencyStore.test.ts` — `has`/`set`/`labelsFor` across two accounts in a temp `configDir`, plus the corrupt-store path.
- [x] `tests/cli/backfill.test.ts`, `tests/cli/cron.test.ts` — a second run with identical args classifies nothing and reports `alreadyDone`; a held lock exits 1 with the AC's line and fetches nothing, for both commands.

**Acceptance Criteria:**
- Given a message is fetched for an account, when the store already records it, then it is not classified and no write is attempted, and the account's `alreadyDone` count rises.
- Given a message is classified and its labels are written, when the write succeeds, then the outcome is stored under `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))` in the single shared `~/.config/email-classify/idempotency.db`. An empty label set is stored the same way; a failed classification or write stores nothing and is retried next run.
- Given a run holds the lock, when a second `--backfill` or `--cron` invocation starts, then it exits 1 with "another email-classify run is in progress" and fetches nothing.
- Given the store or the lock file cannot be read or written, when the run starts, then one actionable line naming the path is written and the exit code is 1.
- Given a run is interrupted, when the same command is re-run with the same arguments, then each account continues from the work already recorded for it rather than from the beginning.
- Given either provider's messages are fetched, when their ids are read, then each message carries a distinct non-empty `internetMessageId` and every fetched message is classified on the first run.

## Implementation Notes

- **As-built shape.** `IdempotencyStore` (`src/adapters/idempotency/sqliteIdempotencyStore.ts`) opens
  eagerly and synchronously in its constructor — `better-sqlite3` has no async API — so a corrupt file
  or an unwritable directory fails before the caller fetches anything. The table is
  `classified_messages(key TEXT PRIMARY KEY, accountId, internetMessageId, labels)` with an index on
  `(accountId, internetMessageId)`.
- **The port key and the pair answer different questions.** `has`/`set` implement `IdempotencyPort`
  over the AC's opaque hash; `record`/`labelsFor` are what the loop uses, because the pre-classify
  skip happens when the labels the key would need are not yet known. A key-only `set` row leaves the
  pair columns NULL and is therefore never read back as a classified message (pinned by `KEY_ONLY`).
- **`alreadyDone` stays out of `processed`.** With an already-done message never classified,
  `processed = labeled + skipped` keeps its 8.1 meaning and `fetched = labeled + skipped +
  alreadyDone + errors` is the full partition.
- **Unspecified judgements the implementer settled.** (1) A `labelsFor` read failure mid-run is that
  message's error and the message is retried next run, rather than aborting the account — aborting
  would lose the account's remaining messages. (2) A failing `releaseRunLock` is reported as one line
  but does not change an already-decided exit code; the stale-pid rule frees the file on the next run.
  (3) `runBackfill` now takes the lock and opens the store before the taxonomy/model checks, so a
  store or lock problem is reported before anything is fetched.
- **Documented limits.** Only one `--backfill`/`--cron` runs at a time, but two processes stealing the
  same stale lock in the same instant can both proceed — Node has no `flock` (noted in `runLock.ts`).
  A message recorded under an older taxonomy stays `alreadyDone`; deleting `idempotency.db` is the
  remedy (matrix row `STALE_TAXONOMY`). The store grows without pruning — not in scope here.
- **Verification (2026-10-10).** `mise exec node@20 -- bun run test` — 36 files, 551 tests passed
  (34 new) followed by the `typecheck` script green; `bun run lint` — exit 0, AD-10 core guard
  included; `bun run build` — exit 0.
- **Loop 2 re-derivation (2026-10-10).** The Gmail identity is repaired — `gmailWire.ts` now asks
  for `metadataHeaders=From,Subject,Message-ID` and `messageMapper.ts` reads the `Message-ID`
  header — so `internetMessageId` is populated for Gmail instead of always `""`. An empty
  `internetMessageId` is now never looked up and never recorded, so no two messages can collapse
  onto one `(accountId, "")` pair. Loop-1 judgement (3) is reversed: `runBackfill` and `runCron`
  validate the account selection *before* taking the lock or opening the store, so a rejected
  selection prints its own hint and leaves no empty `idempotency.db`. `releaseRunLock` also checks
  ownership before unlinking, the lock error names the holding pid, and `--help` names both files.
- **Loop-2 review patches (2026-10-10).** `acquireRunLock` now creates the lock with `flag: "wx"` and
  treats `EEXIST` as "read the holder, then judge staleness", so two runs starting in the same
  instant can no longer both proceed. `set` uses `INSERT OR IGNORE`, so it can no longer strip a
  stored record's pair columns. The `--help` state clause now names `--backfill` for the store and
  both commands for the lock.
- **Verification (loop 2, 2026-10-10).** `mise exec node@20 -- bun run test` — 36 files, 552 tests
  passed (35 new); `bun run lint` — exit 0, AD-10 core guard included; `bun run build` — exit 0.
## Spec Change Log

### Loop 1 (2026-10-10) — bad_spec: the Gmail idempotency identity

- **Trigger:** blind-hunter 1–4 and edge-case-hunter 1–2 (see the Review Triage Log). The spec chose a lookup identity that the Gmail adapter never populates, so the pre-classify lookup collapsed every Gmail message onto one pair.
- **Amended (non-frozen only):** the Code Map gained the Gmail identity facts; the Tasks gained the `Message-ID` repair, the empty-identity guard and the fixture corrections; one AC pins it.
- **Known-bad state avoided:** a Gmail backfill that classifies exactly one message per account, counts every other one `alreadyDone`, and exits 0.
- **KEEP:** the pre-classify pair lookup as the lookup and the AC's hash as the row identity; `alreadyDone` kept outside `processed`; the pid lock taken by `--backfill` and `--cron`; no signal handler; the store's schema, permissions and typed errors as built.

## Review Triage Log

Loop 1 (2026-10-10) — layers: blind-hunter (21 findings), edge-case-hunter (3), verification-gap (2).

- **high — every Gmail message collapses onto one idempotency pair** (blind-hunter 1–4; edge-case-hunter 1, 2). Verified at the source: `src/adapters/gmail/messageMapper.ts:80` reads a top-level `internetMessageId`, `readString` (`:7`) degrades a missing field to `""`, and `src/adapters/gmail/gmailWire.ts:206` requests `format=metadata&metadataHeaders=From,Subject`, so the Gmail API — whose `Message` resource has no such field — never supplies it. Once the first Gmail message is recorded, the new pre-classify `labelsFor(accountId, "")` matches for every later one, which is counted `alreadyDone`, never classified and never written, on the first run and every run. The m365 path is unaffected (`M365Adapter.ts:17`). The fixtures hide it (`tests/adapters/gmail/harness.ts:122`, `tests/cli/backfill.test.ts:162`, `tests/cli/cron.test.ts:325`), `tests/adapters/gmail/message-mapper.test.ts:48` already pins the empty degradation, and the new `RESUME` test drives m365 only. **bad_spec** — the spec's Code Map never checked that the chosen identity is populated on both providers, and the repair (request `Message-ID`, map it, guard the empty case, correct the fixtures) is a spec-level change.
- **low — the lock is released without checking ownership** (blind-hunter 9). Real: `releaseRunLock` unlinks its path unconditionally (`runLock.ts:104`), so the loser of the double-steal race the adapter already documents can delete the winner's live lock and let a third run start. The wider window is inside the documented limit; **patch**.
- **low — `store.close()` and the release share one `finally`** (blind-hunter 10). Real: `backfill.ts:132-135` calls `close()` before `releaseLock` in the same `finally`, so a throwing `close()` skips the unlock. Rejected — `better-sqlite3`'s `close()` throws only on an already-closed or busy handle, and nesting the try is added structure for a case not shown reachable.
- **low — the typed errors discard the reason** (blind-hunter 11). Real: `IdempotencyStoreError`/`RunLockError` take no `cause` and `has`/`labelsFor` emit identical text. Rejected — the line still names the path and the action is the same for every read failure; the fix spans both constructors.
- **low — `chmodSync(configDir, 0o700)` sits inside the store's open `try`** (blind-hunter 12). Real: a failed re-mode aborts a run whose database would have opened. Rejected — the directory is the user's own config root, the tightening matches the sibling `stateFile.ts` writer, and the fix is a restructure.
- **false — a landed label write reads as a failure rather than a label** (blind-hunter 13). The frozen `STORE_WRITE_FAILS` row specifies exactly this counting, and `fetched = labeled + skipped + alreadyDone + errors` still holds (`classification-run.ts:216-218`). The only fix is to edit this build's spec.
- **low — the store's uniqueness assumption is not enforced** (blind-hunter 14). Real: the pair index is non-unique and `labelsFor` defends with `ORDER BY rowid LIMIT 1`, which today is load-bearing for Gmail because of the first entry. Rejected — a `UNIQUE` index is a schema change, and the Gmail collapse it interacts with is fixed by the first entry.
- **false — `has`/`set` have no production caller** (blind-hunter 15). The frozen `Always` requires implementing `IdempotencyPort` unchanged; `record`/`labelsFor` are its consumers on the same table and `KEY_ONLY` pins that a key-only row cannot impersonate a record. No user-visible harm is named.
- **low — the lock and store are taken before account and taxonomy validation** (blind-hunter 16). Real: a rejected invocation such as `--backfill --account <typo>` leaves an empty `idempotency.db`, and a busy lock reports before the account hint. **patch**.
- **low — the lock error names the path but not the holder** (blind-hunter 17). Real: `holderIsAlive` parses the pid and discards it, so a blocked user cannot see which process to inspect. Direct correction; **patch**.
- **low — the spec status disagrees with the board** (blind-hunter 18). Real: the spec vocabulary is `in-review` while `sprint-status.yaml` defines `review`, and the board reads `in-progress` for a story whose tasks are all done. **patch** — the board is re-synced by the step-03 loopback and by step 5.
- **low — Code Map line references drift** (blind-hunter 19). Real but cosmetic; the only fix edits this build's spec. Rejected.
- **low — the AC's concatenation is unescaped** (blind-hunter 20). Real in principle; the formula is the frozen AC, `accountId` is a validated slug, and a collision needs a crafted label or provider id containing `|`. Rejected — the fix edits the frozen formula.
- **low — duplicated helpers** (blind-hunter 21). Real: `releaseLock` is copied into `backfill.ts` and `cron.ts`. Rejected — extraction is more than a direct correction, and Story 8.1's log already accepted this class as cosmetic.
- **low — `labelsFor`'s payload is parsed and discarded** (blind-hunter 5). Real: only presence is used. Rejected — the `JSON.parse` sits inside the method's `try` and is wrapped into a typed error, and a corrupt row is the already-handled `CORRUPT` case.
- **low — `--help` and the docs never name the new durable state** (blind-hunter 6). Real: `idempotency.db` and `run.lock` appear nowhere user-facing. Direct correction; **patch**.
- **low — the known limits are not in `deferred-work.md`** (blind-hunter 7). The ledger is the register of record, but the limits are already carried by the frozen matrix and Design Notes. **defer**.
- **low — release on a non-zero exit is untested** (blind-hunter 8; verification-gap 1). Pre-verified: the `finally` does release on that path, but no test runs a failing cycle and then checks the lock, so a regression would go unnoticed. **patch**.
- **low — the 0700 restore on a pre-existing directory is untested** (verification-gap 2). Pre-verified: `PERMISSIONS` uses an already-0700 `mkdtemp` dir, so deleting the `chmodSync` would go undetected, unlike the sibling `state-file.test.ts:248` pattern. **patch**.
- **low — pid reuse makes a stale lock look held forever** (edge-case-hunter 3). Real only if an unrelated process inherits the dead holder's pid; the remedy needs a start-time or token check. Rejected — unlikely in everyday use and the fix is added complexity.

Loop 2 (2026-10-10) — layers: blind-hunter (12 findings), edge-case-hunter (1), verification-gap (0 gaps, 1 other finding).

- **medium — `acquireRunLock` checks for a holder and then writes without O_EXCL** (blind-hunter 1; edge-case-hunter 1; verification-gap "Other"). Verified at `src/adapters/lock/runLock.ts:80-90`: `readHolder` answers `undefined` for a missing file and the fall-through `writeFileSync(path, pid, { mode: 0o600 })` carries no `flag: "wx"`, so two runs starting in the same instant both see no lock, both write and both proceed. The AC's "concurrent invocations exit 1" is therefore not guaranteed, and the per-account state files the lock is meant to serialise go unguarded. Every `CONCURRENT_RUN` test covers only an already-held lock, so nothing observes it. **patch** — the smallest fix is an atomic create that treats `EEXIST` as "read the holder, then decide staleness".
- **low — `set()` can un-record a completed message** (blind-hunter 2). Verified at `sqliteIdempotencyStore.ts:106`: `INSERT OR REPLACE INTO classified_messages (key)` on a key `record` already stored deletes that row and re-inserts it with NULL pair columns, so `labelsFor` answers `undefined` and the message is classified again. No production caller reaches it — `has`/`set` are the port's dormant surface — but the adapter is exported and the port is a future caller's contract. **patch** — `INSERT OR IGNORE` keeps the pair and still makes a repeated `set` a no-op.
- **low — the new `--help` state paragraph misleads `--cron`** (blind-hunter 9). Verified in `main.ts:56`: the "Completed messages are recorded in … idempotency.db … delete that file to force a full re-classification" clause follows a sentence naming both `--backfill` and `--cron`, but only `--backfill` records there; a cron cycle resumes from the per-account state file. **patch** — scope the clause to `--backfill`.
- **false — re-recording under a different label set leaves a stale row that wins forever** (blind-hunter 3). A second row for one pair needs the message to be classified after it was recorded, which the pre-classify guard prevents; its record-failure path leaves no row to supersede. The only sequence that reaches it is the free-lock race patched above.
- **carried — `store.close()` runs before `releaseLock` in one `finally`** (blind-hunter 8). The code still reads exactly as the Loop-1 row describes (`backfill.ts:248-252`), so the row keeps its `low` verdict and its rejection, and is not patched again.
- **carried — the key formula's delimiters are unescaped** (blind-hunter 6). Same claim as Loop 1, argued harder (`["A,B"]` collides with `["A","B"]`); kept at `low` and rejected, because its fix edits the frozen formula, which only the human may change.
- **carried — duplicated helpers** (blind-hunter 12). `releaseLock` is still copied between `backfill.ts` and `cron.ts`, and the `deadPid` probe across three test files; kept at `low` and rejected as in Loop 1.
- **carried — the spec status disagrees with the board** (blind-hunter 5). The board half stands (`sprint-status.yaml` still reads `in-progress`); the `review_loop_iteration: 1` half is false — one loopback has run, so 1 is the correct value. Kept at `low`.
- **low — `readHolder` treats an unreadable lock file as stale** (blind-hunter 7). Real as filed — the `catch` returns `undefined` for `EACCES` as well as `ENOENT`. Rejected: the config root is per-user, so this tool's own deployment cannot produce a lock its process may not read, and the fix adds an error branch.
- **low — the per-account line reads as though its four counters sum to `Processed`** (blind-hunter 4). Real, and the same shape the 8.1 line already had with `errors` outside `processed`. Rejected — the rewrite would touch every assertion on that string for an ambiguity the counter names already disambiguate.
- **low — `labelsFor`'s parse failure is reported as a generic read error** (blind-hunter 11). Real, but the line still names the path and the user's action is identical. Rejected — its only fix edits this build's triage log, where "CORRUPT" was a test name and never a code.
- **low — the lock's granularity and non-atomic acquire need a Design Notes note** (blind-hunter 10). Rejected — the only fix is to edit this build's spec, and the atomicity half is what the first entry patches.

## Design Notes

- **Why an adapter, not `core`.** `IdempotencyPort` takes an opaque key string, and `scripts/check-core-external-imports.mjs` denies `core` any `node:` import, so the sha256 lives in the adapter and the orchestrator receives a structural seam carrying `labelsFor`/`record` — the same idiom as `CategorySyncTarget` and `LabelWriteTarget`.
- **Why the row is keyed by the AC's hash and looked up by the pair.** The key formula is the AC's, so it stays the row identity and makes a re-record a no-op; the pair index is what makes the skip happen before classification, when the labels are not yet known.
- **Why `better-sqlite3`, and why the lock is pid-based.** The repo pins `node >=20.19 <21` and `node:sqlite` only lands in 22.5; `better-sqlite3@9.6.0` and its types are already dependencies, and its synchronous `set` is durable before the next message starts — which is what lets the run resume without a signal handler. Node has no `flock`, so the lock file holds a pid and a new run steals it when `process.kill(pid, 0)` reports the holder is gone.

## Verification

**Commands:**
- `mise exec node@20 -- bun run test` — expected: all suites pass, including the new store and orch tests.
- `mise exec node@20 -- bun run lint` — expected: exit 0, the AD-10 core guard included.
- `mise exec node@20 -- bun run build` — expected: exit 0.
