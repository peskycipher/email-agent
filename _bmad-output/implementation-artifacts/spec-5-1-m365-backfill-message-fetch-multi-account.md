---
title: 'Story 5.1: M365 Backfill Message Fetch (Multi-Account)'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: 'cefa9c3ea1891b9a4e8c6c2a5de9da2a90ee6329'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing in the repo can read a mailbox. `M365Adapter` implements only `ensureCategories`, so an account's mail is unreachable — and every downstream stage (Epic 6 classification, Epic 7 write-back, Epic 8 orchestration) consumes `MessageDTO`s that nothing produces yet.

**Approach:** Add `M365Adapter.fetchMessages(opts: FetchOpts)` — walk `GET /me/messages` (folder-scoped when `opts.folder` is set) with `$top`, `$select` and `@odata.nextLink` until exhausted, and map every Graph message to the canonical `MessageDTO` in a new, total `messageMapper` module. Add `src/orch/fetch.ts`, a sequential per-account orchestrator that walks each account's configured folders with per-account isolation, mirroring Story 4.2's `syncCategories` loop. Reachability is the temporary `--backfill` command recorded in Boundaries.

## Boundaries & Constraints

**Always:**
- `fetchMessages(opts: FetchOpts): Promise<MessageDTO[]>` — the `MailPort` signature verbatim, so `M365Adapter` conforms to two of that port's three methods (`writeLabels` is Epic 7's). `ensureCategories` keeps working unchanged.
- Request shape per page: `https://graph.microsoft.com/v1.0/me/messages` when `opts.folder` is unset, otherwise `https://graph.microsoft.com/v1.0/me/mailFolders/{folder}/messages`; `$top` = `opts.batchSize` clamped to 1..100, falling back to 50 when unset; `$select=id,internetMessageId,subject,bodyPreview,receivedDateTime,categories,isRead,from`; `Authorization: Bearer <token>` from Story 2.1's `getAccessToken(accountId)` seam; every request carries `AbortSignal.timeout(30_000)` (reuse the existing private `send`).
- `$select` adds `from` to the acceptance criteria's list, because `MessageDTO.senderEmail`/`senderName` are required and the AC's list cannot populate them (decision, 2026-10-09). **`isRead` (human decision, 2026-10-09):** Graph's `isRead` is selected and mapped onto a new optional `MessageDTO.isRead?: boolean` — the core contract is extended additively, never reinterpreted, and nothing that consumes `MessageDTO` today changes.
- Pagination follows `@odata.nextLink` until it is absent, accumulating one page at a time, in Graph's order. A page whose `value` is not an array is an error, never "no messages" — the same rule `listCategoryNames` applies. A failure on any page throws and returns no partial array: a truncated backfill must not look like a finished one.
- Mapping lives in `src/adapters/m365/messageMapper.ts` and is total: `id`, `internetMessageId`, `subject`, `bodyPreview`, `receivedDateTime` (ISO 8601 string), `categories` → `existingLabels`, `from.emailAddress.address`/`.name` → `senderEmail`/`senderName`, `isRead` → `isRead`, `source: "m365"`, `accountId`. A missing or non-string field degrades to `""` and a missing `categories` to `[]`; it never throws and never drops a message.
- Orchestration lives in `src/orch/fetch.ts`: accounts are processed sequentially, each account's folders in order, each folder through its own `fetchMessages` call; one account's failure (auth, non-2xx, network) is logged with its `accountId` and never aborts the others; the result reports total fetched messages and failure count. Defaults (`folders` → `["Inbox"]`, `batchSize` → 50) live in exactly one place, this module.
- Per-account configuration: the m365 settings schema gains **optional** `folders` (a non-empty array of non-empty strings) and `batchSize` (integer 1..100). They must stay optional — `tests/adapters/m365/account-settings.test.ts:39` asserts `toEqual` on a parsed settings object, so a zod `.default()` would break Story 2.1's suite.
- Errors are typed at the adapter boundary: `M365AdapterErrorCode` gains `LIST_MESSAGES_FAILED`; every error names the account and the HTTP status where there is one, and never carries Graph's payload or the thrown cause.
- AD-10: `core` untouched except as the `isRead` decision records; adapters import only `core`; `orch` imports only `core` ports/DTOs; `cli` wires all. Relative imports carry explicit `.js` extensions.
- **Temporary CLI surface (human decision, 2026-10-09):** `--backfill --source <m365> --account <name|all>` — `--source` defaults to `m365`; `gmail`/`all` are rejected with one line naming the story that owns them; `--account` defaults to `all`; `--backfill` cannot be combined with `--auth` or `--sync-categories`; the exit code is non-zero when any account failed.

