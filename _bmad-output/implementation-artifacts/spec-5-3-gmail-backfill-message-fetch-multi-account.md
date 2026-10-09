---
title: 'Story 5.3: Gmail Backfill Message Fetch (Multi-Account)'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: 'e6d653ed187c879fe30406f9a90b886e17ea55f8'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-2-m365-incremental-message-fetch-cron-multi-account.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `GmailAdapter` can sync labels but cannot read mail, and `--backfill --source gmail` is rejected outright (`src/cli/dispatch.ts:37`). No Gmail message ever becomes a `MessageDTO`, so Epic 6 has nothing to classify for any Gmail account.

**Approach:** add `GmailAdapter.fetchMessages(opts)` — `users.messages.list` scoped by `labelIds` with `maxResults` and page tokens, then hydrate each id's details through Gmail's multipart `batchGet` endpoint and map them to the canonical `MessageDTO` in a new total mapper. Extend the Gmail settings schema with optional `labels`/`batchSize` and lift the `--source gmail` rejection so the existing provider-agnostic `fetchAllMessages` loop drives Gmail backfill too.

## Boundaries & Constraints

**Always:**
- `fetchMessages(opts: FetchOpts): Promise<MessageDTO[]>` — the `MailPort` signature verbatim, so `GmailAdapter` conforms to two of that port's three methods (`writeLabels` is Epic 7). `ensureCategories`/`labelIdsFor` keep working unchanged.
- List URL: `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=<label>&maxResults=<n>`, plus `pageToken` on later pages; `maxResults` = `opts.batchSize` clamped 1..100, default 50; the label is `opts.folder` when set, else `INBOX`. Pagination follows `nextPageToken` until absent. A page whose `messages` is not an array is an error, never "no messages"; a failure on any page throws and returns no partial array. The same clamped `batchSize` bounds each detail batch (human decision, 2026-10-09).
- Detail hydration uses Gmail's batch endpoint: `POST https://gmail.googleapis.com/batch/gmail/v1` with a `multipart/mixed` body of per-id `GET /gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=From,Subject` parts, parsed from the `multipart/mixed` response. Each batch carries at most the clamped `batchSize` ids. Requests exactly `internetMessageId`, `labelIds`, `snippet`, `internalDate` and the `From`/`Subject` headers; a batch whose response cannot be parsed is a typed error, never a silent skip.
- Mapping lives in `src/adapters/gmail/messageMapper.ts` and is total: `id`, `internetMessageId`, `subject` (Subject header), `snippet` → `bodyPreview`, `internalDate` (epoch-ms string) → ISO-8601 UTC `receivedDateTime`, `labelIds` → `existingLabels`, `From` header → `senderEmail`/`senderName`, `isRead` = `labelIds` lacks `UNREAD`, `source: "gmail"`, `accountId`. A missing or non-string field degrades to `""`/`[]`; it never throws and never drops a message.
- Orchestration is reused, not rewritten: `src/orch/fetch.ts`'s `fetchAllMessages` already takes `source` and is provider-agnostic. No new orchestrator.
- Errors are typed at the adapter boundary: `GmailAdapterErrorCode` gains `LIST_MESSAGES_FAILED` (and the detail-step code the chosen mechanism needs); every error names the account and the HTTP status where there is one, and never carries Gmail's payload or the thrown cause.
- Per-account configuration: the gmail settings schema gains **optional** `labels` (non-empty array of non-empty strings) and `batchSize` (integer 1..100), mirroring Story 5.1's m365 `folders`/`batchSize`. They must stay optional — Story 3.1's schema assertions pin the four auth keys.
- `GmailAdapter.send` currently hardcodes `LABELS_URL`; it is generalised to take the URL as a parameter without changing `ensureCategories`/`labelIdsFor` behaviour, the timeout, or the typed-error contract.
- CLI: `--backfill --source gmail --account <name|all>` runs the Gmail path through `runBackfill`; `--account` defaults to `all`; the exit code is non-zero when any account failed. `--source` accepts exactly `m365` or `gmail` — `all` stays rejected (human decision, 2026-10-09).
- AD-10: `core` untouched; adapters import only `core`; `orch` only `core`; `cli` wires all. Relative imports carry explicit `.js` extensions.

