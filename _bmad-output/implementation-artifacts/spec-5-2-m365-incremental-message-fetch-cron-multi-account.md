---
title: 'Story 5.2: M365 Incremental Message Fetch (Cron, Multi-Account)'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: '95adeb4000a6e061282ef553886ceed9a8a351d4'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-1-m365-backfill-message-fetch-multi-account.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 5.1 fetches the whole mailbox every time. Nothing persists per-account fetch progress, so a recurring run would re-walk 8k+ messages per account and never fetch "only what is new".

**Approach:** teach `M365Adapter.fetchMessages` the `$filter=receivedDateTime ge {since}` query, persist each account's `lastRunTimestamp` at `~/.config/email-classify/state/<accountName>.json`, and add an incremental orchestrator that reads that timestamp, fetches only newer messages, and records the per-account cycle start time after a successful cycle. A temporary `--cron --source m365 --account <name|all>` flag exposes it; Story 8.3 later loops it.

## Boundaries & Constraints

**Always:**
- When `opts.since` is set, the first-page URL gains `$filter=receivedDateTime ge <ISO 8601>` and `$orderby=receivedDateTime asc`; when it is absent the URL is exactly Story 5.1's. Later pages reuse `@odata.nextLink` verbatim (it carries the query). `$top`, `$select`, folder scoping, path encoding, `AbortSignal.timeout`, and typed `LIST_MESSAGES_FAILED` errors are unchanged.
- `FetchOpts.since` stays a `Date` (`src/core/dto/FetchOpts.ts`); the state file stores an ISO-8601 string; the conversion happens once, at the orchestrator boundary.
- State file `<configDir>/state/<accountName>.json` holds `lastRunTimestamp`, `lastProcessedMessageId`, and `lastHistoryId` — all optional, each validated when present (ISO-8601 for the two timestamps). Writes read-merge-write, so one provider's key never clobbers another's and an absent key stays absent. Directory `0700`, file `0600`, `chmod` on rewrite — mirroring `KeychainTokenStore.writeFallbackFile` (`src/adapters/token/KeychainTokenStore.ts:171-181`).
- On success the persisted timestamp is the per-account cycle **start** instant, captured before its fetch.
- Accounts are processed sequentially and isolated exactly as Story 5.1: a failure is logged with its `accountId` and never aborts the others. On any failure that account's stored state is left untouched.
- No state file → no `$filter` (the first run behaves like a backfill, then persists) — a mailbox is never silently skipped.
- AD-10 holds: `core` gains nothing; `orch` imports only `core`; the incremental orchestrator takes injected read/write seams; relative imports carry `.js`.

**Never:**
- No Gmail fetch, no `--source gmail`/`all` (Story 5.4).
- No classification, label write-back, message persistence, resume cursor, or per-message idempotency (Epics 6/7/8).
- No cron scheduler, loop, timer, or daemon (Story 8.3); no retry/backoff/rate-limit handling (Epic 9); no `--since`/`--batch-size` flags (Story 8.1).
- No change to the backfill path: `fetchAllMessages` without per-account `since` issues no `$filter`.
- No 401-driven token refresh (already deferred to the fetch consumer in `deferred-work.md`).
- No new `core` port and no provider types leaking upward.
- No process-level state lock (human decision, 2026-10-09): no concurrent runner exists until Story 8.3 owns one, so the lock is deferred to Epic 8/9 and recorded as a `ponytail:` ceiling.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY | stored `lastRunTimestamp` T, one folder, one page | one GET carries `$filter=receivedDateTime ge <T>` with `$top`/`$select`; DTOs returned; state rewritten to the cycle start (> T) | N/A |
| NO_STATE | no state file | no `$filter` in the URL (full fetch); on success the file is created | N/A |
| FILTER_ENCODING | `since` = `2026-10-09T00:00:00.000Z` | the filter value is percent-encoded in the query, not interpolated raw | N/A |
| ORDERBY | any incremental fetch | `$orderby=receivedDateTime asc` present on the first page | N/A |
| FOLDER | `folder: "Inbox"` + `since` | `GET /me/mailFolders/Inbox/messages` carrying the `$filter` | N/A |
| MULTI_ACCOUNT | two accounts with stored T1/T2 | each GET uses its own filter; each state is updated independently | N/A |
| ACCOUNT_FAILURE | account A page 500, account B healthy | A's state unchanged, B's updated; the run reports one failure | typed error logged with `accountId`; exit non-zero |
| NO_NEW_MESSAGES | filter matches nothing | `value: []` → 0 fetched; state still advances to the cycle start | N/A |
| STATE_INVALID | malformed JSON or a present key that is not an ISO-8601 string | that account fails; the file is not overwritten | typed `StateFileError` naming account + path |
| STATE_MERGE | the file already holds a Gmail-owned key | writing `lastRunTimestamp` preserves the other keys (read-merge-write) | N/A |
| STATE_WRITE_FAILS | fetch succeeds, write rejects | the fetch result is still returned; that account counts as failed | typed `StateFileError` logged with `accountId` |
| CLI_PROVIDER | `--cron --source gmail` | one line naming Story 5.4 | exit 1; no request |
| NO_ACCOUNTS | `--cron`, `--account all`, none enabled | setup hint | exit 1 |