**Never:**
- No writes to the mailbox: GET requests only. Nothing is deleted, moved, marked read, or labelled here.
- No incremental fetch: no `$filter`, no `since`, no `lastRunTimestamp`, no state file (`~/.config/email-classify/state/**`) — Story 5.2 owns all of it.
- No resume, cursor, or per-message idempotency key (Story 8.2), no progress logging every 100 messages (8.1).
- No retry, backoff, or rate-limit handling (Epic 9): a 429 is a typed per-account failure.
- No classification and no label write-back (Epics 6/7): fetched DTOs are counted and logged, never persisted.
- No Gmail fetch (Story 5.3) and no `googleapis` or `@microsoft/microsoft-graph-client` import anywhere in `src/` or `tests/`.
- No DI container, `main.ts`, `ConfigLoader` or startup wiring (Epic 11); no `--since` or `--batch-size` flags (8.1).
- No `.strict()` on the m365 settings schema and no change to `ensureCategories` — the epic-4 retrospective already carries the config-key guard as its own action item.

**Spec size (human decision, 2026-10-09):** kept full at ≈3.8k tokens (≈2.4k words) rather than split. Story 5.1 is one user-facing goal, the scope standard forbids splitting cross-layer details of a single goal, and the 16-row matrix is this story's test enumeration.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY | one account, one page with two messages | two `MessageDTO`s; one GET carrying `$top=50`, the `$select` list, the Bearer header and an `AbortSignal` | N/A |
| PAGED | three pages linked by `@odata.nextLink` | every page's messages, in order; one GET per page; the second request uses the nextLink URL verbatim | N/A |
| BATCH_SIZE | `batchSize` 100 / 250 / 0 | `$top=100` / clamped to 100 / clamped to 1 | N/A |
| DEFAULT_BATCH | `batchSize` unset | `$top=50` | N/A |
| FOLDER | `folder: "Inbox"` | `GET /me/mailFolders/Inbox/messages` | N/A |
| MAPPING | an entry with `categories`, `from`, `isRead` | DTO with `internetMessageId`, `subject`, `bodyPreview`, ISO `receivedDateTime`, `existingLabels`, `senderEmail`/`senderName`, `isRead`, `source: "m365"`, `accountId` | N/A |
| MISSING_FIELDS | an entry missing subject, bodyPreview, categories and from | DTO with `""` / `[]` in those fields; nothing throws | N/A |
| AUTH | the token seam throws for one account. | that account is reported and skipped; the others still fetch | logged with `accountId` (AD-4 line) and counted as a failure |
| API_ERROR | 403 on the first page | no messages returned for that account | typed `LIST_MESSAGES_FAILED` naming account and status; never the raw body |
| MID_PAGE_ERROR | page 1 succeeds, page 2 answers 500 | no partial array reaches the orchestrator | typed error; the account counts as failed |
| MALFORMED | 200 whose body has no `value` array | no messages | typed error, never an empty result |
| THROTTLED | 429 on a page | that account fails | typed error; no retry (Epic 9) |
| UNAUTHORIZED | 401 on the first page | forceRefresh once via `getAccessToken(accountId, { forceRefresh: true })` and replay the request; if it still 401s, `LIST_MESSAGES_FAILED` | typed error after the single replay; 401 on later pages is not retried because nextLink URLs are not safe to replay |
| MULTI_ACCOUNT | two accounts, the first fails | the second is fetched in full; the run reports one failure | counted failure line naming the account; exit code reflects it |
| MULTI_FOLDER | one account configured with `[Inbox, Archive]` | two sequential fetches for that account; totals summed | a failure in one folder does not stop the other folders or accounts |
| NO_ACCOUNTS | `--account all` with no enabled m365 account | setup hint | exit 1 |
| CLI_SOURCE | `--backfill --source gmail` | one line naming Story 5.3 | exit 1; no fetch attempted |

