---
title: 'Story 8.3: Cron Mode Loop (Multi-Account)'
type: 'feature'
created: '2026-10-10'
status: 'done'
route: 'dispatch'
baseline_commit: '97d794253856af7cd01a87706b9917d96d9cbb93'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `--cron` is still the temporary fetch-only command: it fetches what is new per account, throws the messages away, and exits — the epic's own doc comment says "Nothing is classified or written back. Looped by Story 8.3". The classifier, the label write-back and the 8.2 idempotency store have no recurring caller, and `--source all` still does not exist for cron (the 8.1 decision deferred the cross-provider loop here).

**Approach:** Turn `--cron` into the product's recurring mode: an interval loop that, per cycle and per selected account, fetches only what is new, classifies it, writes the labels back through the 8.1/8.2 stages, and updates the account's state — with per-account isolation, a 30s backoff retry for fetch/write errors, re-queueing of failed messages to the next cycle, and `--source all` composing both providers in one loop.

## Boundaries & Constraints

**Always:** AD-10 holds — `core` imports nothing; `orch` reaches `core` only; the CLI wires adapters. `SchedulerPort` (`src/core/ports/SchedulerPort.ts:1`) is implemented, not changed. 8.1's isolation rule survives verbatim: one account's failure is logged with its name and never aborts the others; a failed account never reads as a successful one. Every failure is one actionable line (AD-4). The per-cycle window stays the epic's bounds: Gmail's INBOX, the account's configured folders for M365. The 8.2 run lock guards every cycle.

**Never:** no signal handlers (9.2 owns graceful shutdown — a SIGINT kills the process and state stays consistent by construction). No rate-limit backoff beyond the AC's single 30s retry (9.1 owns exponential backoff). No change to `--backfill`, `--sync-categories` or `--auth`. No metrics beyond the AC's log lines (Epic 10). Out of bounds: `src/orch/fetch.ts`, `classify.ts`, `classification-run.ts`'s existing behaviour, `src/core/**`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FIRST_CYCLE | No stored state | Gmail: profile read, whole INBOX walked; m365: unbounded walk; everything classified, written, recorded; state created | N/A |
| HAPPY_CYCLE | Stored cursors | Window fetched → classified → written → recorded → state advanced; per-cycle line with counters, duration, next run at | N/A |
| CLASSIFY_ERROR | One message's classification rejects | Error logged naming account and message; `errors` rises; that account's state is **not** advanced, so the next cycle re-fetches the window — completed messages dedupe via the 8.2 store, the failed one retries | Isolated; other accounts continue |
| FETCH_ERROR | An account's fetch fails | Log, back off 30s, retry that account's cycle once; second failure: log, account counts failed, state held, loop continues | Isolated per account |
| WRITE_ERROR | `writeLabels` fails | Same 30s backoff-and-retry-once treatment as a fetch error | Isolated per account |
| RECORD_ERROR | The 8.2 store `record` fails after a landed write | Error counted (the write stands, per 8.2); state held so the message is retried next cycle | Isolated |
| ACCOUNT_ISOLATION | Two accounts, the first's cycle fails | The second still runs to completion; the failed one is named in the cycle line | Exit-code reflects failures |
| CONCURRENT_CYCLE | A second invocation starts while a cycle holds the lock | 8.2's "another email-classify run is in progress" line; exits 1. Between cycles the lock is free, so `--backfill` may interleave | N/A |
| SOURCE_ALL | `--source all`, same-named m365 and gmail accounts | Both providers' selected accounts run per cycle, each with its own namespaced cursor file | N/A |
| INTERVAL_BOUNDS | `--interval 0`, `1441`, `abc`, or absent | Absent takes the default 15; invalid values are rejected at dispatch with one line naming the flag and its bounds (1–1440) | `kind: "error"`, exit 1 |
| LOOP | Any run | Cycles repeat at the interval forever; each logs its start and its next-run time; Ctrl+C kills the process — no handler, nothing half-committed | N/A |

## Decisions (human, 2026-10-10)

