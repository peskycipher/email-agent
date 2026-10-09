---
title: 'Story 7.1: M365 Label Write (Multi-Account)'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: 'b39031ea968ddbed67d554cbb8b9549e2cf298da'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Classification returns a `LabelSet` of taxonomy label names, but nothing writes them back: `MailPort.writeLabels` is declared (spec-1-2) and both adapters defer it to Epic 7 (`M365Adapter.ts:119-121`, `GmailAdapter.ts:335-337`), so M365 messages never get their predicted categories and Outlook shows nothing.

**Approach:** Implement `writeLabels(accountId, messageId, labels)` in `M365Adapter`: read the message's current `categories`, `PATCH /me/messages/{id}` with the union of current + missing predicted labels, add nothing already present, remove nothing, and absorb a per-message 404 so one moved message cannot fail a run.

## Boundaries & Constraints

**Always:**
- Add-only: the PATCH body is `categories` = union(existing, predicted); no category is dropped or renamed (FR-13).
- Account-scoped: the token comes from `getAccessToken(accountId)`; no cross-account write.
- Wire detail stays in the adapter; orchestration keeps seeing `MailPort.writeLabels(accountId, messageId, labels): Promise<void>` (AD-8) and `src/core/**` is untouched (AD-10).
- Reuse the adapter's seams: forceRefresh-once on 401 as in `ensureCategories`, `send` (bounded `AbortSignal.timeout`, typed network error), and the `M365AdapterError` shape `{code, accountId, status?}`.
- Category names match exactly and case-sensitively (the `ensureCategories` rule).
- Tests extend `tests/adapters/m365/m365-adapter.test.ts`, stdlib-only (no Graph SDK, no MSW).

**Never:**
- No orchestration or CLI work: no run loop, no new command (Epic 8 drives fetch → classify → write; Epic 11 owns wiring).
- No Gmail work (Story 7.2); no 429 backoff (Epic 9); no delta/history or idempotency-store interaction.
- No label removal, no category create/rename (that is `ensureCategories`), no taxonomy validation of the given names.

## Decisions

- **Existing categories are read from the mailbox, not taken on trust.** `writeLabels` issues `GET /me/messages/{id}?$select=categories` before deciding anything: the frozen port carries no existing-label input, and a `MessageDTO`'s `existingLabels` may predate a user edit in Outlook. "No API call when the message already has all predicted labels" therefore means **no PATCH** — the read is what reveals there is nothing to write.
- **The 404 is the adapter's to absorb, and it logs it.** `M365AdapterDeps` gains `logPort` (the same `LogPort` orchestration already passes into `src/orch/sync.ts`); the adapter emits one warning carrying `accountId` and `messageId`, then returns normally so the caller's loop continues.
- Union order: existing categories first, then the new names; a name repeated in `labels` collapses to one entry.
- A 401 is force-refreshed once and the whole operation replayed, mirroring `ensureCategories`.
- An empty `labels` array returns before any network call.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY | carries `["Blue"]`; predicted `["Crypto"]` | PATCH with `categories: ["Blue","Crypto"]` | N/A |
| IDEMPOTENT | carries every predicted label | **no PATCH** | N/A |
| EMPTY_SET | predicted `[]` | no API call; returns | N/A |
| SUBSUMED | predicted ⊆ existing plus unrelated ones | no PATCH; unrelated labels untouched | N/A |
| DUPLICATE_INPUT | same name twice in `labels` | listed once in the body | N/A |
| CASE_MISMATCH | existing `"crypto"`, predicted `"Crypto"` | `"Crypto"` treated as new and added | N/A |
| NOT_FOUND | 404 from the read or the PATCH | warning naming account + message id; returns so the batch continues | absorbed, never thrown |
| UNAUTHORIZED | first call 401s | token force-refreshed once, operation replayed | typed error if the replay also fails |
| API_ERROR | non-2xx other than 401/404 | typed `M365AdapterError` (`WRITE_LABELS_FAILED`, status) | thrown to the caller |
| NETWORK | `fetchFn` rejects | typed error naming the account, no thrown cause | thrown to the caller |
| MALFORMED | read body has no `categories` array | **typed error, no PATCH** | thrown — see Design Notes |

</frozen-after-approval>

## Code Map

