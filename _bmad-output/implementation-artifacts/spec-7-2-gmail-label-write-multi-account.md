---
title: 'Story 7.2: Gmail Label Write (Multi-Account)'
type: 'feature'
created: '2026-10-10'
status: 'in-progress'
route: 'dispatch'
baseline_commit: '3d49a0401984cc76e92dc79a434095bb53614c5a'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Classification returns a `LabelSet` of taxonomy label names, but nothing writes them back: `MailPort.writeLabels` is declared (spec-1-2) and `GmailAdapter` defers it to Epic 7 (`src/adapters/gmail/GmailAdapter.ts:336`), so Gmail messages never get their predicted labels and the Gmail UI shows nothing. The same file has also grown into a 755-line class spanning four unrelated concerns (label sync, list walk, batch hydration, history walk) — adding write-back as a fifth would deepen the monolith the Epic 6 retrospective already asked to split.

**Approach:** Split `GmailAdapter` along its four existing concerns into focused modules under `src/adapters/gmail/`, then implement `writeLabels(accountId, messageId, labels)` as a peer concern: resolve each label name to its id from the account's existing name → id cache, read the message's current `labelIds`, and `POST /gmail/v1/users/me/messages/{id}/modify` with `addLabelIds` containing only the ids not already present. No modify call when nothing is missing; a per-message 404 is a logged warning, never a batch failure.

## Boundaries & Constraints

**Always:**
- Add-only: only `addLabelIds` is ever sent; `removeLabelIds` never appears (FR-13). Existing labels are preserved by construction — Gmail applies the delta itself.
- Account-scoped: the token comes from `getAccessToken(accountId)`; labels resolve through that account's cache; no cross-account write.
- Label **names** are canonical; ids are adapter-internal, resolved from the per-account cache — never re-fetched per message (epic constraint).
- Wire detail stays in the adapter; orchestration keeps seeing `MailPort.writeLabels(accountId, messageId, labels): Promise<void>` (AD-8) and `src/core/**` is untouched (AD-10): modules under `src/adapters/gmail/` import core types only.
- Reuse the file's existing seams: the bounded `send` (typed network error, no raw cause), `postRequest`/`getRequest`, `readJsonObject`, and the `GmailAdapterError` shape `{code, accountId, status?}`.
- The public surface is preserved exactly: `ensureCategories`, `fetchMessages`, `fetchHistoryId`, `fetchHistory`, `labelIdsFor`, and the constructor's `GmailAdapterDeps` — the CLI's `CategorySyncTarget`/`MessageFetchTarget`/`GmailHistoryTarget` structural seams depend on them.
- Label names match exactly and case-sensitively (the `ensureCategories` rule).
- Every CLI `new GmailAdapter({...})` site passes the log port (the adapter now emits the 404 warning itself).

**Never:**
- No orchestration or CLI work beyond passing `logPort`: no run loop, no new command (Epic 8 drives fetch → classify → write).
- No M365 work; no 429 backoff (Epic 9); no delta/history or idempotency-store interaction.
- No label removal, no label create/rename/re-colour (that is `ensureCategories`), no taxonomy validation of the given names.
- No behaviour change to the four extracted concerns: their tests move with them unmodified apart from imports, and must stay green.

## Decisions