- **`--cron` always loops.** No `--interval` flag means the default 15 minutes. The temporary fetch-only pass retires and `--cron` becomes the recurring mode the epic describes; a one-shot pass stays `--backfill`'s job, and the help text's "nothing is written back" promise is rewritten.
- **Re-queue is the held cursor.** An account whose cycle ends with any error keeps its cursor untouched, so the next cycle re-fetches the window: completed messages return `alreadyDone` through the 8.2 store (no model call, no write) and the failed ones genuinely retry. No in-process re-queue queue — it would not survive a restart and would duplicate the store's job.

</frozen-after-approval>

## Code Map

- `src/orch/incremental.ts:226` — `fetchIncremental`: the per-account incremental fetch. **The knot:** it commits state itself — Gmail's history id + cycle start at `recordGmailState` (`:118`), m365's `writeLastRunTimestamp` at `:281` — and returns counts only, discarding the DTOs (deferred-work.md:82 named this: 8.3 needs the DTO egress seam). Its failure rule is already right: a failed fetch never advances state.
- `src/orch/classification-run.ts:23` — `ClassificationRecordStore` (the 8.2 seam: `labelsFor`/`record`); the per-message classify→write→record flow in `runAccount` (`:101`) is the unit the cron cycle reuses; `runBackfillAccounts` (`:202`) shows the isolation and counter shapes to mirror.
- `src/cli/commands/cron.ts:105` — `runCron`, the temporary command to replace: single-source `plans` Record (`:126`), per-source `stateOptions` (`:164`), the 8.2 lock (`:194`), and the doc comment promising nothing is written back.
- `src/core/ports/SchedulerPort.ts:1` — `runOnce(fn)` / `runInterval(fn, intervalMs): Promise<AbortController>` — declared, never implemented; `src/adapters/scheduler/` holds only `.gitkeep`. Deferred-work.md:41 notes its shape is unpinned: 8.3 is its first consumer.
- `src/adapters/lock/runLock.ts:79` — `acquireRunLock` / `releaseRunLock`: taken per cycle so `--backfill` can run between cycles.
- `src/cli/dispatch.ts:88` — `resolveCron`: rejects `source === "all"` (`:98-101`); the validators `parseSince`/`parseBatchSize` (`:68-82`) are the pattern for a new `parseInterval` (default 15, min 1, max 1440); the `CliCommand` union is at `:20-26`.
- `src/cli/main.ts:40-53` — the option table and the `--cron` help text (both rewritten); `CliHandlers.runCron` at `:18`, the call site at `:78-80`.
- `src/adapters/config/stateFile.ts` — `writeLastRunTimestamp`/`writeLastHistoryId`: the per-provider namespaced cursors (EC2) that make `--source all` safe for same-named accounts.
- Tests: `tests/cli/cron.test.ts:42-53` (recordingFetch), `:106-112` (temp configDir), `:132` (injected `now`), `:623` (EC2 same-name cursors), `:675` (the 8.2 lock) — the idioms to extend; the scheduler and cron-cycle suites are new.
- **Out of bounds:** `src/orch/fetch.ts`, `classify.ts`, `classification-run.ts`'s existing flow, `src/core/**`, signal handling, exponential backoff, metrics.

## Tasks & Acceptance