- `src/core/ports/MailPort.ts:7` — frozen `writeLabels(accountId, messageId, labels): Promise<void>`; do not change.
- `src/adapters/m365/M365Adapter.ts:28-31` — `M365AdapterErrorCode`; gain `WRITE_LABELS_FAILED`.
- `src/adapters/m365/M365Adapter.ts:51-55` — `M365AdapterDeps`; gains `logPort` for the 404 warning.
- `src/adapters/m365/M365Adapter.ts:57-72` — `authorizationHeader`/`getRequest`/`postRequest`; add a sibling `patchRequest` (PATCH + JSON content-type) rather than overloading `postRequest`.
- `src/adapters/m365/M365Adapter.ts:92-105` — `messagesUrl(opts)` is the collection URL; build the per-message one separately as `${MESSAGES_URL}/${encodeURIComponent(messageId)}` (Graph ids carry `=`/`+`).
- `src/adapters/m365/M365Adapter.ts:107-114` — `readJsonObject`; reuse for the read.
- `src/adapters/m365/M365Adapter.ts:140-151` — `ensureCategories`; mirror its 401 forceRefresh-once-and-replay.
- `src/adapters/m365/M365Adapter.ts:294-323` — `sendGraphRequest`/`send`; the only HTTP entry points, reuse them for both calls.
- `src/adapters/m365/messageMapper.ts:26-34` — the total `readCategories` rule; share one implementation with the write path instead of copying it.
- `src/adapters/m365/M365Adapter.ts:119-121` — doc comment claiming `writeLabels` belongs to Epic 7; update once implemented.
- `tests/adapters/m365/m365-adapter.test.ts:60-105` — `jsonResponse`/`scriptedFetch`/`tokenSource` harness and the `(HAPPY)`/`(IDEMPOTENT)` test-name style to extend.
- `src/cli/commands/{backfill,cron,sync-categories}.ts` — the three `new M365Adapter({...})` sites; each must now pass `logPort`.
- Out of bounds: `src/core/**`, `src/adapters/gmail/**`, `src/orch/**`, and the shape pinned by `spec-1-2-port-interfaces-definition-per-account.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/m365/M365Adapter.ts` — add `WRITE_LABELS_FAILED` and implement `writeLabels` (read categories → union → PATCH only when something is missing) — the story's whole behaviour.
- [x] `src/adapters/m365/messageMapper.ts` — expose the existing total `categories` read so the two paths share one rule.
- [x] `tests/adapters/m365/m365-adapter.test.ts` — pin every I/O-matrix row with the existing harness — the ACs are only real if tested.
- [x] `src/cli/commands/{backfill,cron,sync-categories}.ts` — pass the log port into `M365Adapter` — the adapter now emits the 404 warning itself.

**Acceptance Criteria:**
- Given a message carrying `["Blue"]` and a predicted set `["Crypto"]`, when `writeLabels` runs, then it PATCHes that message with `categories: ["Blue","Crypto"]` and `"Blue"` survives.
- Given a message already carrying every predicted label, when `writeLabels` runs, then no PATCH is sent.
- Given Graph answers 404, when `writeLabels` runs, then a warning naming the account and message id is emitted and the method does not throw.

## Implementation Notes

## Spec Change Log

## Review Triage Log