</frozen-after-approval>

## Code Map

- `src/adapters/m365/M365Adapter.ts:82-185` — the class to extend. Reuse its private `send` (typed error, `AbortSignal.timeout`, status), `readJsonObject`, `readNextLink`, `getRequest`, `authorizationHeader` and `M365AdapterDeps { fetchFn, getAccessToken }` exactly as they are; `ensureCategories` and `listCategoryNames` must not change behaviour. `readNextLink` already returns `undefined` for an absent/empty link, so the page walk is `while (url !== undefined)`.
- `src/adapters/m365/M365AuthAdapter.ts:19-24` — `FetchLike`/`FetchResponseLike`, and `getAccessToken(accountName, { forceRefresh? })`. Do not modify (Story 4.2 already widened `body` to optional).
- `src/core/ports/MailPort.ts` — the `fetchMessages` signature to satisfy verbatim; `src/core/dto/FetchOpts.ts` (`source`, `accountId`, `since?`, `batchSize?`, `folder?`); `src/core/dto/MessageDTO.ts` (all fields required but `raw`).
- `src/adapters/m365/accountSettings.ts:18-25` — `accountSettingsSchema` to extend additively; `tests/adapters/m365/account-settings.test.ts:39` pins the parsed shape with `toEqual`, which is why the new fields are optional and the defaults live elsewhere.
- `src/orch/sync.ts` — the orchestrator pattern to mirror, not to change: a minimal target interface, sequential loop, per-account `try/catch`, `errorLine`, failure count, `LogPort` calls carrying `accountId`.
- `src/cli/commands/sync-categories.ts` — the temporary-command pattern: `runX({ account, runtime? })` with an injectable runtime seam (`configDir`, `taxonomyPath`, `fetchFn`), `errorLine`, `createConsoleLogPort`, per-provider counted failure lines.
- `src/cli/dispatch.ts` + `src/cli/index.ts` — pure routing (`resolveCliCommand`), the `--account` default to `"all"`, and the mutual-exclusion guards; `tests/cli/dispatch.test.ts` pins them.
- `tests/adapters/m365/m365-adapter.test.ts:1-45` — the stdlib-only `fetch` mock harness (recorded requests, scripted responses) to copy for the new fetch tests; `tests/orch/sync.test.ts` and `tests/cli/sync-categories.test.ts` are the orch/CLI patterns.
- Do not touch: `src/adapters/config/**`, the taxonomy, `src/adapters/gmail/**`, and `src/core/**` except the recorded optional `MessageDTO.isRead` addition.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/m365/messageMapper.ts` (new) — export `mapGraphMessage(entry: unknown, accountId: string): MessageDTO` reading the selected Graph fields defensively (string helper, `categories` → `existingLabels`, `from.emailAddress` → senders, `isRead` → `isRead`) — the mapping is the one place provider payload shapes are known, so it gets its own focused tests.
- [x] `src/adapters/m365/M365Adapter.ts` — add `fetchMessages` (URL builder honouring `folder` and clamped `batchSize`, `$select`, page walk via `readNextLink`, mapping through `messageMapper`), add `LIST_MESSAGES_FAILED` to `M365AdapterErrorCode`, and update the class doc comment that currently says only `ensureCategories` is implemented.
- [x] `src/adapters/m365/accountSettings.ts` — add optional `folders` (`z.array(z.string().min(1)).min(1).optional()`) and `batchSize` (`z.number().int().min(1).max(100).optional()`) to `accountSettingsSchema` — the AC requires both to be per-account configurable, and optional keeps Story 2.1's suite green.
- [x] `src/orch/fetch.ts` (new) — export `MessageFetchTarget { fetchMessages(opts) }`, `FetchAccount { accountId; folders?; batchSize?; since? }`, `DEFAULT_FOLDERS`, `DEFAULT_BATCH_SIZE` and `fetchAllMessages(options): Promise<{ fetched; failures }>` — the per-account/per-folder loop with isolation, shared with Story 5.3.
- [x] `src/cli/commands/backfill.ts` (new) + `src/cli/dispatch.ts` + `src/cli/index.ts` — the recorded temporary command: list enabled accounts, build the plans, run the orchestrator, print per-account counts and a counted failure line, set the exit code.
- [x] `src/adapters/index.ts` — export `mapGraphMessage`; leave the existing `M365Adapter` exports as they are.
- [x] `tests/adapters/m365/message-mapper.test.ts` (new) — full entry, and the MISSING_FIELDS row.
- [x] `tests/adapters/m365/m365-adapter.test.ts` — add the HAPPY, PAGED, BATCH_SIZE, DEFAULT_BATCH, FOLDER, MAPPING, AUTH, API_ERROR, MID_PAGE_ERROR, MALFORMED and THROTTLED rows, asserting the recorded `$top`/`$select`/URL/header/`signal` for each.
- [x] `tests/adapters/m365/account-settings.test.ts` — add `folders`/`batchSize` parse cases (valid, absent, out-of-range `batchSize`, empty `folders`) without weakening the existing assertions.
- [x] `tests/orch/fetch.test.ts` (new) — MULTI_ACCOUNT, MULTI_FOLDER, the defaults, sequential order, and the `LogPort` lines.
- [x] `tests/cli/backfill.test.ts` (new) + `tests/cli/dispatch.test.ts` — the NO_ACCOUNTS and CLI_SOURCE rows plus routing, the `--account` default and the flag-conflict guards.
- [x] Run `mise exec node@20 -- bun run build`, `bun run lint` and `bun run test` — all must exit 0.

**Acceptance Criteria:**
- Given two enabled m365 accounts, when `fetchAllMessages` runs, then each account is fetched sequentially and one account's failure leaves the other's messages intact and the failure counted.
- Given an account configured with `folders: [Inbox, Archive]` and `batchSize: 100`, when its messages are fetched, then two requests are made — one per folder — each with `$top=100`.
- Given a mailbox whose message list spans several pages, when it is fetched, then every page is followed via `@odata.nextLink` and every message appears exactly once in the result.
- Given a Graph entry carrying `internetMessageId`, `categories`, `from` and `isRead`, when it is mapped, then the DTO carries that `internetMessageId`, those `categories` as `existingLabels`, the sender's address and name, the account's id, `source: "m365"`, and `isRead: true` on `MessageDTO.isRead`.
- Given `getAccessToken` rejects for the first of two accounts, when the fetch runs, then the run reports that account's failure, the second account is fetched, and the exit code is 1.
- Given `--backfill --source gmail`, when the command runs, then one line names Story 5.3 as the owner and no request is attempted.

### Review Findings

- [x] [Review][Patch] The comment claims `$top` and `$select` "ride every page", but `messagesUrl` builds them for the first page only; later pages reuse Graph's `@odata.nextLink` verbatim, which carries the original query — say that instead [src/adapters/m365/M365Adapter.ts:90]
- [x] [Review][Patch] The success line prints `Fetched <n> message(s) from <selected> account(s).`, which counts *attempted* accounts, so a run where one of two accounts failed still reports "from 2 account(s)" — report the accounts that actually fetched (`selected.length - failures`) [src/cli/commands/backfill.ts:103]
- [x] [Review][Patch] A 200 whose body carries no `value` array throws without the HTTP status even though there is one, while the sibling non-2xx branch passes it and the Boundary says "the HTTP status where there is one" [src/adapters/m365/M365Adapter.ts:172-177]
- [x] [Review][Patch] `opts.folder` is only checked for `undefined`, so an empty string builds the malformed `mailFolders//messages` — treat an empty folder as the whole mailbox [src/adapters/m365/M365Adapter.ts:92-95]
- [x] [Review][Patch] A folder listed twice in one account's settings is fetched twice (the settings schema does not require uniqueness) — walk the de-duplicated folder list [src/orch/fetch.ts:64]
- [x] [Review][Patch] No test drives `listM365Accounts` *throwing* (the non-ENOENT `readdir` rethrow), so the command's `m365: <error>` + exit 1 path is unpinned while the sibling `--sync-categories` command pins the equivalent [tests/cli/backfill.test.ts]
- [x] [Review][Patch] No test runs `--account <name>` where that account's own settings file is malformed, so the named-account invalid-settings branch is unpinned (the two existing malformed-file tests both use `--account all`) [tests/cli/backfill.test.ts]

