---
title: 'Story 9.2: Graceful Shutdown (Multi-Account)'
type: 'feature'
created: '2026-10-11'
status: 'done'
route: 'dispatch'
baseline_commit: '8c548ad33541883a079583d72f1b8ac8fe4410d0'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A SIGINT/SIGTERM during `--cron` or `--backfill` kills the process mid-work. Nothing in `src/cli` handles signals (only `process.exitCode` is ever set), the scheduler's `AbortController` is created and discarded (`cron.ts:373`), and Story 9.1's backoff wait is a bare `setTimeout` promise — so Ctrl-C during a ladder wait cannot be cut short. After a restart the operator cannot tell whether cursors were persisted.

**Approach:** Register SIGINT/SIGTERM once in the CLI entry, hand the running command an abort signal, and stop at an account/message boundary instead of mid-write: the loop finishes the message it is on, starts nothing further, flushes logs, and exits 0. A bounded deadline keeps a signal that lands inside a backoff wait from having to outlast the ladder.

## Boundaries & Constraints

**Always:** Signal wiring lives in `src/cli` (hexagonal direction: core ← adapters/orch ← cli). Cancellation is observed at loop boundaries, never mid-write. A cursor is advanced only for work that actually committed. A handled shutdown exits 0.

**Never:** No `process.exit()` in the middle of a write. No change to Story 9.1's two-mechanism split (flat ~30s retry vs the 429 ladder). No new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| SIGINT_IDLE | SIGINT while the cron loop waits between cycles | Interval cleared, flush runs, exit 0, no further cycle | N/A |
| SIGINT_MID_MESSAGE | SIGINT after a message's classify/write began | That message completes (write + record); the next message and account are skipped; exit 0 | N/A |
| SIGINT_IN_BACKOFF | SIGINT while an adapter waits a 9.1 ladder rung | Wait ends early; that account is abandoned, not retried; exit 0 | N/A |
| STATE_PARTIAL | Accounts finished before the signal | Their state files keep the committed cursors; the in-flight account keeps its previous cursor and re-fetches | N/A |
| SECOND_SIGNAL | A second SIGINT arrives before exit | Stop immediately and exit 0 (see Decisions) | N/A |

## Decisions (human, 2026-10-11)

- **Best-effort finish.** The message already underway runs to completion even if that overruns 5s; the 5s bar governs the shutdown step itself, not the in-flight message.
- **Commands:** `--cron` and `--backfill` register the handler; `--auth` and `--sync-categories` do not.
- **Log flush:** `LogPort` gains an optional `flush?(): Promise<void>`, awaited on shutdown; the console adapter no-ops it and Epic 10's file logger implements it.
- **Exit code:** always 0 for a handled shutdown, including one forced by a second signal or the deadline.

</frozen-after-approval>

## Code Map

- `src/cli/index.ts:16-26` — the entry point (`process.exitCode = await runCli(...)`); the one place to register SIGINT/SIGTERM.
- `src/cli/main.ts:18-31,60-88` — `CliHandlers` / `defaultHandlers` / command routing; the seam a signal-aware runner passes through.
- `src/cli/commands/cron.ts:285,364,373` — creates the scheduler and discards the `AbortController`; store it, and wrap `runtime.sleep` (declared `:60-67`, spread into the adapters at `:126-172`) so a backoff is interruptible.
- `src/cli/commands/backfill.ts` — `BackfillRuntime.sleep`, threaded directly into both adapters.
- `src/core/ports/SchedulerPort.ts:1-4` — `runInterval(fn, intervalMs): Promise<AbortController>`.
- `src/adapters/scheduler/scheduler.ts:16-39` — the `setInterval` adapter; `abort` clears the timer but does not await an in-flight `fn`.
- `src/orch/cron-cycle.ts:197,215,254,264` — account-loop head, the flat 30s backoff `sleep`, and the per-account cursor commits.
- `src/orch/classification-run.ts:128,196,242,245` — message-loop head (the per-message boundary), `runAccount`, and the `runBackfillAccounts` account loop.
- `src/adapters/config/stateFile.ts:130,197,215,235` — `readAccountState`, the lock-free read-merge-write, and `writeLastRunTimestamp` / `writeLastHistoryId`.
- `src/core/ports/LogPort.ts:6-11` — `debug/info/warn/error` only; no flush today.
- `tests/cli/cron.test.ts:114-133,941-949` — the `loopScheduler(ticks)` `SchedulerPort` doubles to extend.
- `tests/orch/cron-cycle.test.ts:188-192` — the `sleepRecorder()` idiom, mirrored in the m365/gmail throttle suites.
- `tests/adapters/scheduler/scheduler.test.ts:21-56` — `vi.useFakeTimers()` + `controller.abort()`.
- `tests/cli/main.test.ts` — already spies `process.exit`; where signal wiring is asserted.