**Never:**
- No Gmail incremental fetch, `users.history.list`, `startHistoryId`, or history-expiry fallback (Story 5.4).
- No state file, resume cursor, or per-message idempotency (Story 8.2); no cron loop/timer (8.3).
- No classification and no label write-back (Epics 6/7): hydrated DTOs are counted and logged, never persisted.
- No retry, backoff, or 429 handling (Epic 9): a 429 is a typed per-account failure.
- No `--since`/`--batch-size` flags (8.1); no new state or config file.
- No `googleapis` / `@microsoft/microsoft-graph-client` import anywhere in `src/` or `tests/`, and no change to M365 fetch or the M365 settings schema.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY | one account, one list page of two ids | the two ids' details fetched in one batch; two `MessageDTO`s; the list GET carries `labelIds=INBOX`, `maxResults=50`, the Bearer header and an `AbortSignal` | N/A |
| BATCH_GET | one list page of two ids | a single `POST /batch/gmail/v1` whose `multipart/mixed` body carries one metadata GET per id; both parts parsed | N/A |
| BATCH_MALFORMED | a batch response whose parts cannot be parsed | that account fails | typed error naming the account; no partial array |
| PAGED | two pages linked by `nextPageToken` | every page's ids hydrated, each id exactly once; one GET per page | N/A |
| LABEL | `folder: "Label_5"` | `labelIds=Label_5` on the list GET | N/A |
| BATCH_SIZE | `batchSize` 100 / 250 / 0 | `maxResults=100` / clamped to 100 / clamped to 1 | N/A |
| MAPPING | a detail carrying `internetMessageId`, `labelIds`, `snippet`, `internalDate`, `From`/`Subject` headers | DTO with ISO `receivedDateTime`, `labelIds` as `existingLabels`, `snippet` as `bodyPreview`, sender pair, `subject`, `source: "gmail"`, `accountId`, `isRead` from `UNREAD` | N/A |
| MISSING_FIELDS | a detail missing subject, snippet, labelIds and headers | DTO with `""`/`[]` in those fields; nothing throws | N/A |
| UNREAD | `labelIds` containing `UNREAD` | `isRead: false`; without it, `true` | N/A |
| AUTH | the token seam throws for one account | that account is reported and skipped; the others still fetch | logged with `accountId` (AD-4 line) and counted as a failure |
| API_ERROR | 403 on the list | no messages for that account | typed `LIST_MESSAGES_FAILED` naming account and status |
| MID_PAGE_ERROR | list page 1 succeeds, page 2 answers 500 | no partial array reaches the orchestrator | typed error; the account counts as failed |
| MALFORMED | a 200 whose body has no `messages` array | no messages | typed error, never an empty result |
| THROTTLED | 429 on a page or a detail batch | that account fails | typed error; no retry (Epic 9) |
| MULTI_ACCOUNT | two gmail accounts, the first fails | the second is fetched in full; the run reports one failure | counted failure line naming the account; exit code reflects it |
| NO_ACCOUNTS | `--backfill --source gmail --account all` with no enabled gmail account | gmail setup hint | exit 1 |
| CLI_SOURCE | `--backfill --source gmail` | the Gmail fetch runs (Story 5.1's rejection is gone) | exit 1 only when an account failed |

</frozen-after-approval>

## Code Map

- `src/adapters/gmail/GmailAdapter.ts:7,15,112,136,172,204` — `LABELS_URL`, `GmailAdapterErrorCode`, `ensureCategories`/`listLabels`/`createLabel`, and the private `send` that must take a URL. Add `fetchMessages`, the list/detail helpers and `LIST_MESSAGES_FAILED`; the batch endpoint constant and the `multipart/mixed` builder/parser are new module-level helpers; do not change label-sync behaviour.
- `src/adapters/gmail/messageMapper.ts` (new) — the total `mapGmailMessage(entry, accountId): MessageDTO`, the one place Gmail payload shapes are known. Mirror `src/adapters/m365/messageMapper.ts` (Story 5.1).
- `src/adapters/gmail/accountSettings.ts:17-24` — the settings schema to extend with optional `labels`/`batchSize`; keep the four auth keys and the tolerance of unknown keys (Story 3.1's suite pins them).
- `src/cli/dispatch.ts:19,27-47` — `resolveBackfill` and the `source === "gmail"` rejection to lift; `CliBackfill` and `resolveCliCommand` pinning. `resolveCron` (`:51`) keeps rejecting gmail (Story 5.4).
- `src/cli/commands/backfill.ts:16,41,56-97` — `BackfillCommandOptions`, `planFor`, and the `fetchAllMessages` call; it becomes provider-parameterised (two listings/ports, or a provider plan table mirroring `src/cli/commands/sync-categories.ts:96-208`'s `ProviderPlan` shape).
- `src/orch/fetch.ts:6-34,49-83` — `MessageFetchTarget`, `FetchAccount`, `DEFAULT_FOLDERS`/`DEFAULT_BATCH_SIZE`, `fetchAllMessages`; reused as-is (its `source` option already exists).
- `src/adapters/index.ts` — export `mapGmailMessage` and any new Gmail error code.
- `tests/adapters/gmail/gmail-adapter.test.ts:35-100` — the stdlib-only `scriptedFetch`/`jsonResponse` harness to copy for the list/detail tests; `tests/orch/fetch.test.ts` and `tests/cli/backfill.test.ts:19-100` are the orch/CLI patterns.
- Do not touch: `src/adapters/m365/**`, `src/adapters/config/taxonomy.ts`, `src/adapters/config/configFile.ts`, `src/core/**`, `src/adapters/gmail/labelColors.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/gmail/messageMapper.ts` (new) — total `mapGmailMessage` (internalDate→ISO, labelIds→existingLabels, UNREAD→isRead, From/Subject headers→senders/subject, `source: "gmail"`) — the boundary mapping gets its own focused tests.
- [x] `src/adapters/gmail/GmailAdapter.ts` — generalise `send` to take a URL, add `fetchMessages` (list walk via `nextPageToken`, `maxResults`/`labelIds` clamp and encoding, detail hydration through the `batch/gmail/v1` multipart batch, mapping), and add `LIST_MESSAGES_FAILED` (+ the detail code) to the error union — the class doc comment currently says only label sync is implemented.
- [x] `src/adapters/gmail/accountSettings.ts` — add optional `labels` (`z.array(z.string().min(1)).min(1).optional()`) and `batchSize` (`z.number().int().min(1).max(100).optional()`) without weakening Story 3.1's assertions.
- [x] `src/cli/dispatch.ts` — allow `--source gmail` for `--backfill` (a branch that keeps `all` rejected); keep `resolveCron` gmail-rejecting; keep the mutual-exclusion guards.
- [x] `src/cli/commands/backfill.ts` — make the command provider-aware: build Gmail accounts/port when `source === "gmail"`, run the shared `fetchAllMessages`, print counts and counted failures, set the exit code.
- [x] `src/adapters/index.ts` — export `mapGmailMessage` and the new Gmail error code.
- [x] `tests/adapters/gmail/message-mapper.test.ts` (new) — MAPPING, MISSING_FIELDS and UNREAD rows.
- [x] `tests/adapters/gmail/gmail-adapter.test.ts` — HAPPY, PAGED, LABEL, BATCH_SIZE, AUTH, API_ERROR, MID_PAGE_ERROR, MALFORMED, THROTTLED rows, asserting the recorded URL/header/signal.
- [x] `tests/adapters/gmail/account-settings.test.ts` — `labels`/`batchSize` parse cases (valid, absent, out-of-range, empty) without weakening existing assertions.
- [x] `tests/orch/fetch.test.ts` — a `source: "gmail"` stamp row if not already covered.
- [x] `tests/cli/backfill.test.ts` + `tests/cli/dispatch.test.ts` — the CLI_SOURCE row (gmail now runs), MULTI_ACCOUNT/NO_ACCOUNTS for gmail, and the `--account` default.
- [x] Run `mise exec node@20 -- bun run build`, `bun run lint`, `bun run test` — all exit 0.

**Acceptance Criteria:**
- Given `--backfill --source gmail --account all` with two enabled Gmail accounts, when it runs, then each account is fetched sequentially and one account's failure leaves the other's messages intact and the failure counted.
- Given an account whose mailbox spans several list pages, when it is fetched, then every page is followed via `nextPageToken` and every message appears exactly once in the result.
- Given a Gmail detail carrying `internetMessageId`, `labelIds`, `snippet` and `internalDate`, when it is mapped, then the DTO carries that `internetMessageId`, those `labelIds` as `existingLabels`, the snippet as `bodyPreview`, an ISO-8601 `receivedDateTime`, the sender pair, `source: "gmail"` and the account's id.
- Given a message whose `labelIds` omit `UNREAD`, when it is mapped, then `isRead` is `true`; with `UNREAD` present, `false`.
- Given `--backfill --source gmail`, when the command runs, then no request is made to Microsoft Graph and the run exits non-zero only if an account failed.

### Review Findings

- [x] [Review][Patch] Batch request framing is unverified and may be malformed — `batchRequestBody` emits parts whose request line omits the `HTTP/1.1` version and whose delimiter lines gain an extra CRLF (`parts.join("\r\n")` after a part already ending `\r\n`), and the tests only `toContain` the inner GET line, never the delimiter or `Content-Type: application/http` bytes; a frame Gmail rejects would keep the suite green. Fix the framing to Google's documented batch form and assert the exact body bytes. [src/adapters/gmail/GmailAdapter.ts batchRequestBody]
- [x] [Review][Patch] A listed entry with a missing/non-string `id` is silently dropped — `page.map(...).filter(id => id !== undefined)` shrinks the batch and the result with no error, contradicting the file's own `parts.length !== ids.length` rule and the "never drops a message" stance. Make a missing list `id` a typed `LIST_MESSAGES_FAILED`. [src/adapters/gmail/GmailAdapter.ts fetchMessages]
- [x] [Review][Patch] No cross-page id de-duplication — every page's DTOs are appended with no seen-id set, so a message Gmail repeats across pages (mail arriving during a long backfill) yields duplicate DTOs and inflates the count, violating the "each id exactly once" AC. Track seen ids across the page walk. [src/adapters/gmail/GmailAdapter.ts fetchMessages]
- [x] [Review][Patch] Label/page-token URL encoding is unasserted — `encodeURIComponent` wraps `labelIds`/`pageToken` but every test uses `INBOX`/`Label_5`/`PAGE_2`, which encoding does not change, so deleting it stays green while a label like `Family/Friends` silently queries the wrong label. Add an encoded-URL case. [tests/adapters/gmail/gmail-adapter.test.ts]
- [x] [Review][Patch] Gmail invalid-settings and `--account <name>` hints are untested — the rewritten `relevantErrors`/`noAccountsHint` branches for gmail have no case. Add one mirroring the m365 coverage. [tests/cli/backfill.test.ts]
- [x] [Review][Defer] An unrelated party-mode memory rides into the diff — deferred: pre-existing untracked artefact from another session inside the human-owned `_bmad-output/` tree; keep it out of the story commit. [_bmad-output/party-mode/memories/installed/.memlog.md]
- [x] [Review][Defer] The `--source` help/example text is only manually checked — deferred: `src/cli/index.ts` cannot be imported by a test (`parseAsync` on import); already recorded as the entry-point deferral. [src/cli/index.ts:21]

**Rejected**

- `false` — "the story artifact contradicts itself (status in-progress, tasks unticked)": the reviewed diff predates the step-03 task tick and the `in-review` status; the file on disk is now consistent.
- `false` — "`sprint-status.yaml` is human-owned, AGENTS.md forbids editing it": the bmad-build workflow explicitly authorises its own artifact writes to `_bmad-output/`; the sprint sync is that step.
- `false` — "a 2xx batch part whose body is not a message object becomes a lost message": the frozen Boundaries require the mapper to be total — a malformed entry degrades to an empty DTO and is never dropped; that is the mandated behaviour, not a defect.
- `low` — whitespace-only `internalDate` (`Number(" ") === 0`) maps to the Unix epoch — an input no Gmail response is shown to produce; the fix adds a guard/regex.
- `low` — a `response.text()` rejection is reported as "unreadable batch" without the status — error-message precision only; the failure is still loud and typed.
- `low` — verification notes cite an undefined `bun run vitest run` — a note-wording drift; the fix edits the spec.
- `low` — `adapters/index.ts` exports `mapGmailMessage` but not the new error codes — the codes are union members of the already-exported `GmailAdapterErrorCode`; a second export is redundant surface.
- `low` — Code Map `path:line` spans are pre-change and now stale — the fix edits the spec.
- `low` — the empty-label fallback is `entry.labels ?? ["INBOX"]`, not length-guarded — unreachable from the CLI (the `.min(1)` schema rejects `[]`); a length guard is more than a direct correction.
- `low` — no `docs/` worked example for the new command — documentation nicety, not required by the spec.
- `low` — a repeated `nextPageToken` would page forever — a Gmail contract violation, and the m365 `@odata.nextLink` walk shares the same exposure (already rejected); the fix adds loop state.
- `low` — batch response parts are correlated to ids by position, never by `Content-ID` — Gmail returns batch parts in request order; matching `Content-ID` adds parsing the contract does not warrant.
- `false` — the `--source` help/example text is "untestable" is already recorded as a defer, not a new defect.

**Second pass (2026-10-09 — this review's range also covers the elicitation hardening commit `d58d6c9`):**

- [x] [Review][Patch] Content-ID correlation only matched the request-echo form — Google's documented batch responses echo `Content-ID: <response-message-N>`, so `contentIdIndexOf` never engaged on a live response and every part correlated by position; both response fixtures also stamped every part with the same constant id, so per-part numbering was never exercised anywhere. The regex now accepts both forms and the fixtures emit per-part documented ids. [src/adapters/gmail/GmailAdapter.ts contentIdIndexOf; tests/adapters/gmail/gmail-adapter.test.ts batchResponse; tests/cli/backfill.test.ts gmailBatchResponse]
- [x] [Review][Patch] A batch part carrying a different message's payload was silently attributed to the requested id — `fetchBatch` pinned the part count and non-empty ids but never `message.id !== ids[index]`. Now it does. [src/adapters/gmail/GmailAdapter.ts fetchBatch]
- [x] [Review][Patch] A present-but-malformed `nextPageToken` quietly ended the walk — `readString` maps a non-string or empty token to `undefined`, so a truncated backfill could look complete, against the frozen "a partial page walk throws" note. A present-but-unusable token is now a typed error. [src/adapters/gmail/GmailAdapter.ts fetchMessages]
- [x] [Review][Patch] The cross-page dedup guard shipped unverified — no test repeated an id across pages, so removing the guard kept all 315 tests green (mutation-verified by the verification-gap layer). Added the repeated-id PAGED row. [tests/adapters/gmail/gmail-adapter.test.ts]
- [x] [Review][Patch] The id-less list entry error shipped untested — the patch that made a `messages` entry without an `id` a typed error never drove it. Added the row. [tests/adapters/gmail/gmail-adapter.test.ts]
- [x] [Review][Patch] Whitespace-only `internalDate` mapped to the Unix epoch — `Number(" ") === 0` survived the length check. `readInternalDate` now requires digits. [src/adapters/gmail/messageMapper.ts readInternalDate]
- [x] [Review][Patch] The "Splits a multipart/mixed body" doc comment sat orphaned above `contentIdIndexOf` and `splitBatchParts` read undocumented — restored to its function. [src/adapters/gmail/GmailAdapter.ts]
- [x] [Review][Patch] Stale artifact text corrected: the triage log's rejection of the empty-id→typed-error behavior is **superseded by the human-approved elicitation change** (the frozen "a batch whose response cannot be parsed is a typed error, never a silent skip" governs — a non-message part is unreadable, not degradable); the execution checkbox still naming the un-exported error codes is recorded here rather than rewritten; the notes' `bun run vitest run` wording and stale 309-test count are fixed above. [this spec]
- [x] [Review][Defer] A token acquired once can expire mid-walk — `fetchMessages` takes the access token before an unbounded page walk, so a backfill that outlives `expiresAt` fails the account late with no re-acquisition. Deferred: the identical shape exists in M365 backfill (Story 5.1) and refresh-on-401 is this story's recorded out-of-scope decision; Epic 8 owns it. [src/adapters/gmail/GmailAdapter.ts fetchMessages]
- [Decision → applied] Overlapping configured labels fetch a message twice — **decided 2026-10-09: the adapter instance remembers the ids it returned per account**, mirroring the label-cache pattern, so a message carrying two of the account's labels is returned once per run; the shared walk stays DTO-free. Original finding: Gmail labels overlap by design, so a message carrying two of the account's configured labels was listed, hydrated and counted once per label. [src/adapters/gmail/GmailAdapter.ts returnedIdsByAccount]

**Rejected (second pass)**

- `false` — "deleting `.toLowerCase()` stays green": the mapper looks up lower-cased keys while every test feeds title-case `From`/`Subject`, so the mutation turns the sender rows red — the lowercasing is already pinned.
- `low` — "two same-named `readString` helpers with different semantics invite drift": the m365/gmail mapper copies are identical by design and each module owns its reader; the adapter's stricter variant is documented.
- `false` — "`runBackfill` eagerly builds both providers' adapters and indexes `plans[options.source]` unchecked": both constructors are pure (no I/O) and `source` reaches it only through dispatch, which guarantees the two-value union — neither named harm is reachable.
- `low` — "`splitBatchParts` splits anywhere on the boundary token rather than line-anchored": Gmail selects the boundary so it cannot appear in message content, so the mis-split is not a shown-reachable input, and the fix is a parser rewrite for it.
- `false` — "spec `status: done` contradicts the board's `review`": both are correct — the spec records the change, the board's gate is the still-open human verdict.
- `low` — "`clampBatchSize(Infinity)` yields the default instead of clipping to 100": unreachable through the settings schema, and defaulting non-finite input is a defensible reading.
- `low` — "the wire contract is pinned only against self-consistent mocks": already recorded — no live Gmail call was possible; the Implementation Notes say so.
- `low` — "the MAPPING row is unverified end-to-end at the CLI": mapping is pinned at its own boundary by the mapper suite; the CLI adds only pass-through.
- `low` — "a deferred-work entry cites `src/cli/index.ts` without a line span": folded into the `--source` defer entry above.

## Implementation Notes

- **2026-10-09 — Story 5.3 implementation.** `GmailAdapter.fetchMessages` walks `users.messages.list` page by page (`labelIds` = the account's label or `INBOX`, `maxResults` = the clamped `batchSize`, `pageToken` on later pages) and hydrates every page's ids through a `POST /batch/gmail/v1` `multipart/mixed` batch, one metadata GET per id; a non-2xx page, a page without a `messages` array, an unreadable batch, or a failed part throws a typed `LIST_MESSAGES_FAILED`/`BATCH_GET_MESSAGES_FAILED` naming the account and status and returns no partial array. `src/adapters/gmail/messageMapper.ts` maps a metadata detail to the canonical `MessageDTO` (`internalDate` ms → ISO-8601, `labelIds` → `existingLabels`, `UNREAD` absence → `isRead`, `From`/`Subject` headers → senders/subject). The settings schema gains optional `labels`/`batchSize`; `--backfill --source gmail` is lifted in `dispatch.ts` and `backfill.ts` now builds a per-provider plan and drives the shared `fetchAllMessages`.
- Verification: `bun run build`, `bun run lint`, `bun run test` green — 22 files / 318 tests (315 after the story; 3 added by the second review pass). Every I/O-matrix row is covered by passing tests (HAPPY/BATCH_GET/BATCH_MALFORMED/PAGED/LABEL/BATCH_SIZE/MAPPING/MISSING_FIELDS/UNREAD/AUTH/API_ERROR/MID_PAGE_ERROR/MALFORMED/THROTTLED/MULTI_ACCOUNT/NO_ACCOUNTS/CLI_SOURCE).
- **No live Gmail call was made** — no credentials (and no consent flow) are available in this environment, so the list URL, page tokens, batch request/response shapes and the DTO mapping are verified against the mocked `FetchLike` only. The manual checks run the built CLI: `--backfill --source gmail --account all` with no enabled account prints the gmail setup hint and exits 1 with no request; `--help` describes `--source gmail` for `--backfill`.

## Spec Change Log

## Review Triage Log

## Design Notes

- **Reuse the provider-agnostic loop.** `fetchAllMessages` already takes `source`, walks `folders`, isolates accounts and counts failures, so Gmail backfill adds an adapter and a plan, not a second orchestrator.
- **`batchGet` is Gmail's generic batch endpoint.** The epic names `users.messages.batchGet`; Gmail exposes batching only as `POST /batch/gmail/v1` with a `multipart/mixed` body, so this story writes the smallest builder/parser that speaks it over plain `fetch` — no SDK. `batchSize` bounds both the list page (`maxResults`) and the ids per batch, each capped 1..100 (human decision, 2026-10-09).
- **`internalDate` is epoch milliseconds.** Gmail returns a string of ms since the epoch, so the mapper converts once (`new Date(Number(...)).toISOString()`) and everything downstream keeps seeing ISO-8601 UTC — the same convention `MessageDTO.receivedDateTime` already documents.
- **`existingLabels` carries Gmail's `labelIds`.** The DTO's provider-native labels are `categories` for M365 and `labelIds` for Gmail; Epic 7's write-back reads them by id.
- **`isRead` from `UNREAD`.** The `MessageDTO.isRead` doc added in Story 5.1 states Gmail's read state is the absence of the `UNREAD` system label; this story implements exactly that reading.
- **A partial page walk throws.** Same rule as Story 5.1: returning the pages that succeeded would let an interrupted backfill look complete once the exit code was 0.

## Verification

**Commands:**
- `mise exec node@20 -- bun run build` — expected: exit 0.
- `mise exec node@20 -- bun run lint` — expected: exit 0 (AD-10 and the stdlib-only `tests/adapters/**` rule both apply).
- `mise exec node@20 -- bun run test` — expected: exit 0, every I/O-matrix row covered.
- `grep -rn "from \"googleapis" src tests` — expected: no matches.

**Manual checks:**
- `HOME=$(mktemp -d) mise exec node@20 -- node dist/cli/index.js --backfill --source gmail --account all` — expected: the gmail no-enabled-accounts hint, exit 1, no request.
- `mise exec node@20 -- node dist/cli/index.js --help` — expected: `--source gmail` described for `--backfill`.
- No live Gmail call is possible here (no credentials); say so in the implementation notes.