- [x] [Review][Defer] A 200 whose body is not JSON is reported as "returned no message list" — an unreadable response wearing the payload-shape wording [src/adapters/m365/M365Adapter.ts:103-110] — deferred: pre-existing in `listCategoryNames` (Story 4.2) and copied here; separating the two needs a shape decision for `readJsonObject`, not a one-line fix.

**Rejected (10):**

1. `false` — the spec's Implementation Notes still call the folder interpolation "unencoded": the only fix edits the spec under review, and the note is agent-owned bookkeeping rather than behaviour.
2. `false` — the Execution task line still names `since?`: same reason, the only fix edits the spec (the code already matches the frozen Never list).
3. `false` — the spec says `done` while `sprint-status.yaml` says `review`: both are right for their own lifecycle — the build workflow marks the spec done and leaves the board at `review`, and this review's final step flips the board to `done`.
4. `low` — the access token is resolved once for the whole walk: a walk outliving the token is possible in principle, but Graph tokens live about an hour while an 8k-message backfill takes minutes, the failure is a typed per-account error, and mid-walk refresh is a later story's hook (tracked in `deferred-work.md` since Story 2.1).
5. `low` — the named-account hint says "add …/X.yaml" when the file exists but is `enabled: false`: `listEnabledAccounts` returns only enabled accounts, so the CLI cannot tell "disabled" from "absent" without new plumbing.
6. `low` — `noAccountsHint` prints the static `~/.config/email-classify` path under an injected `configDir`: already carried as an open epic-4 retrospective action item, and the fix spans three commands plus a path-display convention.
7. `low` — `errorLine` is duplicated in `src/orch/fetch.ts` and `src/cli/commands/auth.ts`: AD-10 forbids the import, the same per-module copy already exists in `src/orch/sync.ts`, and sharing it would add core surface.
8. `false` — `opts.source` is ignored by `M365Adapter`: an adapter knowing its own provider is correct, and the DTO's `source: "m365"` is more truthful than echoing a caller-supplied string; no Gmail request is made.
9. `low` — a cyclic `@odata.nextLink` would loop forever: Graph is the only server involved and a cycle violates its contract, the fix needs a visited set or page cap, and the pre-existing `listCategoryNames` walk shares the exposure.
10. `low` — the commit message attributes the temporary command's replacement to Epic 8.1 while the code comment says Epic 11: the comment is accurate (8.1 extends the command, 11 replaces the wiring) and the commit text is unchangeable without rewriting history.