</frozen-after-approval>

## Code Map

- `src/adapters/m365/M365Adapter.ts:16-22,86-98,148-183` — `MESSAGE_SELECT`, `clampBatchSize`, `messagesUrl` (add `$filter`/`$orderby` here), and `fetchMessages` (unchanged beyond the URL). Reuse `send`/`getRequest`/`readNextLink`/`readJsonObject` and `M365AdapterError` verbatim; do not touch `ensureCategories`/`listCategoryNames`.
- `src/core/dto/FetchOpts.ts:1-7` — `since?: Date` already exists; add nothing.
- `src/orch/fetch.ts:6-34,37-83` — `MessageFetchTarget`, `FetchAccount` (add `since?: Date`), `fetchAllMessages` (forward `account.since` into `FetchOpts`). Keep the folder walk, de-duplication, defaults, and per-account isolation exactly as they are.
- `src/adapters/config/stateFile.ts` (new) — the one state-file machine: `accountStateDir`, `stateFileDisplayPath`, `readAccountState` (three optional keys), `writeLastRunTimestamp` (read-merge-write), `StateFileError`; mirror `perAccountSettings.ts` for `configDir`/display-path/typed-error conventions and `KeychainTokenStore.ts:171-181` for perms.
- `src/adapters/config/perAccountSettings.ts:80-82` and `src/adapters/config/configFile.ts:8,12-15` — the `DEFAULT_CONFIG_DIR` / injectable-`configDir` / display-path pattern to copy (`DEFAULT_CONFIG_DIR` is module-private in both; do not export it or widen `core`).
- `src/orch/incremental.ts` (new) — `fetchIncremental(options)` composing state and `fetchAllMessages`: per account read the stored timestamp (`readAccountState(...).lastRunTimestamp`), capture the cycle start, fetch with `since`, and on success record it via `writeLastRunTimestamp`. Depends only on `core` ports/DTOs and injected seams.
- `src/cli/commands/backfill.ts:24-54,56-107` — the temporary-command pattern (`BackfillRuntime`, `noAccountsHint`, `planFor`, enable-listing, counted failures, exit code) to mirror for the incremental command.
- `src/cli/dispatch.ts:1-70` and `src/cli/index.ts:6-57` — pure routing, `--account` default `"all"`, mutual-exclusion guards, `.option(...)` wiring; `tests/cli/dispatch.test.ts` pins them.
- `tests/adapters/m365/m365-adapter.test.ts:64-72` — the stdlib-only `scriptedFetch` harness (recorded requests, scripted responses) for the URL cases; `tests/orch/fetch.test.ts:18-45` and `tests/cli/backfill.test.ts:19-100` are the orch/CLI patterns.
- Do not touch: `src/adapters/gmail/**`, `src/adapters/config/taxonomy.ts`, `src/adapters/config/configFile.ts`, `src/core/**`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/m365/M365Adapter.ts` — add `$filter=receivedDateTime ge <encoded ISO>` and `$orderby=receivedDateTime asc` to `messagesUrl` when `opts.since` is set — the whole adapter-side change.
- [x] `src/adapters/config/stateFile.ts` (new) — `readAccountState(accountName, {configDir})` (missing → `{}`; malformed → typed error) and `writeLastRunTimestamp(accountName, date, {configDir})` (read-merge-write over the three optional keys; 0700 dir, 0600 file, chmod) — one place owns the shared state format.
- [x] `src/orch/fetch.ts` — add `since?: Date` to `FetchAccount` and forward it into `FetchOpts.since` — the backfill path stays filterless.
- [x] `src/orch/incremental.ts` (new) — `fetchIncremental({accounts, mailPort, logPort, readAccountState, writeLastRunTimestamp, now?})` reading the stored timestamp, capturing the cycle start, and recording success — keeps state out of `fetch.ts` and `core`.
- [x] `src/cli/commands/cron.ts` (new) + `src/cli/dispatch.ts` + `src/cli/index.ts` — the temporary `--cron --source m365 --account <name|all>` command: list enabled accounts, run `fetchIncremental`, print counts and a counted failure line, set the exit code, reject non-m365 sources.
- [x] `src/adapters/index.ts` — export the new state module's symbols.
- [x] `tests/adapters/m365/m365-adapter.test.ts` — HAPPY, NO_STATE, FILTER_ENCODING, ORDERBY, FOLDER rows, asserting the recorded URL.
- [x] `tests/adapters/config/state-file.test.ts` (new) — round-trip, missing file, malformed JSON/non-ISO, the read-merge-write preservation case, and the 0600/0700 modes.
- [x] `tests/orch/fetch.test.ts` — the `since` pass-through (present/absent).
- [x] `tests/orch/incremental.test.ts` (new) — MULTI_ACCOUNT, ACCOUNT_FAILURE, NO_NEW_MESSAGES, STATE_MERGE, STATE_WRITE_FAILS.
- [x] `tests/cli/dispatch.test.ts` + `tests/cli/cron.test.ts` — CLI_PROVIDER, NO_ACCOUNTS, routing, and the `--account` default.
- [x] Run `mise exec node@20 -- bun run build`, `bun run lint`, `bun run test` — all exit 0.

**Acceptance Criteria:**
- Given an account whose state holds `lastRunTimestamp` T, when the incremental fetch runs, then every request for that account carries `$filter=receivedDateTime ge <T>` and the state is rewritten to the cycle start only after the cycle succeeds.
- Given two enabled m365 accounts with different stored timestamps, when the incremental fetch runs, then each account is fetched sequentially with its own `$filter` and one account's failure leaves the other's messages and state intact.
- Given no state file for an account, when the incremental fetch runs, then no `$filter` is sent and the successful cycle creates the state file.
- Given a failed fetch for an account, when the run finishes, then that account's stored `lastRunTimestamp` is byte-for-byte unchanged and the exit code is 1.
- Given `--cron --source gmail`, when the command runs, then one line names Story 5.4 and no request is attempted.

## Implementation Notes

- **2026-10-09 — Story 5.2 implementation.** `M365Adapter.messagesUrl` appends `$filter=receivedDateTime ge <percent-encoded ISO>` + `$orderby=receivedDateTime asc` only when `opts.since` is set (absent `since` leaves Story 5.1's URL byte-identical); `src/adapters/config/stateFile.ts` owns `state/<accountName>.json` with three optional keys and read-merge-write at 0700/0600; `FetchAccount.since` is forwarded by `fetchAllMessages`; `src/orch/incremental.ts` reads the stored bound, captures the per-account cycle start, and records it only after a successful cycle; the temporary `--cron --source m365 --account <name|all>` command wires it with per-account isolation and a counted failure line.
- Verification (re-run independently at review): `bun run build`, `bun run lint` and `bun run test` green — 21 files / 265 tests, including `tsc` typecheck. All 13 I/O-matrix rows are covered by passing tests (HAPPY/NO_STATE/FILTER_ENCODING/ORDERBY/FOLDER/MULTI_ACCOUNT/ACCOUNT_FAILURE/NO_NEW_MESSAGES/STATE_INVALID/STATE_MERGE/STATE_WRITE_FAILS/CLI_PROVIDER/NO_ACCOUNTS).
- **No live Microsoft Graph call was made** — no credentials in this environment, so the request shape, filter and pagination are verified against the mocked `FetchLike` only.
- Spec-wording inconsistency left for review: the frozen Boundaries say state keys are "validated when present (ISO-8601 for the two timestamps)" but only `lastRunTimestamp` is a timestamp; `lastProcessedMessageId`/`lastHistoryId` are opaque IDs. The code validates `lastRunTimestamp` as ISO-8601 UTC and the two id keys as non-empty strings — the only reading consistent with Gmail's numeric history IDs.
- Known follow-ups for step-04: `src/cli/commands/cron.ts` duplicates `backfill.ts`'s `noAccountsHint`/`planFor` wiring (mirror-per-Code-Map, but a shared helper may be warranted); the filter operator space is passed literally (`receivedDateTime ge <encoded>`), which WHATWG `fetch` normalizes to `%20`.
- **2026-10-09 — review patches applied.** Six triage patches landed: the state-file timestamp check now also rejects regex-shaped-but-impossible instants (`Date.parse` NaN → `STATE_INVALID`); `readAccountState`/`writeLastRunTimestamp` assert `ACCOUNT_NAME_PATTERN` before joining (no path escape); the `state/` directory is `chmod 0700`ed on write (pre-existing loose dirs); `fetchIncremental` threads an optional `source` (default `m365`) for Story 5.4 reuse; `resolveCron` guards `--backfill` so the mutual exclusion is order-independent; and `tests/orch/incremental.test.ts` adds an advancing-clock test pinning the pre-fetch cycle-start sample plus a source-threading test. The stale `bmad-build-auto-result-*.md` artifact was deleted. Re-verification after patches: `bun run build`, `bun run lint`, `bun run test` green — 21 files / 270 tests.

## Spec Change Log

## Review Triage Log

| # | Source | Location | Verdict | Evidence and route |
|---|--------|----------|---------|--------------------|
| 1 | blind-hunter 1 | `_bmad-output/.../bmad-build-auto-result-2026-10-09T01-30-56Z.md` | `low` | **patch.** A stale `blocked` artifact from the earlier build-auto HALT rode into the staged diff (untracked files are included) and contradicts the green story. Fix: delete the stray file. |
| 2 | blind-hunter 2 | `_bmad-output/party-mode/memories/installed/.memlog.md` | `low` | **defer.** A pre-existing party-mode session memory unrelated to Story 5.2, untracked and not gitignored. Not caused by this story. |
| 3 | blind-hunter 3 | spec frontmatter `status: in-review` | `false` | The build workflow's own spec vocabulary is `draft\|ready-for-dev\|in-progress\|in-review\|done`; it is independent of `sprint-status.yaml`'s `review`. Step-04 mandates this value. |
| 4 | blind-hunter 4 | `sprint-status.yaml` `5-2…: in-progress` | `false` | The board transition trail (`in-progress` → `review` → `done`) is owned by the build workflow steps, not this diff; no code defect. |
| 5 | blind-hunter 5 + edge-case 1 | `src/adapters/config/stateFile.ts:42,70` | `low` | **patch.** The shape-only ISO regex accepts `2026-99-99T99:99:99Z`; `toPlan` then builds an Invalid `Date` and `M365Adapter`'s `.toISOString()` throws `RangeError`, logged as a per-account failure instead of the typed `STATE_INVALID` the matrix promises. Demonstrated reachable with a hand-edited state file. |
| 6 | blind-hunter 6 + edge-case 2 | `src/adapters/config/stateFile.ts:113-127` | `low` | **reject.** No key outside the three modeled ones exists in v1, and the frozen Boundaries promise preservation only of "one provider's key" (the modeled set). The spread-raw fix adds merge behaviour beyond intent for an unmodeled key. |
| 7 | edge-case 3 | `src/adapters/config/stateFile.ts:141-145` | `low` | **reject.** A crash mid-`writeFile` would leave truncated JSON, but that is rare and the fix (tmp+rename atomic write) is more than a direct correction; `KeychainTokenStore.writeFallbackFile` shares the pattern. |
| 8 | blind-hunter 25 + edge-case 4 | `src/adapters/config/stateFile.ts:130` | `low` | **patch.** `mkdir(..., {mode: 0o700})` applies only on creation, so a pre-existing 0755 `state/` stays loose while the spec claims "Directory 0700". Fix: `chmod` the directory on write and cover it. |
| 9 | edge-case 5 | `src/adapters/config/stateFile.ts:138` | `low` | **reject.** Only reachable if an injected `now` returns an Invalid Date; production defaults to `() => new Date()`, so the program cannot reach it. |
| 10 | blind-hunter 7 + 8 | `src/orch/incremental.ts:63-84`, `fetch.ts:28-31` | `low` | **defer.** The orchestrator returns counts only (no DTO egress) yet advances the stored timestamp, so a first filterless run's messages are not available downstream and are excluded from later `ge` filters. Consumption/DTO delivery belongs to Epics 6/7/8 (the epic intent); recorded as a deferred item. |
| 11 | blind-hunter 9 | `src/adapters/config/stateFile.ts:26-30,69-76` | `false` | The human decision of 2026-10-09 explicitly chose to model all three epic-5 keys (`All 3 keys, merge on write`); `lastProcessedMessageId` is the reserved Epic 8.2 field, not a dead key. |
| 12 | blind-hunter 10 | `src/cli/commands/cron.ts:40-113` vs `backfill.ts:40-107` | `low` | **reject.** The spec's Code Map directed the mirror, and both commands are explicitly temporary (Epic 11 replaces them). The smallest fix is a shared-helper refactor, more than a direct correction; no user/dev harm in everyday use. |
| 13 | blind-hunter 11 | `tests/cli/cron.test.ts` | `low` | **reject.** The listing-failure and invalid-settings branches are copied from the already-tested `backfill.ts` and are not in this story's frozen I/O matrix; adding the tests is non-essential surface. |
| 14 | blind-hunter 12 | `src/adapters/config/stateFile.ts:58-62` | `low` | **reject.** A non-ENOENT read failure (EACCES/EISDIR) is rare and the message still names the account and path; a distinct error code is a design change, not a direct correction. |
| 15 | blind-hunter 13 | `src/adapters/config/stateFile.ts:46-52` | `medium` | **patch.** The public module joins an unvalidated `accountName`, unlike `perAccountSettings.assertAccountName`; a future caller (5.4/Epic 11) could escape the state dir. Fix: apply `ACCOUNT_NAME_PATTERN` before joining. |
| 16 | blind-hunter 14 | `src/orch/incremental.ts:63` | `low` | **patch.** `source: "m365"` is hard-coded, so Story 5.4's Gmail incremental cannot reuse the orchestrator without mis-stamping every DTO. Fix: thread `source` through `FetchIncrementalOptions` as `fetch.ts` does. |
| 17 | blind-hunter 15 | `src/cli/dispatch.ts:50-64` | `low` | **patch.** `resolveCron` omits `--backfill` from its exclusion list and relies on `resolveCliCommand`'s call order; the repo guards this silent-drop class elsewhere. Fix: add the guard. |
| 18 | blind-hunter 16 | spec `## Code Map` spans | `false` | Rejected: the only fix edits this build's spec. |
| 19 | blind-hunter 17 | spec `## Implementation Notes` | `false` | The note says `bun run test` (which is `vitest run && bun run typecheck`) passed; it does not claim `tests/` are type-checked. The stated command is accurate. |
| 20 | blind-hunter 18 | spec `## Implementation Notes` | `false` | The "21 files / 265 tests" number was reproduced on this reviewer's own full run; it is an accurate attestation, not a claim needing a log. |
| 21 | blind-hunter 19 | spec `## Spec Change Log` / `## Review Triage Log` | `false` | Rejected: the fix edits this build's spec; the logs are populated by this very step. |
| 22 | blind-hunter 20 | `src/adapters/m365/M365Adapter.ts:101-102` | `low` | **reject.** WHATWG `fetch` (the production `FetchLike`) percent-encodes the query space during URL parsing, so the wire request is valid; the mock records the pre-normalization string but no user-visible defect. |
| 23 | blind-hunter 21 | spec `## Design Notes` | `false` | Rejected: the only fix edits this build's spec. |
| 24 | blind-hunter 22 | `stateFile.ts` / `incremental.ts` / spec | `low` | **reject.** `IncrementalAccountState` is the minimal structural subset required by AD-10 (orch may not import the adapter type); it is the intended seam, not an accidental third source of truth. |
| 25 | blind-hunter 23 | `src/adapters/index.ts:44-45` | `false` | The repo's barrel is for external consumers while internals import modules directly (as `backfill.ts` does for account settings); the frozen Tasks required the export. Consistent, not unused surface. |
| 26 | blind-hunter 24 | `tests/adapters/m365/m365-adapter.test.ts`, `tests/cli/cron.test.ts` | `low` | **reject.** Two hand-spelled fixtures in different layers; sharing them is test polish with no behavioural defect. |
| 27 | blind-hunter 26 | `src/adapters/config/stateFile.ts` | `low` | **reject.** A schema-version field is speculative for a one-story-old format; no demonstrated harm. |
| 28 | verification-gap 1 | `src/orch/incremental.ts:66` | `low` | **patch (pre-verified gap).** The persisted bound is asserted with a frozen clock, so moving the `now()` sample after the fetch keeps every test green while silently persisting the cycle *end* — the exact "never miss" regression the spec's cycle-start decision exists to prevent. Fix: add an advancing-clock test pinning the pre-fetch sample. |
| 29 | verification-gap 2 | `src/cli/index.ts:41-42` | `low` | **defer (pre-verified gap).** No test boots the commander entry, so the `--cron` branch's `--account` hand-off and exit code are unpinned; the same exposure already exists for `--auth`/`--sync-categories`/`--backfill` and needs an entry-point refactor. Recorded as a deferred item. |