- **false** — blind: 409/412 concurrent-modification should be absorbed. The frozen matrix explicitly routes "non-2xx other than 401/404" to a typed API_ERROR thrown to the caller, and the epic context's frozen concurrency assumption ("updates are assumed atomic; no race with the user editing in Outlook") accepts exactly this race. A 409 aborting the batch is the specified behavior.
- **false** — blind: patch-time 401 replay re-issues the redundant read GET. The frozen decision mandates exactly this ("force-refreshed once and the whole operation replayed, mirroring `ensureCategories`"); the extra GET under token-expiry bursts is the specified behavior, not a defect.
- **low** — blind: the 404 warn-and-skip block is copy-pasted verbatim in the read and PATCH paths (M365Adapter.ts, runWriteLabels). Real developer-facing drift risk (warning text/context kept in sync by hand); fix is a direct tiny extraction. → patch.
- **false** — blind: no test pins `$select=categories` on the read. Disproved: the HAPPY test's first URL assertion is exactly `${MESSAGES_URL}/${encodedId}?$select=categories` (tests/adapters/m365/m365-adapter.test.ts, HAPPY row).
- **false** — blind: MALFORMED guard contradicts `readCategories`' degrade-to-[] doc. The frozen Design Notes mandate the strict write-path guard explicitly to avoid PATCHing a stale set (user's own categories lost); the mapper's doc is accurate about the mapper, and the write path pre-checks before calling it. Two intentional policies, both per spec.
- **false** — blind: duplicate `existing` categories ship back in the PATCH body. Add-only semantics forbid removing anything already on the message — deduping existing entries would be a removal (FR-13 violation). Ship-back of unchanged entries is correct.
- **false** — blind: EMPTY_SET is indistinguishable from a no-write success. The frozen UX section: "Writes are silent on success"; an empty LabelSet is a valid no-write. Silence is the specified contract.
- **false** — blind: `NOOP_LOG_PORT` is a third divergent LogPort literal; drift would be silent. In `src/`, a LogPort change makes the structural literal fail `tsc -b` — caught by the build. The test recorder's staleness is unobservable (it only captures `warn`) and harmless.
- **false** — blind: messageId interpolated unescaped could corrupt log lines. Graph message ids are base64url-safe tokens (the code already URL-encodes the `=`/`+` they can carry); quotes or control characters are not a reachable shape, and the structured context carries the id verbatim.
- **false** — blind: no test pins that a 404 with a malformed body is absorbed. The 404 branch provably returns before any body parse (`readJsonObject` is only reached on `readResponse.ok`); the requested test guards a hypothetical refactor, not a defect.
- **low** — blind: optional `logPort` with a no-op default is a compiler-invisible footgun (a future prod call site omitting it silently drops 404 warnings) — the root cause also behind the NOOP literal duplication. Fix: make `logPort` required and delete `NOOP_LOG_PORT`. → patch (grouped with the NOOP_LOG_PORT-literal finding; same root cause, same fix).
- **false** — blind: no structural test that M365Adapter satisfies MailPort. Signature drift is compile-enforced: the CLI plans assign `new M365Adapter(...)` to `port: CategorySyncTarget` / `port: MessageFetchTarget`, so `tsc -b` fails on drift; tests/ type-skipping is irrelevant.
- **false** — edge: concurrent category addition between GET and PATCH is silently lost (full-array replace). Same frozen concurrency assumption as the 409 finding — the epic context explicitly assumes no concurrent user edit; v1 is the accepted union-PATCH design.
- **false** — edge: a failing `getAccessToken(forceRefresh)` during the 401 retry escapes as a raw error. Disproved as a new defect: `ensureCategories` (M365Adapter.ts:161-172), which the frozen decision mandates mirroring, has the byte-identical catch-and-retry shape and lets the replay error propagate the same way.
- **false** — edge: non-string/empty label members reach Graph unsanitized. Frozen Never-rule: "no taxonomy validation of the given names"; input is Epic 6's zod-validated LabelSet of taxonomy names.
- **medium** — vgap (pre-verified): the EMPTY_SET test cannot observe token acquisition — it discards `tokenSource().calls` and asserts only fetch requests, so moving token acquisition above the early return ships undetected while every empty-label message triggers a silent-refresh/credential-prompt round trip. → patch: assert `getAccessToken` is never called for `labels: []`.
- **post-patch follow-up (human-run `bun run test`)** — making `logPort` required left the 47 pre-existing `new M365Adapter({...})` constructions in this file without the now-required dep, so `bun run typecheck` (the second half of `bun run test`) failed with 47 × TS2741. Fixed with a shared `SILENT_LOG_PORT` passed at every construction; `bun run test` now exits 0 (483 passed + typecheck) across repeated runs. The 3 intermittent `tests/adapters/token/token-store.test.ts` keychain timeouts seen while diagnosing are pre-existing machine-level flakes in a file this story does not touch.

## Design Notes

The extra `GET` is deliberate: the frozen port carries no existing-label input, so the mailbox is the only authority on what a message already carries — and reading it is what makes the no-op skip possible at all. The read is otherwise total but **strict on the one field that matters**: a read body whose `categories` is not an array is a typed error, never `[]` — degrading it would PATCH a stale set and silently drop the user's own categories. That is data loss, not a cosmetic miss. Every other field degrades exactly as `messageMapper` already does.

## Verification

**Commands:**
- `mise exec node@20 -- bun run test` — vitest green and `typecheck` passing
- `mise exec node@20 -- bun run lint` — oxlint and the core external-import guard pass
- `mise exec node@20 -- bun run build` — `tsc -b` clean