## Implementation Notes

- **2026-10-09 — Story 5.1 implementation.** Built `M365Adapter.fetchMessages` (paged message list, `$top` = the clamped batch size, `$select` including `from`/`isRead`, a folder-scoped URL when `opts.folder` is set, typed `LIST_MESSAGES_FAILED` errors through the existing `send`/`AbortSignal`), the total `mapGraphMessage` mapper, `src/orch/fetch.ts` (`fetchAllMessages` with per-account and per-folder isolation, `DEFAULT_FOLDERS`/`DEFAULT_BATCH_SIZE` written once), the additive optional `MessageDTO.isRead` and m365 settings `folders`/`batchSize`, and the temporary `--backfill --source m365 --account <name|all>` command with its dispatch guards.
- Verification: `mise exec node@20 -- bun run build`, `bun run lint` and `bun run test` green on two consecutive full runs (18 files / 220 tests). All 16 I/O-matrix rows are covered by tests that ran in that pass — the `BATCH_SIZE` clamp is a `test.each`. Manual CLI runs on a temporary `HOME`: the no-accounts hint with exit 1 and no file written, the `--source gmail` Story 5.3 rejection with exit 1, and `--help` listing the new flags.
- **No live Microsoft Graph call was made** — there are no credentials in this environment, so the request shape, pagination and mapping are verified against the mocked `FetchLike` only, never against the service.
- Known and deliberate: `opts.folder` is interpolated into the request path unencoded (fine for Graph's well-known names such as `Inbox`/`Archive`, but a folder display name containing a space or `#` would need encoding); `fetchAllMessages` counts failures per account, so an account whose second folder fails counts once; and `noAccountsHint` prints the static `~/.config/email-classify` path even under an injected `configDir`, matching the sibling `--sync-categories` command and already carried as an open epic-4 retrospective action item.

## Spec Change Log

- 2026-10-09 (revisit pass, human-approved): The deferred 401→silent-refresh hook from Story 2.1 was implemented in `M365Adapter.fetchMessages`. When Graph returns 401 on the first page, the adapter calls `getAccessToken(accountId, { forceRefresh: true })` once and replays the request. If the replay still 401s, or if a 401 arrives on a later `@odata.nextLink` page, the adapter returns `LIST_MESSAGES_FAILED` as before — nextLink URLs are temporary/signed and unsafe to replay after a token change. Added three unit tests covering the happy-forceRefresh path, the persistent-401 path, and the later-page no-retry path. Known-bad state avoided: a transient token revocation between acquisition and use turning into a permanent per-account failure. KEEP: `ensureCategories` does not force-refresh on 401; `fetchMessages` does one refresh only; rate-limit/backoff for 429 remains Epic 9's scope.

## Review Triage Log

| # | Source | Location | Verdict | Evidence and route |
|---|--------|----------|---------|--------------------|
| 1 | blind-hunter 1 + edge-case 1 | `src/adapters/m365/M365Adapter.ts:92-95` | `medium` | **patch.** The folder segment is interpolated into the request path unencoded, so a configured folder such as `Sent Items` produces a malformed URL and that account fails with a confusing error; the settings schema accepts any non-empty string, so nothing steers the user to a well-known name. Fix: percent-encode the segment. |
| 2 | blind-hunter 2 + verification-gap (other) | `src/adapters/m365/M365Adapter.ts:20`, `src/orch/fetch.ts:22` | `low` | **rejected.** Both `50`s are load-bearing and independently pinned: the adapter's is the `DEFAULT_BATCH` row's fallback for a direct `FetchOpts` call, the orchestrator's is the plan default. A single constant is impossible under AD-10 (adapters may not import `orch`) and would need new core surface, and the repo already keeps per-module constants of this kind (`REQUEST_TIMEOUT_MS` in all four adapters). Both are test-pinned, so divergence fails loudly. |
| 3 | blind-hunter 3 | spec matrix vs `src/adapters/m365/accountSettings.ts:22-23` | `low` | **rejected.** Both layers do exactly what the spec states and both are tested — the adapter clamps a direct `batchSize` (`test.each`) and the settings schema rejects an out-of-range config value. The only actionable part is naming the layer in the matrix, and triage rejects any finding whose fix edits this build's spec. |
| 4 | blind-hunter 4 + edge-case 4 | `src/cli/dispatch.ts` | `low` | **patch.** `--source` is read only inside `resolveBackfill`, so `--source gmail --auth m365` silently drops the flag and then fails with the unrelated required-flags line. The sibling `--auth` + `--sync-categories` guard exists for exactly this class of silent drop. |
| 5 | blind-hunter 5 | `src/cli/commands/backfill.ts:12-15` | `low` | **patch.** `BackfillCommandOptions.source` is typed `string` and never read, so a direct caller passing `"gmail"` still fetches M365. Fix: narrow to `"m365"` and forward it to the orchestrator, matching `runAuth`'s provider handling. |
| 6 | blind-hunter 6 | `tests/cli/dispatch.test.ts` | `low` | **patch.** The `source !== "m365"` branch (the "Unknown --source" line) has no case; only `gmail` and `all` are covered. |
| 7 | blind-hunter 7 | `tests/adapters/m365/m365-adapter.test.ts` (PAGED) | `false` | **rejected.** The property under test is verbatim use of the link, and the adapter does nothing else with it. A rewrite that re-appended or replaced parameters would make the recorded URL differ from the fixture and fail the assertion either way, so a fixture carrying `$top`/`$select` asserts exactly the same thing. |
| 8 | blind-hunter 8 | `src/adapters/m365/messageMapper.ts` (`receivedDateTime`) | `false` | **rejected.** The adapter sends no `Prefer: outlook.timezone` header — `getRequest(authorizationHeader(token))` carries `authorization` alone — so Graph's documented default applies and `receivedDateTime` arrives as ISO 8601 UTC with a `Z` suffix. There is no non-UTC offset to normalize. |
| 9 | blind-hunter 9 | `src/core/dto/MessageDTO.ts` (`isRead` doc) | `false` | **rejected.** The comment states Gmail's read model accurately — Gmail has no read flag, and read state is the absence of the `UNREAD` system label — as the field's provider-agnostic meaning. Story 5.3 implements that mapping; the doc does not claim it exists. |
| 10 | blind-hunter 10 | `src/orch/fetch.ts:66` | `low` | **patch.** The frozen Never list gives `since` to Story 5.2 and the adapter ignores it, so the pass-through is dead surface. Delete the forwarding and its assertion. The task line that named `since?` was the non-frozen error; no incremental behaviour was implemented, so the frozen intent is intact and no loopback is warranted. |
| 11 | blind-hunter 11 | `src/adapters/m365/M365Adapter.ts:87-88` | `low` | **rejected.** `Math.trunc(50.9)` → 50 is correct for a page size, and the config path's stricter `.int()` is the deliberate strict-config/defensive-API split; neither path produces a bad outcome, and `NaN` is unreachable (the schema's `z.number()` rejects it). |
| 12 | edge-case 2 | `src/orch/fetch.ts:55` | `low` | **patch.** `account.folders ?? DEFAULT_FOLDERS` lets an empty array through, so the account fetches nothing and is logged as a success. Unreachable from the CLI (the schema rejects an empty list) but reachable through the orchestrator's own API, which Story 5.3 will call. |
| 13 | edge-case 3 | `src/adapters/m365/M365Adapter.ts` page walk | `low` | **rejected.** A cyclic `@odata.nextLink` would loop, but Graph is the only server involved and a cycle violates its contract; the fix needs a visited set or page cap (state the walk does not otherwise carry), and the pre-existing `listCategoryNames` walk has the identical exposure — the repo's established pattern, not a regression this story introduced. |
| 14 | verification-gap 1 | `src/cli/index.ts:18-37` | `low`, verified gap | **defer.** No test boots the commander entry point — it calls `parseAsync` on import, a deliberate repo choice shared with the pre-existing `--auth`/`--sync-categories` wiring — so the flag strings and action routing are manual-check only. Closing it needs an entry-point refactor, out of this story's scope. |
| 15 | verification-gap 2 | `src/orch/fetch.ts:70-71` | `low`, verified gap | **patch.** No test has two folders of one account both failing, so the once-per-account guard that keeps the CLI's "N of M account(s) failed" line coherent is unpinned. |
| 16 | verification-gap 3 | `src/cli/commands/backfill.ts:87-91` | `low`, verified gap | **patch.** The zero-enabled-accounts-with-errors branch (the "invalid settings" line) has no test; both existing empty cases carry no errors and exercise only the setup hint. |