- **Missing cache mapping is a typed error, never a silent skip.** The epic's data landmine: `labelIdsFor(accountId)` returns `undefined` before a complete sync, and a name absent from the map can only mean the label does not exist in that mailbox. Both cases throw `GmailAdapterError("WRITE_LABELS_FAILED", accountId, …)` naming the label — a silent skip would report a message as labelled when nothing was written.
- **Existing labels are read from the mailbox.** `GET {MESSAGES_URL}/{id}?format=minimal&fields=labelIds` before deciding anything: the frozen port carries no existing-label input, and "no call when the message already has all predicted labels" means **no modify POST** — the read is what reveals there is nothing to write.
- **The read is strict on the one field that matters.** A read body whose `labelIds` is not an array is a typed error, never `[]` (degrading it would write labels the message may already carry, inflating its label set); every other field degrades as `messageMapper` already does.
- **404 is absorbed and logged.** The adapter takes the injected `LogPort` (as `M365Adapter` does since Story 7.1), emits one warning carrying `accountId` and `messageId` for a 404 from either call, and returns normally so the caller's loop continues.
- **401 is force-refreshed once and the whole operation replayed**, mirroring `ensureCategories` in this file and `writeLabels` in `M365Adapter`.
- An empty `labels` array returns before any token fetch or network call.
- **Split shape.** Sibling modules own one concern each, with the class kept as the thin facade the structural seams expect: `gmailWire.ts` (URLs, headers, request builders, bounded send, batch parsing, `readJsonObject`), `gmailLabelSync.ts` (`ensureCategories`, `listLabels`, `createLabel`), `gmailMessageFetch.ts` (`fetchMessages` list walk + batch hydration), `gmailHistory.ts` (`fetchHistoryId`, `fetchHistory`, history page parsing), `gmailLabelWrite.ts` (the new `writeLabels`), and `GmailAdapter.ts` holding only `deps`, the per-account caches, and delegation. The 1210-line `tests/adapters/gmail/gmail-adapter.test.ts` splits along the same seams, its shared harness extracted once.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY | cache has `Crypto→L2`; message carries `["L1"]` | `POST .../messages/{id}/modify` with `addLabelIds: ["L2"]` | N/A |
| IDEMPOTENT | every predicted id already on the message | **no modify POST** (the read still runs) | N/A |
| EMPTY_SET | predicted `[]` | no API call, no token fetch; returns | N/A |
| SUBSUMED | predicted id present plus unrelated existing ids | no modify POST; unrelated ids untouched | N/A |
| DUPLICATE_INPUT | same name twice in `labels` | one entry in `addLabelIds` | N/A |
| CASE_MISMATCH | cache has `crypto→L9`, predicted `Crypto` | `GmailAdapterError` naming `Crypto` (no such mapping) | typed error |
| UNCACHED_ACCOUNT | `labelIdsFor` returns `undefined` | typed error naming the account, no API call | typed error, never a silent skip |
| NOT_FOUND | 404 from the read or the modify | one warning naming account + message id; returns so the batch continues | absorbed, never thrown |
| UNAUTHORIZED | first call 401s | token force-refreshed once, operation replayed | typed error if the replay also fails |
| API_ERROR | non-2xx other than 401/404 | typed `GmailAdapterError` (`WRITE_LABELS_FAILED`, status) | thrown to the caller |
| NETWORK | `fetchFn` rejects | typed error naming the account, no thrown cause | thrown to the caller |
| MALFORMED | read body has no `labelIds` array | **typed error, no modify POST** | thrown — see Design Notes |

</frozen-after-approval>

## Code Map

- `src/adapters/gmail/GmailAdapter.ts:339-355` — the class, its two per-account caches (`labelIdsByAccount`, `returnedIdsByAccount`) and its deps; the facade that survives the split.
- `src/adapters/gmail/GmailAdapter.ts:363-381` — `ensureCategories`; the exact-match, create-only rule to mirror.
- `src/adapters/gmail/GmailAdapter.ts:383-385` — `labelIdsFor`; the read-only cache accessor write-back must use (and must not widen).
- `src/adapters/gmail/GmailAdapter.ts:387-455` — `listLabels`/`createLabel`; move to the label-sync module unchanged.
- `src/adapters/gmail/GmailAdapter.ts:457-473` — `send`; the single bounded HTTP entry point to share with write-back (add nothing that bypasses it).
- `src/adapters/gmail/GmailAdapter.ts:481-574` — `fetchMessages` list walk; move unchanged.
- `src/adapters/gmail/GmailAdapter.ts:581-754` — `fetchHistoryId`/`fetchHistory`/`fetchBatchParts`; move unchanged (batch parsing helpers go to the wire module).
- `src/adapters/gmail/GmailAdapter.ts:9-25` — the URL constants (`LABELS_URL`, `MESSAGES_URL`, `PROFILE_URL`, `HISTORY_URL`, `BATCH_URL`); the per-message URL is `${MESSAGES_URL}/${encodeURIComponent(id)}` plus `/modify` — Gmail ids carry `+`/`/`/`=`.
- `src/adapters/gmail/GmailAdapter.ts:73-79` — `GmailAdapterErrorCode`; gains `WRITE_LABELS_FAILED`.
- `src/adapters/gmail/GmailAdapter.ts:99-111` — `GmailAdapterDeps`; gains a required `logPort` (mirrors `M365AdapterDeps` after Story 7.1 — required, so a wiring site cannot silently drop the warning).
- `src/adapters/gmail/messageMapper.ts:60-65` — `readLabelIds`; the total `labelIds` rule — share one implementation with the write path instead of copying it.
- `src/adapters/m365/M365Adapter.ts:259-345` — Story 7.1's `writeLabels`, the sibling shape to mirror: empty-set guard, 401 replay, strict read, conditional write, shared 404 warning helper.
- `tests/adapters/gmail/gmail-adapter.test.ts:138-198` — `scriptedFetch`/`tokenSource`/`recordedRequest` harness and the `(HAPPY)`/`(IDEMPOTENT)` test-name style; extract once into a shared harness module, keep every existing test's assertions unchanged.
- `src/cli/commands/{backfill,cron,sync-categories}.ts` — the three `new GmailAdapter({...})` sites; each must now pass `logPort` (the three `M365Adapter` sites already do).
- Out of bounds: `src/core/**`, `src/adapters/m365/**`, `src/orch/**`, and the shape pinned by `spec-1-2-port-interfaces-definition-per-account.md`.