## Design Notes

- **`$filter` on the first page only.** Graph's `@odata.nextLink` already carries the original query, so later pages need nothing; rewriting them would break the verbatim-link rule Story 5.1 pinned.
- **Cycle start, not newest message.** Epic-5 context fixes M365's persisted timestamp to the cycle start instant; a message that arrives mid-cycle is re-fetched next run (idempotent by design) rather than lost — the safe direction for "never silently miss".
- **Missing state = full fetch.** The only reading that cannot drop mail: an absent timestamp means "no lower bound", which is today's backfill, and the file is created on success.
- **A state write failure is a cycle failure.** Messages were returned, but the timestamp did not advance, so the next run repeats the work; surfacing it as a counted per-account failure is louder than a silent re-fetch.
- **ISO ↔ Date at one boundary.** `FetchOpts.since` is a `Date` (`deferred-work.md` flags the split); the orchestrator converts the state's ISO string in and the cycle-start `Date` out, so nothing else handles two representations.
- **No lock, by decision.** The epic-5 process-level lock is deferred to Epic 8/9 (no concurrent runner exists yet); the state writer carries a `ponytail:` comment naming the concurrent-write ceiling and the upgrade path (a lock file around a cycle).
- **One shared file, merge on write.** M365 and Gmail share `state/<accountName>.json`; the writer preserves keys it does not own, so Story 5.4 adding `lastHistoryId` cannot drop M365's `lastRunTimestamp`.

## Verification

**Commands:**
- `mise exec node@20 -- bun run build` — expected: exit 0.
- `mise exec node@20 -- bun run lint` — expected: exit 0 (AD-10 and the stdlib-only `tests/adapters/**` rule both apply).
- `mise exec node@20 -- bun run test` — expected: exit 0, every I/O-matrix row covered.
- `grep -rn "googleapis\|microsoft-graph-client" src tests` — expected: no matches.

**Manual checks:**
- `HOME=$(mktemp -d) node dist/cli/index.js --cron --source m365 --account all` — expected: the no-enabled-accounts hint, exit 1, and no file written under that home.
- `HOME=$(mktemp -d) node dist/cli/index.js --cron --source gmail` — expected: the Story 5.4 line, exit 1, no request.
- No live Microsoft Graph call is possible here (no credentials); say so in the implementation notes rather than implying the request shape was verified against the service.
