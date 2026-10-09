# Epic 5 Context: Message Fetching (Backfill & Incremental)

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic delivers the message-fetching layer: full historical backfill across every enabled account, plus efficient incremental polling per account for cron mode. It is the entry point of the pipeline — every downstream stage (classification, label write-back) consumes the canonical messages it produces, so its correctness, pagination handling, and per-account isolation determine whether backfill can safely walk 8k+ messages per mailbox without dropping or duplicating work. Success means each account yields complete, provider-agnostic message DTOs ordered/paginated correctly, with incremental fetches resuming from persisted per-account state and never silently missing messages when a Gmail history window has expired.

## Stories

- Story 5.1: M365 Backfill Message Fetch (Multi-Account)
- Story 5.2: M365 Incremental Message Fetch (Cron, Multi-Account)
- Story 5.3: Gmail Backfill Message Fetch (Multi-Account)
- Story 5.4: Gmail Incremental Message Fetch (Cron, Multi-Account, with history-expiry fallback)

## Requirements & Constraints

- **Backfill completeness.** M365 backfill walks configured folders (default Inbox) via `GET /me/messages` with `$top=100` and `@odata.nextLink` pagination until exhausted per account. Gmail backfill walks the configured label set (default INBOX) via `users.messages.list` (`labelIds=INBOX`, `maxResults=100`, page tokens), then hydrates details with `users.messages.batchGet`.
- **Incremental efficiency.** M365 cron fetches only messages with `$filter=receivedDateTime ge {lastRunTimestamp}`, ascending by received time. Gmail cron uses `users.history.list` with the account's `startHistoryId` and `labelId=INBOX`, returning only messages newer than the stored history ID.
- **Never silently miss messages.** Gmail answers `users.history.list` with HTTP 404 when a stored `startHistoryId` has aged out (cron idle >~7 days): the cycle warns naming the account, then falls back to an INBOX list bounded on the wire by `q=after:<epoch of lastRunTimestamp>`; a purged message's 404 hydration is a per-message skip with a warn naming the id, never the account's failure.
- **Per-account state.** Cursor files are per provider: `~/.config/email-classify/state/m365-<accountName>.json` and `gmail-<accountName>.json` (decisions EC2/2-A, 2026-10-09; the legacy single `<accountName>.json` is read back for m365 only and never written again). M365 persists `lastRunTimestamp` (ISO 8601); a Gmail cycle persists both `lastHistoryId` and the cycle-start `lastRunTimestamp`, recording only after a successful cycle.
- **Account isolation.** One account's fetch failure must not abort other accounts; errors are caught and logged per account.
- **Batching.** Fetch batch size is configurable per account, default 50, max 100 (per provider API limits). Folder/label selection is per account.
- **Account selection.** `--account <name|all>` selects accounts, defaulting to `all`; accounts are processed sequentially.
- **State integrity.** Per-account state files use restrictive permissions (0700 directories / 0600 files) and are guarded by a process-level lock so concurrent invocations cannot corrupt them.

## Technical Decisions

- Fetching is a `MailPort` capability (`fetchMessages(opts: FetchOpts): Promise<MessageDTO[]>`). `FetchOpts` carries `source`, `accountId`, `since?`, `batchSize?`, `folder?`; each adapter owns its own pagination, rate-limit, and delta/history logic.
- The shared `MessageDTO` is the single canonical shape across adapters; fetch results must carry `accountId`, `internetMessageId`, provider-native labels (`categories` for M365, `labelIds` for Gmail), and the timestamp field. Adapters map provider payloads at their boundary; no provider types leak upward.
- One adapter instance is created per enabled account by the DI container. M365 fetch lives in `adapters/m365/M365Adapter.ts`, Gmail in `adapters/gmail/GmailAdapter.ts`; both depend only on core ports (dependency direction is enforced by tsconfig + lint).
- Account settings (folders/labels, batchSize, enabled) come from per-account YAML, loaded and frozen at startup — never read ad hoc during a fetch.
- IDs are `string` (RFC 5322 `internetMessageId`), dates ISO 8601 UTC. Errors use the shared `{ code, message, context? }` shape, are caught at the adapter boundary, logged via the log port, and re-thrown typed.
- Token access (per-account auth/refresh) is available to adapters via the token port; token contents must never be logged.

## UX & Interaction Patterns

- Epic 5's fetch layer reports one line per account (fetched count, counted failures); the every-100-messages progress contract (processed / labeled / skipped / errors) belongs to Epic 8's backfill/cron command layer (UX-DR2, FR15) and is not Epic 5 debt.
- Operator-facing failures use clear messages naming the offending account; history-expiry produces a warning-level log rather than a silent skip or crash.

## Cross-Story Dependencies

- **Upstream:** Epic 1 ports/DTOs (`MailPort`, `FetchOpts`, `MessageDTO`) and Epic 2/3 per-account auth must exist before fetch works. Epic 4 taxonomy/category sync runs at startup and its label mapping is needed later for write-back, not for fetch itself.
- **Downstream:** Epic 6 consumes the fetched `MessageDTO`s; Epic 7 writes labels back; Epic 8 orchestration drives both backfill and cron fetch and owns resume; Epic 9 supplies per-account rate-limit backoff and graceful shutdown (fetch must surface 429s to it); Epic 10 logs fetch progress/metrics.
- **In-epic:** Stories 5.2 and 5.4 define the per-account state file shape shared with Epic 8's resume behavior; 5.3/5.4 share Gmail pagination and mapping conventions.
- **Deferred:** M365 delta-query incremental is explicitly out of scope for v1 (filter-based fetch only); Gmail history-expiry fallback *is* implemented here.