## Design Notes

- **`$top` is the batch size.** The AC names two numbers — `$top=100` in the URL and "batch size configurable per account (default 50, max 100)" — and the only reading where both hold is `$top` = the batch size, defaulted to 50 and clamped at 100 (`min(max(n, 1), 100)`). Story 8.1's `--batch-size` is the same knob, and Story 8.2's resume is per message via the idempotency store rather than a fetch cursor, so nothing downstream needs pages to be fixed at 100.
- **No `$orderby`.** Ordering is not part of FR-6, Graph's default (received time, newest first) is what the AC's URL produces, and per-message idempotency means resume does not depend on order. Adding an `$orderby` would be a deviation with no consumer.
- **A partial page walk throws.** Returning the pages that succeeded would make an interrupted backfill look complete once the caller's exit code was 0. The cost is re-fetching a page's worth of messages, which Story 8.2's idempotency keys absorb.
- **The folder walk is orchestration, not adapter work.** `FetchOpts.folder` is singular by design, so the adapter stays a single-folder fetch and `src/orch/fetch.ts` owns the walk — which is also what Story 5.3 needs for Gmail's label set.
- **The mapper is total.** `MessageDTO` has no optional fields, so a malformed entry must still yield a valid DTO; the alternative — skipping the entry — would silently lose mail. Graph's `$select` makes the fields present in practice, so the defensive reads are a boundary guard, not the normal path.
- **Defaults live in the orchestrator.** The settings schema stays optional (Story 2.1's `toEqual` assertion) and the adapter clamps defensively, so `["Inbox"]` and `50` are written once, where the plans are built.
- **`isRead` belongs on the DTO, not in `raw`.** It is a documented, AC-level requirement rather than provider trivia, and `raw` is untyped and unvalidated; the alternative reading — mapping it into `raw` to keep core untouched — would put a field the epic contract requires somewhere nothing can check it.

## Verification

**Commands:**
- `mise exec node@20 -- bun run build` — expected: exit 0.
- `mise exec node@20 -- bun run lint` — expected: exit 0 (AD-10 direction and the stdlib-only `tests/adapters/**` rule both apply).
- `mise exec node@20 -- bun run test` — expected: exit 0, every I/O-matrix row above covered.
- `grep -rn "googleapis\|microsoft-graph-client" src tests` — expected: no matches (plain `fetch` only).

**Manual checks:**
- `HOME=$(mktemp -d) node dist/cli/index.js --backfill --source m365 --account all` — expected: the no-enabled-accounts hint, exit 1, and no file written to that home.
- `HOME=$(mktemp -d) node dist/cli/index.js --backfill --source gmail` — expected: the Story 5.3 line, exit 1, no request attempted.
- `node dist/cli/index.js --help` — expected: the new flags listed with an example.
- No live Microsoft Graph call is possible in this environment (no credentials). Say so in the implementation notes rather than implying the request shape was verified against the service.
