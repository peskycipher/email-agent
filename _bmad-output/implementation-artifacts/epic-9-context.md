# Epic 9 Context: Resilience (Rate Limits & Graceful Shutdown)

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

The system survives the two things that normally break an unattended email tool: provider rate limits and interrupts. When an account hits HTTP 429 (M365) or 429/`rateLimitExceeded` (Gmail) mid-fetch or mid-write, it slows down instead of failing — backing off automatically so an 8000+ message backfill completes with no human watching (the primary success metric validates exactly this). And when the process receives SIGINT/SIGTERM, it stops cleanly rather than dying mid-write: it finishes the message it is on, persists each account's cursor, clears its logs, and exits 0 — so a restart continues from consistent state instead of redoing or mislabeled work.

## Stories

- Story 9.1: Rate Limit Handling (Multi-Account)
- Story 9.2: Graceful Shutdown (Multi-Account)

## Requirements & Constraints

- **Rate-limit backoff, per account.** On a 429 (`rateLimitExceeded` on Gmail): use the provider's `Retry-After` header (seconds) when present; otherwise fall back to exponential backoff — 2s, 4s, 8s, 16s, 32s, capped at 60s. Retry the same batch up to 5 times before giving up on it, always scoped to the one account that was throttled.
- **Backoff is isolated.** Accounts run sequentially in plan order, so one account's backoff does delay the accounts after it in that plan; what is guaranteed — and what the reviews pinned — is isolation: one account's backoff or ladder give-up never aborts, skips or mis-accounts another, and waits are tracked per account.
- **Backoff is visible.** Every backoff event is logged with the account name, provider, and wait time — no silent sleeping.
- **Success bar.** A backfill of 8000+ messages per account completes without manual intervention under typical Graph/Gmail limits (validated by a primary success metric).
- **Interrupts must be silent and bounded.** A signal arriving while an account is in a backoff wait ends that wait early and abandons the account (holding its cursor — nothing is invented for partial work), without logging a per-folder error naming it; the 5-second budget governs the shutdown step, not the message already in flight — best-effort finish is the Decisions' call, and a mid-write exit is forbidden.
- **Two distinct retry mechanisms coexist.** The cron loop's generic fetch/write failure path (single flat ~30s backoff, one retry, next account continues) is separate from epic 9's 429-specific exponential backoff with five retries. Do not collapse one into the other: 429s get the exponential ladder; other failures keep their flat retry.

## Technical Decisions

- **Provider-specific throttling stays inside the adapters.** Under the hexagonal split, each per-account `MailPort` adapter owns its provider's wire specifics (pagination, deltas, rate limits). 429 detection, `Retry-After` parsing, and the wait ladder therefore live in the provider adapter layer — orchestration composes, it does not re-know provider error shapes.
- **Shutdown is a CLI-side concern around the scheduler.** The scheduler port exposes a cancellable run-interval, and the CLI layer is where signal handling is implemented — the orchestration flows must be reachable in a way that a signal handler can finish-and-save rather than hard-abort.
- **Persisted cursor state is the shutdown contract.** Each account's state file (last-run timestamp, plus a history cursor for Gmail) is what "state consistent on restart" means. Committed cursors are left alone; an account caught mid-flight is left without a new cursor so its window re-fetches — never committed past the messages it never saw.
- **Everything testable must be injectable.** Wall-clock sleeps (backoff waits) and time-based logic follow the repo's established seam idiom — injected clocks/sleep functions so tests never actually wait 2–60 seconds and signal handling is exercised deterministically.
- **Idempotent writes make shutdown safe.** Already-labeled messages cost no re-write (add-only write-back plus the idempotency store); this is what lets the shutdown contract be "save cursors, exit" rather than "undo in-flight work."
- **Dependency direction unchanged.** Core depends on nothing; adapters and orchestration reach core only; CLI wires all. Backoff and shutdown code obeys the same layering and the same injected-ports composition.

## Cross-Story Dependencies

- **Upstream:** Epic 5 delivered the per-account cursors (`lastRunTimestamp`, `lastHistoryId`) that shutdown must persist; Epic 8 built the backfill and cron run loops, the idempotency store, the add-only write-back and the flat-error retry that 429 handling sits alongside; Epic 1 defined the log port whose flush the shutdown path depends on.
- **Within the epic:** 9.1 adds the 429 backoff layer; 9.2 must interact with it — a signal arriving while an account is in a backoff wait cuts that wait short and abandons the account, still bounded by the shutdown step's 5-second budget rather than waiting out the ladder.
- **Deferred from Epic 8:** interval drift — after a cycle slower than the interval, the scheduler fires early instead of honouring the between-cycle gap. This is resolvable here (or with the observability work that follows) in the scheduler adapter's drift handling.
- **Downstream:** Epic 10 (structured logging, metrics, cost summaries) attaches observability to the waits and shutdown paths this epic touches (backoff events must arrive in the structured log stream; log flush on shutdown must be complete once file logging is real).