**Execution:**
- [x] `src/orch/incremental.ts` — the DTO egress seam: a way to run the per-account incremental fetch that hands the caller the fetched messages **and the pending state** (Gmail's history id, the cycle start) without committing, keeping today's committing behaviour available where it is still wanted.
- [x] `src/orch/cron-cycle.ts` — one cycle across every selected account, sequentially and isolated: egress fetch → classify → write → record (8.1's stages, 8.2's store) → commit state only when the account finished clean → 30s backoff and a single retry per account on a fetch or write failure → the counters, with injected `now` and `sleep` seams.
- [x] `src/adapters/scheduler/scheduler.ts` — `runOnce` / `runInterval` implementing `SchedulerPort` over `setInterval`, returning the `AbortController`; re-exported from `src/adapters/index.ts`.
- [x] `src/cli/commands/cron.ts` — drive `cron-cycle` per interval through the scheduler, acquire and release the 8.2 lock around each cycle, compose `--source all` from both provider plans, and log the per-cycle line (start, fetched, labeled, skipped, already done, errors, duration, next run at); rewrite the command's doc comment and the help text.
- [x] `src/cli/dispatch.ts` + `src/cli/main.ts` — `--interval <minutes>` validated like `parseBatchSize` with bounds 1–1440 and default 15; accept `--source all` for `--cron`; thread the interval through `CliHandlers.runCron`.
- [x] `tests/orch/cron-cycle.test.ts` — pin every row of the I/O matrix with store/port/sleep doubles.
- [x] `tests/adapters/scheduler/scheduler.test.ts` — the interval fires and the controller stops it.
- [x] `tests/cli/cron.test.ts` + `tests/cli/dispatch.test.ts` — looped cycles via a scheduler double, per-cycle lines, `--source all`, interval validation, and the per-cycle lock.

**Acceptance Criteria:**
- Given `--cron --source <m365|gmail|all> --account <name|all>`, when the loop runs, then every selected account is fetched incrementally, classified, written and state-updated each cycle, and the loop sleeps the interval (default 15, bounds 1–1440) between cycles.
- Given a classification error for one message, when the cycle ends, then the error is logged naming the account and message, that account's state is not advanced, and the message is retried on the account's next cycle while completed messages are not re-classified.
- Given a fetch or write error for one account, when the run backs off 30 seconds and retries that account's cycle once, then a second failure is logged and the loop proceeds to the next interval with the account's state held.
- Given a second invocation while a cycle holds the lock, when it starts, then it exits 1 with the 8.2 line and fetches nothing.
- Given `--source all`, when the loop runs, then both providers' selected accounts run per cycle, each with its own namespaced cursor.
- Given any cycle, when it runs, then one line reports its start, fetched, labeled, skipped, already done, errors, duration, and the next cycle's time.

## Implementation Notes

- **As-built shape.** `src/orch/cron-cycle.ts` owns the cycle: per provider, per account —
  `fetchIncrementalAccount` (the egress: messages + pending state, nothing committed) → Gmail's
  `ensureCategories` → `classifyMessages` (the per-message unit `runAccount` also runs) → commit
  the pending state only when the account finished clean. A retryable failure (fetch, write, or the
  Gmail label ensure) earns exactly one `RETRY_BACKOFF_MS = 30_000` wait and one full retry; a
  second failure names the account in the cycle line and holds its cursor.
- **The extraction in `classification-run.ts`.** `runAccount`'s per-message flow moved verbatim into
  the exported `classifyMessages(options): { progress, writeFailed }` — the backfill calls it after
  its own fetch, so no behaviour changed there (every 8.1/8.2 test still passes); the cron cycle
  reuses it against the egress. `writeFailed` is `writeLabels`' success aggregated, the cycle's
  single-retry trigger. `logProgress` is now exported for the cycle's per-account lines.
- **The Gmail cache knot.** A Gmail `writeLabels` refuses an uncached account (the 8.1 CLI suite
  proved it: the label cache is populated only by `ensureCategories`). One-shot backfill documents
  the `--sync-categories` prerequisite; a daemon cannot, because with the held-cursor re-queue an
  account that never syncs wedges forever — every write failing while its cursor never advances.
  The cycle therefore calls `ensureCategories(accountId, taxonomy)` before writing, once per Gmail
  account per cycle (one labels GET, self-healing across taxonomy edits; m365's write needs no
  cache and gets no call — 7.1's). A failure is the retryable kind. The spec's matrix has no row
  for it — this was settled during implementation, not by the spec.
- **The loop's stop seam.** `CronRuntime.scheduler` is injectable so a test never starts a real
  interval: the real `createScheduler().runInterval` resolves immediately and the interval runs on
  its own, so `runCron` awaits it harmlessly in production while an injected double can run N ticks
  to completion first. `runCron` returns 0 once the loop starts; only the first cycle can give the
  command a non-zero exit (a lock held, a rejected selection, a taxonomic or model failure).
- **Verification history.** The first implementation subagent (prescribed dispatch) was killed at
  its 15-minute cap while investigating the Gmail cache knot; its tree was 90% coherent and was
  finished inline: the loop await (`runInterval`), the `ensureCategories` integration above, the
  per-source hint reporting (a hint now prints as it is discovered, since under `--source all` a
  provider with nothing selected must say so while the other still runs), one Gmail labels-list
  fixture per affected test, and a stray half-written assertion in `FETCH_ERROR`.
- **Loop-1 review patches (2026-10-11).** The three review layers ran against the stage: five
  findings routed **patch** (restored the malformed-settings cron tests, pinned the Gmail
  ensureCategories failure paths, made the Gmail partial-commit line truthful, gated --interval 1440
  in a test, restored trailing newlines), three routed **defer** (rows below), the rest triaged false.
- **Verification (2026-10-11).** `mise exec node@20 -- bun run test` — 38 files, 577 tests passed;
  `bun run lint` — exit 0 (AD-10 core guard included); `bun run build` — exit 0. Every I/O-matrix
  row has a passing test (the lock rows run under 8.2's `CONCURRENT_RUN`/`PER_CYCLE_LOCK` tags).
## Spec Change Log

### Loop 1 (2026-10-11) — no loopback; patches applied in place

- **Trigger:** the three review layers' findings (see the Review Triage Log). Five routed **patch**
  and were applied and verified in place; three routed **defer** into deferred-work.md; none reached
  intent_gap or bad_spec, so no code was reverted and no frozen line moved.
- **Amended (non-frozen only):** the Implementation Notes above and the Review Triage Log below.
- **Known-bad state avoided:** a Gmail partial-commit failure logging a "cursor held" line whose
  promised re-fetch cannot happen (the history id already advanced), and the malformed-settings
  stderr lines shipping with no test at all — the exact lines a user's broken YAML depends on.

## Review Triage Log

Loop 1 (2026-10-11) — layers: blind-hunter, edge-case-hunter, verification-gap. The five patches above were applied and verified; the three deferred entries are in deferred-work.md.

- **medium — the committing incremental orchestrator is production-dead** (blind-hunter 16).
  Verified: `fetchIncremental` has no production caller left — the cron command runs `runCronCycle`,
  every remaining caller is its own suite — so its commit logic (Gmail history id first, then the
  cycle start) is a second source of truth duplicating `cron-cycle.ts`'s. **defer**: the fix is
  deleting a Story-5.2/5.4 module and converting its 814-line suite to the egress API, beyond a
  patch and best owned by the imminent Epic-11 DI rewrite (recorded in deferred-work.md).
- **low — the malformed-settings stderr lines are unpinned** (verification-gap 1). Pre-verified: the
  layer ran the greps and `git show HEAD:tests/cli/cron.test.ts` — both tests asserting the
  per-account line were deleted in this diff with no replacement. **patch** — restored two adapted
  tests: one malformed plus one valid account (the per-account line, the valid cycle still runs),
  and all-malformed (exit 1, the per-account line, no setup hint, no requests).
- **low — the Gmail `ensureCategories` failure paths are unpinned** (verification-gap 2).
  Pre-verified: the only cron-cycle occurrence was a no-op stub and every CLI fixture answers 200.
  **patch** — a recordable `portDouble` hook plus `ENSURE_RETRY_RECOVERS` (one rejection → one 30s
  wait → the retry commits) and `ENSURE_ERROR_TWICE` (failures/failedAccounts, nothing written,
  nothing committed).
- **low — the Gmail partial-commit log is misleading** (edge-case-hunter 4). Real: the history id
  may have landed when the cycle start's write fails, and the shared catch read as "cursor held" —
  promising a re-fetch that cannot happen. **patch** — the commit is split: a failed history-id
  write logs plainly (nothing landed), and a failed cycle-start write after it says "its history id
  committed but the cycle start did not — this window will not repeat next cycle".
- **low — `--interval`'s maximum never reaches a scheduler assertion** (blind-hunter 24). Real gap,
  trivial coverage. **patch** — `INTERVAL_MAX` pins `intervalMinutes: 1440` → `[86_400_000]`.
- **low — six files lost their trailing newline** (blind-hunter 27). **patch** — restored;
  `incremental.ts`'s was caught at my own diff read.
- **low — interval drift after a slow cycle** (edge-case-hunter 5, kind: claim). Real: `setInterval`
  fires on schedule and a still-running cycle is skipped, so after a slower-than-interval cycle the
  gap to the next start is shorter than the promised interval. Rejected as a patch — the adapter's
  comment scopes drift correction to Epic 9/10 deliberately. **defer** (recorded).
- **maybe-false — a later tick's rejection vanishes silently** (edge-case-hunter 1). Structural: the
  CLI's `runCycle` has no catch around `runCronCycle`, and the scheduler settles rejections without
  logging, so a throw in any later cycle would leave the loop alive with no output. Unreachable
  through the shipped seams (every store, write and commit path is caught internally; the wiring
  fault is hoisted and unreachable from the CLI). **defer** — a wired seam that throws under
  Epic-11's DI rewrite would settle it; a one-line catch is the remedy when it does.
- **false — spec front matter contradicts the board** (blind-hunter 2). The board reads
  `in-progress` because step-03 set it; the spec reads `in-review` because this step set it; the
  board moves on at step-05. A transient state the workflow defines, not a defect.
- **false — `--account <name> --source all` with the name on one provider** (blind-hunter 3). The
  code runs the provider that has the account and prints the other's hint — correct, and pinned by
  `SOURCE_ALL_PARTIAL`.
- **false — the matrix gained three behaviours only in the notes** (blind-hunter 4). The frozen
  matrix is human-owned; the shipped extensions are documented in the code comments and the notes,
  and adding rows is a renegotiation, not a change I may make.
- **false — the SIGINT-during-first-cycle consequence is unstated** (blind-hunter 5). The lock a
  killed cycle leaves holds a now-dead pid; the dead-pid steal covers exactly that (tested at
  `STALE_LOCK`, documented in the lock adapter).
- **false — the help text's exit-code promise is half-true for `--cron`** (blind-hunter 6). The
  `--cron` option text promises nothing about exit codes ("loops until stopped") and the State
  footer explains the per-cycle lock; no overpromise exists.
- **false — `--source` help advertises a value `--backfill` rejects** (blind-hunter 7). The text
  scopes `all` to "one `--cron` loop" explicitly; a `--backfill --source all` run is still rejected
  with its own line (the 8.1 decision, unchanged).
- **false — validator whitespace inconsistency** (blind-hunter 8). Verified: `parseBatchSize` also
  tests `raw.trim()` — the two validators agree.
- **false — the interval guard is skipped for `--auth`/`--sync-categories`** (blind-hunter 9).
  Verified in `resolveCliCommand`: the guard precedes all routing, so a non-cron combination is
  rejected with "--interval requires --cron."
- **false — a required union field's blast radius is untracked** (blind-hunter 10). The cron arm's
  consumers are exactly the two files updated; any other consumer fails `tsc` at build time.
- **false — a failed fetch's crossed-the-wire messages never reach the `fetched` count**
  (blind-hunter 11). That is 8.1's established `PARTIAL_FOLDER` accounting, pinned by its test: a
  partly-failed account's messages stay out of `fetched` so they are never read as work done.
- **false — a record failure skips the retry and goes unreported** (blind-hunter 12). Verified
  against the frozen matrix: `RECORD_ERROR` specifies no retry, the error counted, the cursor held —
  the code is the row verbatim, and the cycle line still prints the `errors` count.
- **false — the retry re-issues writes whose labels already landed** (blind-hunter 13). Verified: a
  retry re-runs `classifyMessages`, whose pre-classify store lookup answers `alreadyDone` for every
  recorded message; only unrecorded (failed-record) messages are re-written — 8.2's intended retry,
  add-only.
- **false — the pre-read `cycleStart` loses a slow state read's gap** (blind-hunter 17). The
  ordering is identical to the baseline (`CYCLE_START` pins it) and the window's upper bound is
  unbounded, so nothing arriving during the read can be lost; a redundant re-read only ever costs an
  `alreadyDone`.
- **false — `GmailRawFetch`'s failed arm serves no caller** (blind-hunter 18). It is consumed by the
  committing `fetchIncremental`, whose `fetched` accounting keeps the old behaviour (a partly failed
  Gmail walk's messages counted, the account failed).
- **false — `NO_SELF_OVERLAP` cannot fail for its named reason** (blind-hunter 20). Settled by
  mutation: breaking the in-flight guard makes the test fail; restored.
- **false — an injected port that fires immediately would double-cycle** (blind-hunter 21). A
  hypothetical alternative port implementation is not a defect in the shipped adapter; the
  runOnce-first contract is pinned at the CLI level.
- **false — positional request assertions couple tests to wire counts** (blind-hunter 23). That is
  the suite's established idiom; no bad outcome asserted.
- **false — the `DURATION` case encodes the clock's call count** (blind-hunter 25). Test-internal;
  the behaviour asserted (the duration between two reads) is correct.
- **false — the commit-failure flavour's CLI line is unpinned** (blind-hunter 26). The CLI's failure
  line is source-agnostic (`failures`/`failedAccounts` straight from the cycle result) and is pinned
  by the fetch flavour.
- **false — `createScheduler` re-export is dead** (blind-hunter 28). `cron.ts` calls it in
  production.
- **false — a hung cycle wedges the lock forever** (edge-case-hunter 2). Verified: every wire call
  carries `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` (`gmailWire.ts:187`, `M365Adapter.ts:428`), so a
  hung connection settles and the in-flight flag clears.
- **false — a programmatic `intervalMinutes: 0` clamps to a 1ms hammer loop** (edge-case-hunter 3).
  Unreachable through the shipped entry point: dispatch validates 1–1440 and is the only route into
  `runCron`.
- **false — single-provider listing-throw behavior** (verification-gap "Other"). The exit code and
  the per-provider error line are unchanged from the baseline shape.
- **false — a stale doc comment on the empty-selection branch** (verification-gap "Other").
  Cosmetic; the comment's spirit still matches the code.
- **low — a blank-identity message in a held window re-classifies every cycle** (blind-hunter 14).
  Real but the rare trade 8.2's code comment already documents ("classified again on the next run,
  which is the safe half of that trade"); the remedy (a per-cycle warning surface) is added
  complexity unlikely to be met in everyday use. Rejected.
- **low — `walkAccount` duplicates `fetch.ts`'s folder walk** (blind-hunter 15). Real duplication,
  but the frozen boundaries forbid the alternative (widening `fetch.ts` to return DTOs), the copies
  share their constants (`DEFAULT_FOLDERS`/`DEFAULT_BATCH_SIZE` imported from `fetch.js`), and the
  egress suite pins the parity. Rejected.
- **low — a third copy of `errorLine`** (blind-hunter 19). The same class Story 8.1's triage already
  accepted as cosmetic; the fix would add a new `orch` export. Rejected.

## Design Notes

- **Why the cycle is a new orchestration module, not an extension of `runCron`.** The CLI keeps its wiring role; the cycle's behaviour (fetch → classify → write → record → commit) is pure and testable without booting a command, mirroring how 8.1 kept the loop out of the CLI.
- **Why state commits only on a clean account cycle.** The store makes a re-fetched window cheap (`alreadyDone` costs neither a model call nor a write), so holding the cursor is the smallest re-queue mechanism that also survives restarts — an in-process queue would not.
- **Why the lock is per cycle.** Held for the loop's lifetime it would block every `--backfill` while the cron runs — defeating 8.2's own feature. Per cycle it serialises writers exactly as 8.2 intended and leaves the gaps free.
- **Why the scheduler adapter is minimal.** `runInterval` over `setInterval` with an `AbortController` is all the AC needs; 9.2's graceful shutdown gets the controller for free.

## Verification

**Commands:**
- `mise exec node@20 -- bun run test` — expected: all suites pass, including the new cron-cycle, scheduler and CLI loop tests.
- `mise exec node@20 -- bun run lint` — expected: exit 0, the AD-10 core guard included.
- `mise exec node@20 -- bun run build` — expected: exit 0.