## Tasks & Acceptance

**Execution:**
- [ ] `src/adapters/gmail/gmailWire.ts` — extract URLs, request builders, bounded `send`, batch parsing, `readJsonObject` from `GmailAdapter.ts` — pure moves, no behaviour change.
- [ ] `src/adapters/gmail/{gmailLabelSync,gmailMessageFetch,gmailHistory}.ts` — extract the three existing concerns, tests moving with them green — the split the Epic 6 retro asked for.
- [ ] `src/adapters/gmail/gmailLabelWrite.ts` + `GmailAdapter.ts` — implement `writeLabels` (names → cached ids → read current `labelIds` → modify only when something is missing) and delegate to it — the story's whole behaviour.
- [ ] `src/adapters/gmail/messageMapper.ts` — export the existing `readLabelIds` so both paths share one rule.
- [ ] `tests/adapters/gmail/` — split the 1210-line test file along the same seams behind one shared harness, and pin every I/O-matrix row for `writeLabels` — the ACs are only real if tested.
- [ ] `src/cli/commands/{backfill,cron,sync-categories}.ts` — pass the log port into `GmailAdapter`.

**Acceptance Criteria:**
- Given an account whose cache maps `Crypto→L2` and a message carrying `["L1"]`, when `writeLabels` runs, then it POSTs `modify` with `addLabelIds: ["L2"]` and sends no `removeLabelIds`.
- Given a message already carrying every predicted label id, when `writeLabels` runs, then no `modify` POST is sent.
- Given an account with no complete label sync (or a name with no cached id), when `writeLabels` runs, then it throws a typed error naming the account and label instead of skipping.
- Given Gmail answers 404, when `writeLabels` runs, then a warning naming the account and message id is emitted and the method does not throw.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

Gmail's `messages.modify` is already an add-only delta — the union M365 needs is done server-side here. The read before the write is therefore not about correctness of the merge but about the skip: the frozen constraint says a message that already carries every predicted label must cost no write call, and the frozen port carries no existing-label input, so the mailbox is the only authority on what is already there. The read is strict about `labelIds` being an array for the same reason M365's is: a `[]` fallback would silently re-add labels and report a write that never happened.

The case-mismatch row is deliberately an error rather than a second add: Gmail label names are unique per account and the cache is keyed by the exact taxonomy name, so a name with no mapping means the taxonomy changed since the last sync (or the sync was partial) — writing the wrong id is worse than failing the one message.

## Verification

**Commands:**
- `mise exec node@20 -- bun run test` — vitest green and `typecheck` passing
- `mise exec node@20 -- bun run lint` — oxlint and the core external-import guard pass
- `mise exec node@20 -- bun run build` — `tsc -b` clean