## Tasks & Acceptance

**Execution:**
- [ ] `src/cli/shutdown.ts` (new) — a small coordinator: register SIGINT/SIGTERM on an injectable target, expose an `AbortSignal`, expose an exit seam, and expose a `beginShutdown()` the runner calls once its work has drained. **The deadline is armed by `beginShutdown()`, never by the signal handler** — the 5s budget covers the shutdown step, so a message that overruns 5s is never cut mid-write.
- [ ] `src/cli/index.ts` — create the coordinator and pass it into `runCli`; attach signals only when the entry actually runs; pin `process.exitCode = 0` once a signal has been handled.
- [ ] `src/cli/main.ts` — thread the coordinator through `CliHandlers` to the cron and backfill handlers, calling `attach()` on those two routes only.
- [ ] `src/cli/commands/cron.ts` — keep the `AbortController` from `runInterval`; wrap the sleep seam as `abortableSleep(signal, runtime.sleep)` (raced, so an injected recorder still sees the wait); on drain call `beginShutdown()`, abort the controller, await the in-flight cycle, close the store and flush — on **every** exit path, not only the abort one.
- [ ] `src/cli/commands/backfill.ts` — the same `abortableSleep` wrap, the same signal threading into `runBackfillAccounts`, and a flush on the drain path; return 0 when the run was aborted.
- [ ] `src/orch/cron-cycle.ts` — accept an `AbortSignal`; check it at the account-loop head and before the flat retry wait; and **hold the cursor when the run was aborted**, so a partially-processed account re-fetches instead of committing past the messages it never saw. A wait that throws while *not* aborted must keep escaping (the CLI's wiring-fault contract).
- [ ] `src/orch/classification-run.ts` — accept the signal; check it at the account-loop head and the message-loop head.
- [ ] `src/core/ports/LogPort.ts` — add an optional `flush?(): Promise<void>`; the console adapter no-ops it and Epic 10's file logger implements it.
- [ ] `tests/` — cover every I/O-matrix row with a tagged test: `SIGINT_IDLE` (an abort while a cycle is genuinely in flight, asserting the drain completes before the flush), `SIGINT_MID_MESSAGE`, `SIGINT_IN_BACKOFF` (driven through a command, so an adapter's own wait is interrupted), `STATE_PARTIAL` (an aborted account commits **no** cursor) and `SECOND_SIGNAL`. Also cover the routing seam in `tests/cli/main.test.ts` (`--cron`/`--backfill` attach and pass the signal; `--auth`/`--sync-categories` never attach) and the `--backfill` drain/flush path in `tests/cli/backfill.test.ts`.

**Acceptance Criteria:**
- Given the cron loop is waiting between cycles, when SIGINT arrives, then the interval is cleared, logs flush, and the process exits 0 without starting another cycle.
- Given a message is being classified, when SIGINT arrives, then that message finishes and no further message or account is started.
- Given a message is mid-classify when the signal arrives, when that message then completes, then its account commits **no** cursor, so the next run re-fetches the unprocessed tail.
- Given the in-flight work has drained, when the shutdown step runs past 5s, then the process is forced out at 0 — and a message that overruns 5s is never cut mid-write.
- Given an adapter is waiting a 9.1 ladder rung, when SIGINT arrives, then the wait ends early and the process exits 0.
- Given accounts completed before the signal, when the process exits, then their state files still hold the committed cursors.
- Given any exit path, when the command returns, then the store is closed and the logs are flushed.

## Implementation Notes

- **As-built shape.** `src/cli/shutdown.ts` (new) owns the one `AbortController`, registers SIGINT/SIGTERM
  on an injectable target when a command opts in via `attach()`, and arms a 5s deadline on the first
  signal; the second signal (or the deadline) `exit(0)`s. `abortableSleep(signal, base)` races the
  injected base sleep against the abort — the seam is raced, never replaced, so a recorder still sees
  the wait — and rejects with the CLI-local `ShutdownError`. `waitForAbort` is the cron loop's stop flag.
- **Threading.** `index.ts` creates the coordinator only for a real entry-point run and pins
  `process.exitCode = 0` once a signal has been seen; `main.ts` passes it to `createProgram`, which
  attaches the listeners *only* on the backfill and cron routes (the Decisions' Commands rule) and
  hands `{ signal }` to those two handlers.
- **Orch stays core-only.** Neither orch module imports the CLI: an interrupted wait arrives as a
  throw, so both modules read `options.signal.aborted` rather than an error type. `cron-cycle.ts`
  checks at the account-loop head, before the flat retry, and around the retry's wait; a wait that
  fails while *not* aborted is rethrown, so the CLI's wiring-fault contract is preserved
  (`CYCLE_FAULT` pins this). `classification-run.ts` checks at the account-loop head and the
  message-loop head, which is the per-message boundary the AC names.
- **The fetch layers abandon without a false fault.** The signal also reaches the two fetch walks —
  `incremental.ts`'s `walkAccount` and the Gmail history calls (the `--cron` path) and
  `classification-run.ts`'s `runAccount` (the `--backfill` path). When a fetch throws with
  `signal.aborted` set, the walk rethrows or breaks instead of calling `logPort.error`, and the
  caller abandons the account rather than counting it failed — so an interrupted 9.1 wait is never
  logged as a per-folder error naming an account that was never at fault. `incremental.ts` is beyond
  the Task list's named files; added per the loop-1 review's medium finding (the fetch catch
  swallowed the abort).
- **Defect found and fixed while verifying.** The first cut of `abortableSleep` declared the `base`
  parameter and never used it, so a wired signal silently dropped the injected sleep. A regression
  the same cut introduced — swallowing *any* sleep fault as a shutdown — would have hidden the
  CLI's `CYCLE_FAULT` path; the catch now rethrows unless the signal is actually aborted.
- **Verification (2026-10-11).** 41 files / 622 tests green; lint exit 0 (six warnings, all
  pre-existing classes); build exit 0. Every I/O-matrix row is pinned by a tagged test:
  `SIGINT_IDLE` (cli/cron), `SIGINT_MID_MESSAGE` (orch/classification-run), `SIGINT_IN_BACKOFF`
  (orch/cron-cycle + cli/backfill, an adapter wait interrupted through a command + cli/shutdown),
  `STATE_PARTIAL` (orch/cron-cycle), `SECOND_SIGNAL` (cli/shutdown); the routing seam
  (`SIGNAL_ROUTING`, cli/main) and the `--backfill` drain/flush path are covered too.

## Spec Change Log

### Loop 1 (2026-10-11) — bad_spec: non-frozen sections amended, code re-derived

- **Trigger:** the review's `bad_spec` entry — the first cut armed the 5s deadline inside the signal handler, so a message overrunning 5s was `exit(0)`-ed mid-write, contradicting both the Decisions ("the 5s bar governs the shutdown step itself") and the Constraints ("no `process.exit()` in the middle of a write").
- **Also amended, same root (the non-frozen Tasks were silent on each):** the cursor-hold rule on abort, flush and store-close on every exit path, and the coverage the spec claimed but did not have.
- **Known-bad state avoided:** a `--cron` run interrupted mid-message advancing its cursor past messages it never classified (silent mail loss), and an in-flight write killed at the deadline.
- **KEEP:** the coordinator shape (one `AbortController`, injectable target and exit seams), the raced `abortableSleep`, orch reading `signal.aborted` rather than an error type, and `exit(0)` as the handled code.

## Review Triage Log

Loop 1 (2026-10-11) — layers: blind-hunter, edge-case-hunter, verification-gap. One `bad_spec` entry triggered the loopback; the rest were carried as the re-derivation's brief.

- **bad_spec (high) — the 5s deadline is armed at the first signal, so it can `exit(0)` mid-write** (blind-hunter 2, verification-gap other-3). Verified: `src/cli/shutdown.ts:104-113` arms `setTimeout(() => exit(0), deadlineMs)` on the first signal, while the Decisions say the message runs to completion even past 5s and the Constraints forbid a mid-write exit. Root cause is outside the frozen block (the Tasks never said when to arm it), so the frozen intent stands and the code is re-derived. **bad_spec**.
- **high — a mid-message abort still commits the account's cursor** (blind-hunter 1, edge-case-hunter 1+5). Verified at `src/orch/cron-cycle.ts:286`: the hold condition is `progress.errors > 0 || attempt.pending === undefined`, and an aborted-then-broken message loop leaves `errors === 0` and a defined `pending`, so the cycle start commits and the unclassified tail is never re-fetched. Moot under the loopback; amended into the Tasks as the cursor-hold rule.
- **medium — an interrupted wait logs a per-folder error line naming an account that was never at fault** (blind-hunter 4, verification-gap other-2). Real: the fetch catches swallow the rejection and call `logPort.error`. Amended into the Design Notes.
- **medium — interrupted accounts are counted and announced as failures** (blind-hunter 5, verification-gap other-1, edge-case-hunter 4). Real: `result.failures += 1` on abort makes the cycle print "N of M account(s) failed" and `--backfill` return 1. Amended into the Tasks and Design Notes.
- **medium — the `--backfill` shutdown surface has no test at all** (verification-gap 3, pre-verified). Real: `tests/cli/backfill.test.ts` holds no `signal`/`flush`/`abort`. Amended into the `tests/` task.
- **medium — the CLI attach/signal routing seam has no test** (verification-gap 1, blind-hunter 8, pre-verified). Real: `tests/cli/main.test.ts` records options only. Amended into the `tests/` task.
- **medium — `abortableSleep` is never wired through a command into an adapter, so the `SIGINT_IN_BACKOFF` row is pinned only for the flat-retry seam** (verification-gap 4, pre-verified). Real. Amended into the `tests/` task.
- **medium — the `SIGINT_IDLE` test aborts before any tick runs, so the in-flight drain is never observed** (verification-gap 5, blind-hunter 10, pre-verified). Real: the double's `runInterval` never invokes `fn`. Amended into the `tests/` task.
- **medium — the handled-shutdown exit-code pin in `index.ts` is unverified** (verification-gap 2, blind-hunter 9, pre-verified). Real, and `--backfill`'s 0 depends on it. Amended: the backfill command returns  drawn from the signal, and the pin keeps its own check.
- **medium — `LogPort.flush` runs only on the abort path** (blind-hunter 12, edge-case-hunter 3). Real: the happy and fault paths never flush. Amended into the Tasks (flush on every exit path).
- **low — the two `runCron` exits diverge on cleanup** (blind-hunter 11, edge-case-hunter 2). Real: the no-signal path skips `store?.close()` and the flush. Amended into the same task.
- **low — an interrupted cycle still advertises a next cycle** (blind-hunter 6). Real but cosmetic; the re-derivation keeps the line only for a completed cycle. **patch**.
- **low — the raced base wait is never cancelled, so the process can linger until the deadline** (blind-hunter 3). Real; the shutdown-step deadline bounds it. **defer** (recorded).
- **low — no cleanup seam on `ShutdownTarget`, and `ShutdownError`'s message is duplicated as a bare string in the orch test** (blind-hunter 14). Real but developer-only and structural. Rejected: the fix adds surface and the harm is not reachable in everyday use.
- **low — spec bookkeeping (status vs sprint, stale Code Map spans, empty logs)** (blind-hunter 13). Real; fixed by this same amendment. Rejected as a finding (its fix is to edit this spec).
- **carried — `isRateLimitBody` narrowness, and the LADDER_VS_INTERVAL/proxy gaps** (Story 9.1's deferrals). Unchanged by this diff; still deferred.

**Rejected:** the `ShutdownError`-message duplication and the missing listener-cleanup seam (low, structural, no reachable harm); the spec-bookkeeping row (its fix edits this spec).

Loop 2 (2026-10-11) — layers: blind-hunter, edge-case-hunter, verification-gap. No `intent_gap` or `bad_spec`: loop 1's two frozen deviations are fixed. Patches applied below; two entries deferred.

- **medium — exit paths that bypass `finish` skip the store close and the flush** (blind-hunter 1+2, edge-case-hunter 3, verification-gap other-2). Verified: `cron.ts:165,180,291` and `backfill.ts:141` return a bare `1` before `finish` exists, so the AC "any exit path … store is closed and the logs are flushed" does not hold for them. **patch**.
- **medium — the first-cycle abort exit never arms the deadline** (edge-case-hunter 4, high-confidence claim). Verified: `cron.ts:394-396` returns `finish(0)` on `signal?.aborted` without `beginShutdown()`, so a hanging flush there has no 5s bound. **patch**.
- **medium — an unguarded `flush()` can reject `runCli`** (blind-hunter 4). Verified: `finish` awaits `logPort.flush?.()` with no catch; a throwing Epic-10 flush rejects the top-level await in `index.ts:29` → unhandled rejection and exit 1, contradicting "a handled shutdown always exits 0". **patch**.
- **medium — the handled-exit-0 pin is untestable where it lives** (blind-hunter 7, verification-gap 1, pre-verified). Real: `index.ts:32` runs only under `isEntryPoint`, and no test reads `process.exitCode` on a handled path. **patch** — move the pin into `runCli` and pin it.
- **medium — `incremental.ts`'s abort-rethrow has no test** (blind-hunter 8, verification-gap 2, pre-verified). Real: nothing in `tests/orch/incremental.test.ts` references `signal`, and deleting the rethrow restores the spurious per-folder error line the note forbids. **patch** — add the case.
- **medium — the flat-retry warn promises a retry that the signal then cancels** (blind-hunter 6). Verified: the warn at `cron-cycle.ts:233-236` precedes the interruptible wait, and the abandoned account gets no line. **patch**.
- **low — the non-abort exit paths' flush/close is unpinned, Gmail abort paths are untested, and SIGTERM is never fired** (blind-hunter 9,10,11). Real coverage gaps. **patch** — extend the tests.
- **low — trailing newlines missing on `cron.ts` and `cron-cycle.ts`; `runCli`'s doc block not updated for the new parameter** (blind-hunter 13,14). Real, trivial. **patch**.
- **defer — a store-close assertion needs a store seam this change deliberately does not add** (verification-gap 3); nil impact while the process exits immediately and the console flush is a no-op. Recorded in deferred-work.md.
- **carried — `abortableSleep`'s raced base timer is never cleared** (edge-case-hunter 2, verification-gap other-1). Already the loop-1 deferral; unchanged. The reviewers rate it the one item to confirm on a real process.
- **false — the `inFlight` single slot lets an older cycle be cut mid-write** (edge-case-hunter 1). Disproved: `src/adapters/scheduler/scheduler.ts` holds an in-flight guard that skips an overlapping tick, so only one `tick` runs at a time and the slot cannot be overwritten in any real wiring.
- **rejected — no operator-visible line confirming a handled shutdown** (blind-hunter 5). The intent does not ask for one; the problem it names (cursors on restart) is answered by the cursor-hold rule. Low, and it adds user-facing surface.
- **rejected — pre-run phases never observe the signal** (blind-hunter 12). Low: boundary-only cancellation is the frozen design ("cancellation is observed at loop boundaries").

## Design Notes

- **When the deadline starts.** The 5s budget covers the shutdown step, not the message: it is armed once the run has drained (`beginShutdown()`), never from the signal handler — a message may legitimately overrun 5s (the Decisions) and a mid-write `exit(0)` is forbidden.
- **An interrupted run is not a failed one.** An abort holds the account's cursor and stops the loop; it must not be counted in `failures`, printed as an account that failed, or logged as an error naming an account that was never at fault.
- The scheduler's `abort()` clears the timer but does not await an in-flight tick, so a command must both abort the controller *and* set the running loop's own stop flag; the flag is what ends the cycle already in progress.
- Cursors only advance after an account finishes clean (`cron-cycle.ts:254,264`), and `--backfill` writes no cursor at all. "Save cursors for every account being processed" therefore means: leave committed cursors alone and let the in-flight account re-fetch — never invent a cursor for partial work.

## Verification

**Commands:**
- `mise exec node@20 -- bun run test` — expected: all suites pass, including the new shutdown tests.
- `mise exec node@20 -- bun run lint` — expected: exit 0, the AD-10 core guard included.
- `mise exec node@20 -- bun run build` — expected: exit 0.
