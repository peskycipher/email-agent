---
title: 'Gmail Incremental Message Fetch (Cron, Multi-Account, with History-Expiry Fallback)'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-3-gmail-backfill-message-fetch-multi-account.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-2-m365-incremental-message-fetch-cron-multi-account.md'
baseline_commit: '9273aca'
# Attempt 1 was planned from d58d6c9c69f032092a8a0b0c4a13b5484146dc8a and reverted; this re-derivation starts at the story-5.3 review patch commit above. (Original baseline preserved in Implementation Notes.)
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `--cron --source gmail` is rejected outright (`src/cli/dispatch.ts:57`) and `GmailAdapter` can only walk a whole label — nothing reads `users.history.list`, and no per-account `lastHistoryId` is ever written, so a recurring Gmail run would re-walk the whole INBOX every cycle. Story 5.4 is the last story of Epic 5.

**Approach:** teach `GmailAdapter` the two Gmail calls this needs — `users.getProfile` (the mailbox's current `historyId`) and `users.history.list` (`startHistoryId`, `labelId`, page tokens), whose `messagesAdded` ids are hydrated through the existing batch endpoint — persist `lastHistoryId` in the per-provider cursor file `state/<provider>-<name>.json` (decision EC2/2-A, 2026-10-09), and extend the incremental orchestrator with a Gmail path: history walk when a history id is stored, a `warn` + label-list fallback when Gmail reports the history expired, and the new history id recorded only after a successful cycle. Lift `--source gmail` for `--cron`.

## Boundaries & Constraints

**Always:**
- History-expired is a **warn**, never a silent skip and never a crash: one warning-level line names the account, then the cycle falls back to the label list.
- Only `messagesAdded` entries are hydrated — `labelsAdded` / `labelsRemoved` records belong to Epic 7's write-back, not to fetch.
- A cycle records `lastHistoryId` **only after** that account's fetch succeeded — the same "a failed cycle leaves state untouched" rule Story 5.2 set for `lastRunTimestamp`.
- On a list-path cycle (first run or expiry fallback) the history id recorded is the one read from `users.getProfile` **before** that cycle's walk, so a message arriving mid-cycle is picked up next run rather than lost.
- A Gmail cycle records **both** `lastHistoryId` and the cycle-start `lastRunTimestamp`; that timestamp is what bounds an expiry fallback's list walk.
- The Gmail history walk and its expiry fallback both scope to **`INBOX`** (the epic's wording); a configured `labels` list does not widen the cron window.
- With no stored `lastHistoryId` (first run), the profile history id is read first and the whole INBOX is then walked — a mailbox is never silently skipped.
- The expiry signal is a **404** from `users.history.list` — Gmail's documented response for a `startHistoryId` that is too old. It is a normal outcome, not an error.
- `lastHistoryId` on the history path is the history response's top-level `historyId`.
- State is written read-merge-write at 0700 dir / 0600 file through `stateFile.ts`'s existing helpers and account-name assertion — never hand-rolled.
- A hydrated id whose batch part answers **404** is a purged message's answer, not the account's failure: that id is skipped with a **warn naming the id**, and the cycle still succeeds and records state (EC1, human decision 2026-10-09).
- Per-provider state files: m365 state lives at `state/m365-<name>.json`, Gmail's at `state/gmail-<name>.json` (EC2, human decision 2026-10-09), so same-named accounts across providers never share a file. A legacy `state/<name>.json` written by Stories 5.1/5.2 is read back (m365 only) and never written again.
- The expiry fallback's lower bound reaches the wire: a `since` bound becomes `q=after:<epoch-seconds>` on the Gmail list URL, stepped back one second because `after:` is exclusive (human decision 2026-10-09).
- `orch` imports only `core`: the history seam is an interface `GmailAdapter` satisfies structurally, mirroring `MessageFetchTarget` (`src/orch/fetch.ts:6`).
- One account's failure is logged with its `accountId` and never aborts the others; accounts are processed sequentially.

**Never:**
- No change to `fetchMessages`' label-list path beyond the sanctioned `since` → `q=after:` bound (a backfill or first-run URL carries no `since` and stays byte-identical); no change to `M365Adapter` or to `FetchOpts` (`src/core/dto/FetchOpts.ts:1`).
- No `--source all` for `--cron` (Story 8.3 owns the multi-provider loop); no process-level lock (Epic 8/9 — keep Story 5.2's `ponytail:` ceiling note); no rate-limit/backoff (Epic 9); no classification or label write-back (Epics 6/7).
- Never treat a 404 as "no new mail", and never complete a cycle without recording a history id.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_HISTORY | state `{"lastHistoryId":"H1"}`; history 200 naming 2 added ids; batch returns both | 2 DTOs; state `lastHistoryId` advances to the response's `historyId` | N/A |
| HISTORY_PAGED | history page 1 carries `nextPageToken`, page 2 is final | every page's added ids hydrated exactly once | N/A |
| HISTORY_EMPTY | history 200 with no `history` array | 0 fetched; state still advances to the response's `historyId` | N/A |
| HISTORY_EXPIRED | history 404; `lastRunTimestamp` present | `warn` naming the account; INBOX list walked `since` that instant; state advances to the pre-walk profile id | warned, not failed |
| HISTORY_MALFORMED | history 200 but `history` is not an array, or a record has no `id` | account failed, no state write | typed `LIST_HISTORY_FAILED` |
| FIRST_RUN_NO_STATE | no state file for the account | profile id read first, then the full INBOX walk; state gets both `lastHistoryId` and a `lastRunTimestamp` | N/A |
| PROFILE_FAIL | `users.getProfile` non-2xx (first run or fallback) | account failed, no state write | typed `GET_PROFILE_FAILED` |
| BATCH_FAIL | history ok; a batchGet POST is non-2xx | account failed, `lastHistoryId` untouched | typed `BATCH_GET_MESSAGES_FAILED` |
| PART_DELETED | history 200 naming id X; X's batch part answers 404 (the message was purged after it was added) | X skipped with a warn naming it; the other messages fetched; the cycle succeeds and records state | warned, not failed |
| STATE_READ_FAIL | state file unparseable or wrongly typed | account failed, logged, other accounts continue | typed `STATE_INVALID` |
| STATE_WRITE_FAIL | fetch ok; the state write fails | messages counted; account counted failed; previous state kept | typed `STATE_WRITE_FAILED` |
| MULTI_ACCOUNT | two gmail accounts; the first fails | the second still fetches; exit code 1 | per-account log line |
| NO_ACCOUNTS | no enabled gmail accounts | gmail no-accounts hint, exit 1, no request | N/A |
| INVALID_SETTINGS | one gmail account's settings file is invalid | counted failure line; the valid accounts still run | listed error |
| SOURCE_ALL | `--cron --source all` | one error line, exit 1 | typed error command |
| ADAPTER_URLS | history and profile requests | exact request URLs (encoded `startHistoryId`/`labelId`/`pageToken`) asserted | N/A |

</frozen-after-approval>

## Code Map

- `src/adapters/gmail/GmailAdapter.ts` -- the only file needing new provider calls: add `fetchHistoryId` (`GET /gmail/v1/users/me/profile`) and `fetchHistory` (`GET /gmail/v1/users/me/history`) beside `fetchMessages` (L362) / `fetchBatch` (L432). Reuse `send` (L338), `getRequest` (L92), `clampBatchSize` (L106), `readString`/`readJsonObject` (L200/L206) and the `GmailAdapterErrorCode` union (L47). Keep `messagesListUrl` (L115) for the fallback path.
- `src/adapters/gmail/accountSettings.ts` -- `listEnabledAccounts`, `labels`, `batchSize` already exist and are validated; no schema change expected.
- `src/adapters/config/stateFile.ts` -- `AccountState.lastHistoryId` (L36) and `readIdField` (L88) already exist; add `writeLastHistoryId` beside `writeLastRunTimestamp` (L145) using the same read-merge-write/chmod body. Do not duplicate the write body — extend it. The file name becomes `<provider>-<name>.json` (`StateFileOptions.provider`, defaulting to m365 so the 5.1/5.2 callers keep working), with the legacy `<name>.json` read back only for m365 when the namespaced file is absent.
- `src/orch/incremental.ts` -- `fetchIncremental` (L66) gains the Gmail branch; `toPlan` (L48) already folds `since`, `FetchIncrementalOptions` (L23) already takes `source`. Declare the history seam here (type + interface), and keep `IncrementalAccountState` read-only for the new key.
- `src/orch/fetch.ts` -- `fetchAllMessages` (L56) is reused unchanged for the label-list/fallback path.
- `src/cli/commands/cron.ts` -- today m365-only: `planFor` (L42) and `runCron` (L58) hard-wire `M365AuthAdapter`/`M365Adapter`/`listM365Accounts`. Mirror `src/cli/commands/backfill.ts`'s `FetchProviderPlan` (L54) to parameterise the provider, its listing, its port and its state seams.
- `src/cli/dispatch.ts` -- `resolveCron` (L49): the `gmail`/`all` rejection at L57-63 becomes a `gmail` accept with `all` still rejected; update the message.
- `src/cli/index.ts` -- `--source`'s help text for `--cron` must stop calling Gmail a future story.
- `tests/adapters/gmail/gmail-adapter.test.ts`, `tests/adapters/config/state-file.test.ts`, `tests/orch/incremental.test.ts`, `tests/cli/cron.test.ts` -- the matrix rows; the gmail adapter tests stay stdlib-mock only (no SDK import, oxlint-enforced).
- `## Review Triage Log` (below) -- the Story 5.4 review's verdicts; the low rows routed to patch (BH1/2/4/5/6/7/8/9/11/15) are re-derivation constraints: the comment corrections, the writer's non-empty guard, the state-file and orchestrator/CLI test additions, and the `--help` sentence.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/gmail/GmailAdapter.ts` -- add `fetchHistoryId` and `fetchHistory`; return the new history id plus hydrated DTOs, signal expiry as an outcome (not an error), add `GET_PROFILE_FAILED`/`LIST_HISTORY_FAILED`; skip a hydrating id whose part answers 404 with a warn naming the id -- the adapter is the only place that knows Gmail's wire shapes, including a purged message's answer.
- [x] `src/adapters/config/stateFile.ts` -- namespace the file per provider (`m365-<name>.json` / `gmail-<name>.json`) with the legacy `<name>.json` read fallback for m365 only, and add `writeLastHistoryId` reusing the existing merge and permission body -- so same-named accounts across providers never share a cursor file and Gmail's state rules cannot drift from M365's.
- [x] `src/orch/incremental.ts` -- declare the history seam and add the Gmail branch (stored id → history; no id → profile + full walk; expired → warn + list fallback; on success record `lastHistoryId` and the cycle-start `lastRunTimestamp`) -- one orchestrator keeps the never-miss rules in one place.
- [x] `src/cli/commands/cron.ts` -- parameterise the provider the way `backfill.ts` does and pass the gmail read/write state seams with the gmail provider namespace -- `--cron` must drive both providers through the same loop without a shared cursor file.
- [x] `src/cli/dispatch.ts` and `src/cli/index.ts` -- accept `--source gmail` for `--cron`, keep `all` rejected, fix the help text (including that the cron window is INBOX) -- the flag is the story's user-visible surface.
- [x] `tests/**` -- cover every row of the I/O matrix above, including the warn lines and the exact request URLs -- the never-miss and no-silent-skip guarantees are the whole point of the story; honor the Review Triage Log's patch rows (BH1/2/4/5/6/7/8/9/11/15) while re-deriving.

**Acceptance Criteria:**
- Given a gmail account whose state holds a `lastHistoryId` and whose mailbox has one new message, when `--cron --source gmail --account <name>` runs, then only that message is fetched and `state/<name>.json` advances both `lastHistoryId` and `lastRunTimestamp`.
- Given Gmail answers `users.history.list` with 404, when the cycle runs, then a warning-level line names the account and the cycle still fetches that account's INBOX — no crash, no silent skip, and the exit code reflects success.
- Given a history walk whose hydration answers 404 for one purged message, when the cycle runs, then that id is skipped with a warning naming it, the remaining messages are fetched, the exit code is 0, and the account's state still advances.
- Given an m365 account and a gmail account that share a name, when each provider's `--cron --source <provider>` runs, then each reads and writes only its own `state/<provider>-<name>.json` and neither provider's cursor can move the other's.
- Given a fetch failure for one account, when the command runs, then the other accounts still fetch and the failed account's stored state is unchanged.
- Given no enabled gmail accounts, when `--cron --source gmail --account all` runs, then the gmail hint is printed, no request is attempted, and the exit code is 1.

## Implementation Notes

- **2026-10-09 — loopback 1.** The first implementation (12 files, +1489/−92, 351 tests green from baseline `d58d6c9c69f032092a8a0b0c4a13b5484146dc8a`) was **reverted** for the two intent gaps recorded in the Review Triage Log (EC1 deleted-message policy, EC2 shared state file); its full diff is preserved at `/tmp/bmad-build-5-4-diff-final.patch`. **KEEP — what the re-derivation must reproduce:** the `fetchHistoryId`/`fetchHistory` adapter shape (`{ kind: "ok" | "expired" }` outcome with 404-only expiry, page-token and repeated-token guards, cross-page id de-dup, `messagesAdded`-only hydration through `fetchBatch`); the extracted `writeMergedState` body; the `GmailIncrementalSeam` bundle (history calls + `writeLastHistoryId`, thrown on when `source: "gmail"` runs without it); the pre-walk profile-id recording; the INBOX-only cron window with the backfill `labels` key dropped; the `since → q=after:<epoch-seconds>` bound; and the test layout pinned by the matrix rows.
- **2026-10-09 — loopback 1 re-derivation.** From baseline `9273aca` (the story-5.3 second-pass review patches; attempt 1 was planned from `d58d6c9c69f032092a8a0b0c4a13b5484146dc8a` and reverted). 13 files, +2005/−147. `bun run build`/`lint`/`test` green — 22 files / **370 tests** (baseline 315); no SDK imports. Both review decisions are in: `fetchBatchParts` tolerates a 404 part **only** in the history walk (`allowPurged`), naming each skipped id in `skippedIds` for the orchestrator's per-id warn (EC1), and state files are provider-namespaced `m365-<name>.json` / `gmail-<name>.json` with `StateFileOptions.provider` (default m365, so 5.1/5.2 callers are unchanged) plus the legacy `<name>.json` read back for m365 only and never written again (EC2). The expiry fallback's bound now reaches the wire (`q=after:`), correcting attempt 1's stale comment; the missing-seam guard is hoisted above the account loop (BH9); `--help` states the INBOX-only gmail window (BH11); `FetchOpts.since` documents both providers' bound semantics (BH15). A same-name cross-provider CLI test pins EC2 end-to-end.
- **2026-10-09 — attempt 1 (superseded by the loopback):** implemented from baseline `d58d6c9c69f032092a8a0b0c4a13b5484146dc8a` (12 files, +1489/−92). `bun run build` / `bun run lint` / `bun run test` all green — 22 files / 351 tests (baseline 315).

- **The frozen Always-vs-Never contradiction was resolved by human decision (2026-10-09).** *Always* required "that timestamp is what bounds an expiry fallback's list walk"; *Never* forbade changing `fetchMessages`' existing label-list path, and the Code Map said "keep `messagesListUrl` for the fallback path". The first implementation folded `since` into the walk's plan but Gmail's list URL applied no filter, so an expiry fallback re-read the whole INBOX. The human chose the *Always* reading: `messagesListUrl` now adds `q=after:<epoch-seconds>` **only when `since` is set**, leaving the backfill (and first-run) URL byte-identical while genuinely bounding the fallback. `after:` is exclusive, so the bound steps back one second — the message sitting exactly on the recorded instant is never dropped. Pinned by the `BOUND` adapter row and the CLI `HISTORY_EXPIRED` URL assertion.
- A Gmail cycle writes two keys as two read-merge-writes (`lastHistoryId`, then the cycle start). If the second fails the cursor has already advanced — safe (the next history walk re-covers the window) and counted as an account failure, but not atomic. Story 5.2's no-lock ceiling stands.
- `GmailIncrementalSeam` bundles the provider calls with `writeLastHistoryId`, so the Gmail half cannot be half-wired; `fetchIncremental` throws (a wiring bug, not a per-account failure) when `source: "gmail"` arrives without it.
- The Gmail cron window is `INBOX` only: the CLI's gmail `planFor` deliberately drops the backfill-only `labels` key, pinned by the `FIRST_RUN_NO_STATE` CLI row.
- No live Gmail call is possible here (no credentials), so the wire shapes are verified against the mocked `FetchLike` only. `graft build` was refreshed.

## Spec Change Log

## Review Triage Log

<!-- 2026-10-09 — Story 5.4's first review pass: Blind Hunter (17 findings), Edge Case Hunter (3), Verification Gap (none). One verdict per finding, rendered before grouping. Patches were mooted by the loopback; they are recorded so the re-derivation honors them. -->

- **BH1** `src/orch/incremental.ts:154` — low — The comment still claims "Story 5.3's list URL applies no time filter, so the fallback re-reads the INBOX" while the diff adds exactly that filter from `opts.since`: a false statement on the story's load-bearing never-miss seam.
- **BH2** `src/adapters/config/stateFile.ts:31` — low — The ownership doc ("M365 owns `lastRunTimestamp` … Gmail owns `lastHistoryId`") is stale after decision 2-A: a Gmail cycle now writes both keys, so the framing contradicts the code.
- **BH3** `src/orch/incremental.ts:78` / `src/adapters/gmail/GmailAdapter.ts:162` — low, rejected — `GMAIL_INBOX` and `DEFAULT_LABEL` both spell "INBOX" untied, but both name a Gmail system label that will not change and the fix (a shared core export) crosses AD-10 for speculative divergence; the window is named in both comments.
- **BH4** `src/cli/commands/cron.ts:123` — low — The comment says "the orchestrator names the label" while `historyUrl` hardcodes `DEFAULT_LABEL` in the adapter; the attribution is simply wrong.
- **BH5** `src/adapters/config/stateFile.ts:184` — low — `writeLastHistoryId` persists any string including `""`, which its own reader (`readIdField`) then rejects — poisoning `readAccountState` for every later cycle; a non-empty guard restores writer/reader symmetry.
- **BH6** `tests/adapters/config/state-file.test.ts:175` — low — The directory-escape pin names `readAccountState`/`writeLastRunTimestamp` but not the new `writeLastHistoryId`, so the new writer's `assertAccountName` path is the one unpinned of the three.
- **BH7** `tests/orch/incremental.test.ts` — low — The state pair "`lastRunTimestamp` without `lastHistoryId`" (the post-partial-write shape, and the cross-provider shape) is never exercised; only the empty state and the full pair are.
- **BH8** `tests/orch/incremental.test.ts` (STATE_WRITE_FAIL) — low — Only the id-write-fails-first ordering is pinned; the reverse (id recorded, then the timestamp write fails) is documented in the notes but has no test.
- **BH9** `src/orch/incremental.ts:239` — low — The missing-seam guard throws inside the account loop, after a state read and without logging, contradicting the docstring that promises every failure is logged with its `accountId`; hoisting it above the loop fixes both.
- **BH10** `src/cli/commands/backfill.ts` / `cron.ts` — low, rejected — The listing types and hint helper are duplicated across the two temporary commands; the one named divergence (`labels`) is the deliberate INBOX-only cron decision, and the remainder is spec-approved mirroring that Epic 11's DI replaces.
- **BH11** `src/cli/index.ts:22` — low — `--help` says nothing about the cron window being INBOX-only, so a user who configured `labels:` for backfill reasonably expects cron to honor them.
- **BH12** `tests/cli/cron.test.ts:127` — false — Refuted: the multipart fixture's constant `Content-ID` cannot hide a part-collapsing regression, because a collapse leaves unfilled slots (`messages.some(undefined)` throws) and the adapter's exact-id and pinned-body assertions constrain the mapping.
- **BH13** `src/adapters/gmail/GmailAdapter.ts:290` — false — Requiring an `id` on every history record is the approved matrix row HISTORY_MALFORMED verbatim; a record without one is a contract-violating response, and loudly failing is the story's stance.
- **BH14** `src/adapters/gmail/GmailAdapter.ts:159` — low, rejected — No `historyTypes`/`maxResults` narrowing is an efficiency question (Epic 9 owns volume), not correctness; the fix adds a parameter and changes wire behavior without a demonstrated problem.
- **BH15** `src/core/dto/FetchOpts.ts:4` — low — The shared `since` field means an inclusive m365 `$filter` bound and a stepped-back exclusive Gmail `after:` bound, discoverable only by reading two adapters; one line on the declaration settles it.
- **BH16** `src/adapters/gmail/GmailAdapter.ts:148` — false — `q=after:NaN` needs an Invalid Date; every `since` is built from `readTimestampField`-validated ISO (or valid test literals), which is the named guard, so the wire value is never NaN.
- **BH17** `src/cli/commands/cron.ts:100` — low, rejected — Building both providers' auth adapters per run is constructor-only (no I/O) and `plans[options.source]` is type-guaranteed at the dispatch boundary, so neither named harm is reachable; the lazy-selection rewrite is cosmetic.
- **EC1** `src/adapters/gmail/GmailAdapter.ts:617` — **high** — A message added and purged between two runs leaves a `messagesAdded` id with no message; that batch part answers 404, `fetchBatch` treats every non-2xx part as an account failure, so the cursor never advances and every subsequent run re-walks the same window and fails again until history expiry (~a week) heals it through the fallback — one quick purge bricks a healthy mailbox's cron for days. The frozen matrix pins POST-level failures but never the deleted-message case, and at least two defensible policies exist (skip-tolerant part handling, tolerate only when a `messagesDeleted` record covers the id, keep failing loudly).
- **EC2** `src/orch/incremental.ts:115` — **medium** — State is keyed by account name only, so an m365 and a gmail account sharing a name share one state file; the Gmail cycle's `lastRunTimestamp` write (this story's new behavior, decision 2-A) then becomes the m365 cycle's bound and silently skips everything since Gmail's last run — the never-miss invariant broken in the other provider. The fix shape (provider-namespaced files, provider-owned keys, or enforced name uniqueness) is an intent-level choice.
- **VG1** — Verification Gap — none: every behavioral surface traced to a running, asserting test at a boundary that would fail on the corresponding regression; no `.skip`/`.only`/`.todo` in any changed test file; barrel exports are compiler-resolved.

<!-- 2026-10-09 — second review pass (over the loopback re-derivation). Layers: Blind Hunter 13, Edge Case Hunter 4, Verification Gap 2 (+1), Acceptance Auditor 5. Three carries against attempt-1's rows; the rest below. -->

- **BH-c1** `src/cli/commands/cron.ts` — low, carried-rejected — attempt-1's BH17 row: building both providers' plans per run is constructor-only (no I/O) and `source` is type-guaranteed at the dispatch boundary; no reachable harm.
- **BH-c2** `src/orch/incremental.ts:78` — low, carried-rejected — attempt-1's BH3 row: the INBOX window's three spellings are pinned together by the expiry test's URL assertions (`labelId=INBOX` on the history walk and `labelIds=INBOX` on its fallback, asserted in one run); a shared source would cross AD-10 for a stable Gmail system label.
- **ECH-c1** `src/orch/incremental.ts:162` — false, carried-false — attempt-1's BH16 row: every `lastRunTimestamp` is built by `readTimestampField` from a strictly-validated ISO string, so an Invalid Date cannot reach the `q=after:` computation through the real reader; only an injected test seam could produce one.
- **BH1** `src/adapters/gmail/GmailAdapter.ts` — medium — after the `fetchBatchParts` refactor the private `fetchBatch` wrapper has **zero callers** (the label walk calls the parts function directly), and the wrapper's own docstring still names itself as the shared entry; dead code with a false comment on a story-central seam.
- **BH2** `src/adapters/config/stateFile.ts` — low — the new `stateFileDisplayPath` doc claims it is "the only file an error names, since only that file is ever written", while `displayPathForFile` exists precisely so a legacy-file READ error can name `state/<name>.json`; the comment contradicts code added in the same diff.
- **BH3** `src/adapters/config/stateFile.ts` — medium — the Gmail-specific `writeLastHistoryId` inherits `provider ?? "m365"`, so a future caller omitting the option writes a Gmail cursor into `m365-<name>.json`, where the Gmail reader never looks; the m365 default is right for the generic options object but wrong for this writer.
- **ECH1/VGo1** `src/adapters/gmail/GmailAdapter.ts` — low — the purged-404 skip branch lacks the success path's `settled` guard and its Content-ID requirement: two 404 parts on one index double-push the id (double warn), and a Content-ID-less 404 part would absorb a positional id — both malformed-response shapes the success path already rejects.
- **ECH2** `src/adapters/gmail/GmailAdapter.ts` — medium — the history walk reads `nextPageToken` through `readString`, so a present-but-non-string/unusable token silently **ends the walk** and the cursor advances past messages the walk never traversed — the exact class just fixed on the list path; the frozen partial-walk rule applies to history too.
- **BH4** `src/orch/incremental.ts` — low — `fetchHistory` buffers every history page's ids before issuing any hydration batch, and only a repeated token bounds paging; no demonstrated harm at Gmail's id-string sizes, and the per-page restructure is a behavior change for it — rejected as an optimization for Epic 9's volume work.
- **BH5** `src/orch/incremental.ts:29` — low, rejected — `GmailHistoryOutcome` is declared twice (adapter/orch) with parallel docstrings, but that is the repo's structural-seam pattern (`MessageFetchTarget` likewise); moving a Gmail-specific union into provider-agnostic `core` would be the worse trade.
- **BH6** `src/cli/commands/cron.ts` — low, rejected — a gmail yaml carrying `folders:` is silently dropped with no stderr note; `folders` is not a Gmail key (m365's), the gmail schema tolerates unknown keys, and the fix spans the config-reading layer's error policy — an Epic 11 config-validation concern.
- **BH7** `tests/adapters/config/state-file.test.ts` — low — the malformed-legacy-file path (the legacy `<name>.json` read when the namespaced file is absent) is unexercised: a corrupted 5.2 cursor could read as empty state and re-walk the mailbox instead of throwing `STATE_INVALID`. Verification-gap pre-verified.
- **BH8/VG1** `tests/orch/incremental.test.ts` — medium — no test drives a **failed Gmail list-path walk** (profile ok, INBOX fetch failing): a regression recording state unconditionally there would advance both keys past a failed window and exit 0 — the most data-sensitive branch of the fallback. Verification-gap pre-verified (mutation: the guard's removal keeps all 370 green).
- **BH9** `tests/adapters/gmail/gmail-adapter.test.ts` — low — the PROFILE_FAIL matrix row's "or fallback" half is only indirectly covered; the fallback shares `fetchGmailListPath` with the directly-pinned first-run path, so a dedicated expired-then-profile-fail test would duplicate it — rejected as redundant.
- **BH10** `tests/cli/cron.test.ts` — low, rejected — the CLI suite re-declares its own multipart/url builders, which is that suite's established self-containment pattern (the backfill tests have their own too).
- **BH11** `src/adapters/gmail/GmailAdapter.ts` — low — `stateFileName`'s docstring says "given injectable options" while the signature takes `provider` explicitly; comment drift.
- **BH12** `src/orch/incremental.ts` — low — a `gmail` seam passed with `source: "m365"` is silently ignored; noted as wiring hygiene, not thrown on — rejected (over-guarding the seam would add a third guard for a call shape the CLI never makes).
- **AA1** `src/core/dto/FetchOpts.ts` — low — the comment-only change to `FetchOpts` literally contradicts the frozen Never; it was triage-sanctioned (attempt-1's BH15 patch row, listed in the approved re-derivation constraints), so the finding's only fix is a frozen-text edit — rejected per the rule; the sanction stands recorded here.
- **AA2** `src/adapters/gmail/GmailAdapter.ts` — low — the 404-skip never verifies the skipped id the way success parts verify theirs; with the Content-ID requirement added (ECH1's patch) a nameless/mismatched 404 part fails loudly instead of absorbing the wrong id, closing the asymmetry.
- **AA3** — same dead-code finding as BH1 (one entry).
- **AA4** `tests/orch/incremental.test.ts` — low — PROFILE_FAIL "first run or fallback": fallback coverage is by shared-code construction; see BH9.
- **ECH4/claim** `spec-5-4 ## Intent` — the frozen Intent still said `state/<accountName>.json` while the same frozen block's EC2/2-A decision says `state/<provider>-<name>.json`; the human's explicit 2026-10-09 decision resolves it to one possible reading, so the Intent's stale path reference was aligned to it (recorded in the Spec Change Log).

## Design Notes

- **`users.getProfile` is load-bearing.** `users.messages.list` returns no history id, so a cycle that walks the list (first run, or the expiry fallback) has nothing to store unless it reads `profile.historyId`. Read it **before** the walk: the id then predates everything the walk sees, so a message arriving mid-cycle is re-fetched next run — the same pre-fetch-clock rule Story 5.2 uses for `lastRunTimestamp`.
- **Expiry is a 404, and it is not an error.** Gmail documents HTTP 404 for a `startHistoryId` that has aged out (~a week of cron idle). The adapter returns `{ kind: "expired" }`; the orchestrator warns and re-walks. Anything else non-2xx stays a typed error.
- **AD-10 seam, structurally satisfied.** The orchestrator declares what it needs; the adapter never imports `orch`:
  ```ts
  export type GmailHistoryOutcome =
    | { kind: "ok"; messages: MessageDTO[]; historyId: string }
    | { kind: "expired" };
  export interface GmailHistoryTarget {
    fetchHistory(opts: { accountId: string; historyId: string; batchSize?: number }): Promise<GmailHistoryOutcome>;
  }
  ```
- **Reuse, don't re-derive.** The batch hydration, the page-token guard, the id-less-entry error and the label/url encoding all already exist in `GmailAdapter` (Story 5.3) — the history walk feeds the same `fetchBatch`.
- **Ceiling kept from 5.2:** no lock around the state read-merge-write; a concurrent runner arrives with Story 8.3, and the upgrade path is a lock file held around a cycle (Epic 8/9).
- **Per-provider state files (EC2).** `state/<provider>-<name>.json` is the cursor file's name for both providers; the legacy `state/<name>.json` that Stories 5.1/5.2 wrote is read back (m365 only) when the namespaced file is absent and is never written again — 5.2's cursors survive the upgrade with no migration step, and a Gmail cycle can never touch an m365 account's bound.
- **A purged message is a per-message answer (EC1).** Gmail keeps the history record of a message it later purged inside the walked window; hydrating that id answers 404. That id is skipped with a warn naming it — the message cannot be fetched, so failing the whole cycle (and re-failing every run until history expiry) would aim the never-miss invariant at a message that no longer exists. POST-level failures and other malformed parts still fail the account.

## Verification

**Commands:**
- `mise exec node@20 -- bun run build` -- expected: exit 0.
- `mise exec node@20 -- bun run lint` -- expected: exit 0 (AD-10 and the stdlib-only `tests/adapters/**` rule both apply).
- `mise exec node@20 -- bun run test` -- expected: exit 0, every I/O-matrix row covered.
- `grep -rn "from \"googleapis" src tests` -- expected: no matches.

**Manual checks:**
- `HOME=$(mktemp -d) mise exec node@20 -- node dist/cli/index.js --cron --source gmail --account all` -- expected: the gmail no-enabled-accounts hint, exit 1, no request.
- `mise exec node@20 -- node dist/cli/index.js --help` -- expected: `--cron` documented with `--source gmail`.
- No live Gmail call is possible here (no credentials); say so in the implementation notes.
