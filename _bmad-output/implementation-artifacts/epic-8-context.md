# Epic 8 Context: Backfill & Cron Orchestration

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A user can run a one-shot backfill or a recurring cron loop that exercises all accounts with isolation and resumability. Epic 8 is where the pieces built in Epics 4–7 stop being separate commands and become one product run: fetch messages, classify them against the active taxonomy, and write the resulting labels back to the source mailbox. It also introduces the state that makes a run safe to interrupt and restart — an idempotency store and a process lock — so a killed backfill resumes instead of redoing or double-labelling work.

## Stories

- Story 8.1: Backfill Mode Execution (Multi-Account)
- Story 8.2: Idempotency & Resume (Multi-Account)
- Story 8.3: Cron Mode Loop (Multi-Account)

## Requirements & Constraints

- **One run, three stages.** For each selected account: fetch (FR-6/FR-8) → classify (FR-12) → write labels (FR-13/FR-14). Accounts are processed sequentially and independently: one account's failure is logged and never aborts the others.
- **Add-only write-back.** Labels are only ever added; user-applied labels are never removed. A message already carrying every predicted label costs no write call. Re-runs must be safe.
- **`LabelSet` contract.** Write-back consumes the classifier's validated `{ labels: string[] }` naming taxonomy labels. An empty set is valid and means no write.
- **Per-account isolation.** A fetch, classification, or write failure for one account is logged with the account name; other accounts continue. A failed account must never read as a successful one.
- **Typed, actionable errors (AD-4).** Every failure surfaces as one actionable line naming the account — never a stack trace or a raw provider payload. Exit codes reflect whether any account failed.
- **Progress reporting.** A backfill logs per-account progress (counts of processed, labeled, skipped and errored messages) rather than one line at the end.
- **Fetch bounds.** A backfill accepts a lower time bound and a batch size; defaults are 50 with a provider ceiling of 100.
- **The cron window is INBOX-only** for Gmail and the account's configured folders for M365.

## Technical Decisions

- **Hexagonal dependency direction (AD-10).** `src/core` imports nothing; `src/adapters` and `src/orch` reach `core` only; `src/cli` wires all. Orchestration therefore depends on narrow structural seams (e.g. an object with just the one port method it needs), not on concrete adapters.
- **AD-8 MailPort seam.** `MailPort.writeLabels(accountId, messageId, labels)` is implemented by the per-provider adapters. Provider wire specifics stay inside the adapters; orchestration never sees them.
- **Composed, not monolithic orchestration.** Each stage already has its own pure module (`orch/fetch`, `orch/incremental`, `orch/sync`, `orch/classify`). A run loop composes them; it does not reimplement them.
- **Seams-object idiom.** Options interfaces carrying the work plus injected ports/loggers are the repo's established shape (`FetchAllMessagesOptions`, `SyncCategoriesOptions`, `ClassifyOptions`).
- **Injected clock and filesystem roots.** Anything reading the wall clock, the home directory, or the network is injected so tests never touch real state (`now`, `configDir`, `fetchFn`).
- **Idempotency store shape.** A single shared SQLite database at `~/.config/email-classify/idempotency.db`, partitioned by the `accountId` baked into each key — not per-account files. The key is `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))`.
- **Process-level file lock.** A run acquires a lock covering the idempotency store and the per-account state files; a concurrent invocation exits 1 with a clear "another email-classify run is in progress" error.
- **Per-account state** lives in a shared state file, carrying each account's last-run timestamp and (for Gmail) a history cursor.

## Cross-Story Dependencies

- **Upstream:** Epic 4 (taxonomy + per-account label/category sync), Epic 5 (fetch and incremental fetch), Epic 6 (the classification unit and `ModelPort`), Epic 7 (`MailPort.writeLabels` for both providers).
- **Within the epic:** 8.1 establishes the run loop; 8.2 adds the idempotency store, resume and the process lock onto it; 8.3 wraps 8.1's stages in an interval loop and adds per-cycle state updates.
- **Downstream:** Epic 9 (rate-limit backoff and graceful shutdown) and Epic 10 (structured logging, metrics and cost) attach to the loop this epic builds; Epic 11 replaces the temporary CLI wiring with a real configuration and DI container.
