---
title: 'Story 4.3: Gmail Label Sync (Multi-Account)'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: '86bbd615664f089d465b909a9ebd634c4925b33a'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The taxonomy reaches M365 (Story 4.2) but not Gmail. There is no `GmailAdapter`, so no Gmail label exists for a classification to be written into (Epic 7), the labels never appear in Gmail, and Epic 7 has no name → label-ID map to write with.

**Approach:** Add `GmailAdapter.ensureCategories(accountId, labels)` — list the account's labels, create only the missing ones by exact `name`, and keep a per-account name → label-ID map for write-back — and reuse Story 4.2's `syncCategories` loop unchanged, because the Gmail adapter satisfies the same `CategorySyncTarget` seam. Plain `fetch` behind Story 3.1's `getAccessToken`; no SDK.

## Boundaries & Constraints

**Always:**
- List the account's labels first with `GET https://gmail.googleapis.com/gmail/v1/users/me/labels`, then create only the labels whose `name` is absent — exact, case-sensitive match. Re-running against an already-synced account creates nothing.
- Every created label carries the taxonomy's `name` as Gmail's `name`. **Colours (human decision, 2026-10-09):** Google allows only a fixed palette, so the create body carries the palette colour nearest to `label.gmailColor` as `color.backgroundColor` (chosen by squared-RGB distance over the documented palette — computed, never tabled), plus an allowed `color.textColor` of `#ffffff` on a dark background or `#000000` on a light one, by the background's relative luminance.
- Populate a per-account `Map<label name, label id>` — ids taken from the list for labels that already existed and from each create response for the rest — and keep it readable for Epic 7's write-back (`labelIdsFor(accountId)`); `ensureCategories` also returns it so a caller need not hold the adapter.
- The adapter takes injected deps exactly like Story 4.2's (`fetchFn`, the `getAccessToken` seam), so `tests/**` stay stdlib-only: no `googleapis` import anywhere in `src/` or `tests/`.
- Per-account isolation stays the orchestrator's, unchanged: a failing account is logged with its `accountId` and never blocks the others.
- Errors are typed at the adapter boundary, name the account and the status, and never carry Gmail's payload or the thrown cause.
- Nothing is ever deleted or renamed in Gmail: an existing label keeps its name and colour, and a label dropped from the taxonomy simply stops being created.
- **CLI surface (human decision, 2026-10-09):** the temporary `--sync-categories` command ensures M365 master categories *and* Gmail labels for the selected accounts; a named account is resolved against both providers' enabled listings rather than gaining a new provider flag.
- AD-10: `core` untouched; adapters import only `core`; `orch` imports only `core` ports/DTOs; `cli` wires all. Relative imports carry explicit `.js`.

**Never:**
- No `googleapis` and no `gmail-client.ts` — the SDK's message/label write work is Epic 5/7's; this story is two plain REST calls.
- No retry, backoff or rate-limit handling (Epic 9), no pagination walk (Gmail's label list has no page token), and no `users.messages` calls.
- No `MailPort` conformance for `fetchMessages`/`writeLabels` (Epic 5/7) and no method that only throws.
- No DI container, no `main.ts`, no `Config`/`ConfigLoader`, no startup wiring — Epic 11 owns those.
- No taxonomy loading/validation work (4.1) and no change to the M365 adapter's behaviour (4.2) beyond the shared orchestrator.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY | account with no matching labels | one POST per taxonomy label carrying its `name` | N/A |
| IDEMPOTENT | every label already exists | the list is read once and nothing is POSTed | N/A |
| PARTIAL | some labels exist | only the absent ones are created; existing ones untouched | N/A |
| CACHE | after a sync, for both new and pre-existing labels | `labelIdsFor(account)` maps all 11 names to their ids | N/A |
| SLASH_NAME | `Family/Friends` and `Waiting/Follow-up` | created verbatim; Gmail renders them nested and no parent label is needed | N/A |
| COLOUR | a label with `gmailColor: #E67C73`, which is not an allowed value | the create body carries `color.backgroundColor` = the nearest allowed colour and a contrasting allowed `color.textColor` | N/A |
| AUTH | the token seam throws for one account | that account is reported and skipped; the others still sync | logged with `accountId`; counted as a failure |
| API_ERROR | the list or a create returns non-2xx | the account is reported and skipped | typed error naming the account and status; never the raw body |
| THROTTLED | a 429 | reported for that account | typed error; no retry (Epic 9) |
| ISOLATION | two accounts, the first fails | the second is synced in full; the run reports one failure | exit code reflects the failure count |
| CLI_ALL | `--sync-categories --account all` with one M365 and one Gmail account | each is synced through its own adapter, one line each, exit 0 | — non-zero exit and a counted failure line when an account fails |

</frozen-after-approval>

## Code Map

- `src/adapters/gmail/labelColors.ts` (new) — Google's documented allowed label colours plus `nearestGmailColor(hex)` / `textColorFor(background)`: the palette is data, so it lives in one small module with its own tests rather than inside the adapter.
- `src/adapters/m365/M365Adapter.ts` — the sibling this story mirrors: injected `{ fetchFn, getAccessToken }`, a paged list, an exact-name diff, `AbortSignal.timeout`, typed errors, a request builder per verb. Read it first.
- `src/orch/sync.ts` — `syncCategories({ accounts, labels, mailPort, logPort }): Promise<number>` and `CategorySyncTarget { ensureCategories(accountId, labels) }`, which the Gmail adapter satisfies unchanged.
- `src/adapters/config/taxonomy.ts` + `src/core/dto/LabelDef.ts` — Story 4.1's frozen `Taxonomy`, whose `name`/`gmailColor` this story consumes.
- `src/adapters/gmail/GmailAuthAdapter.ts` — Story 3.1's `getAccessToken(accountName, { forceRefresh })` seam and its own `FetchLike`/`FetchResponseLike`; do not edit it.
- `src/adapters/gmail/accountSettings.ts` + `src/adapters/m365/accountSettings.ts` — the per-account listing the CLI reuses for `--account all`.
- `src/cli/commands/sync-categories.ts` + `src/cli/dispatch.ts` — the temporary command and its pure resolver: the place the CLI surface decision lands.
- `src/core/ports/MailPort.ts:5-9` and `src/core/ports/LogPort.ts` — `ensureCategories(accountId, labels)` and the logging seam the orchestrator already uses.
- `epics.md:369-387` — Story 4.3 AC; `prd.md:150-166` — FR-5; `ARCHITECTURE-SPINE.md:250-255` — the capability map; `package.json` — `googleapis` stays unused.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/gmail/labelColors.ts` — the documented palette plus `nearestGmailColor(hex)` and `textColorFor(background)` — the colour decision, isolated as data and pure functions.
- [x] `src/adapters/gmail/GmailAdapter.ts` — `ensureCategories(accountId, labels)`: list, exact-name diff, create the missing, per-account `labelIdsFor(accountId)`, typed `GmailAdapterError` — the story's deliverable.
- [x] `src/orch/sync.ts` — add an optional per-provider noun to the log line (default unchanged) so the shared loop reads correctly for labels — one additive option, no behaviour change for M365.
- [x] `src/adapters/index.ts` — export the adapter, its error/codes, deps and the label-map type — one adapter barrel.
- [x] `tests/adapters/gmail/gmail-adapter.test.ts` — stdlib-only scripted-fetch mocks covering every matrix row — the adapter's only executable check.
- [x] `tests/orch/sync.test.ts` — one case for the noun option — keeps the shared loop's contract pinned.
- [x] `src/cli/commands/sync-categories.ts` + `src/cli/dispatch.ts` — extend the temporary command to ensure M365 categories and Gmail labels for the selected accounts, resolving a named account against both providers' listings — the reachability decision.
- [x] `tests/cli/sync-categories.test.ts` + `tests/cli/dispatch.test.ts` — both-provider routing, the per-provider listings, the named-account resolution and the per-provider summary lines — pins the extended command.

**Acceptance Criteria:**
- Given `mise exec node@20 -- bun run build`, `bun run lint`, `bun run test`, when run, then all exit 0.
- Given an account with no matching labels, when `ensureCategories` runs with the 11-label taxonomy, then 11 creates carry the 11 `name`s, and a second run issues none.
- Given a mix of pre-existing and missing labels, when it runs, then only the missing ones are created and `labelIdsFor` maps all 11 names to ids drawn from the list and the create responses.
- Given two accounts where the first fails, when the orchestrator runs, then the second is synced, the failure is logged with its `accountId`, and the returned failure count is 1.

### Review Findings

Code review of `86bbd61..` working tree (2026-10-09, 15 files, +1440/−58). Three layers ran — blind-hunter, edge-case-hunter, verification-gap; none was skipped and none returned empty. The edge-case layer's claim and deletion checks found nothing falsified and no orphaned behaviour; the verification-gap layer confirmed every matrix row and the orchestrator/CLI suites are pinned except the two gaps below.

**Decision needed:** _none — every surviving finding has an unambiguous fix._

**Patch:**
- [x] [Review][Patch] A provider's listing failure aborts the whole run instead of costing one failure — `catch … return 1` in both the `--account all` and named-account loops, so a broken `accounts/m365` directory leaves Gmail labels unsynced and an account that is a valid Gmail account is reported unlisted [src/cli/commands/sync-categories.ts:143-146,176-182]
- [x] [Review][Patch] No test drives a provider listing that *throws*, which is why the gap above survived; the spec's own Implementation Notes flagged it as still open [tests/cli/sync-categories.test.ts]
- [x] [Review][Patch] The named-account path across two providers is untested where one provider reports a settings error for that name while the other syncs it [tests/cli/sync-categories.test.ts]
- [x] [Review][Patch] The per-account cache is written only after a fully successful loop, so a mid-loop create failure leaves the previous snapshot in place — intended, but undocumented and untested [src/adapters/gmail/GmailAdapter.ts:125]
- [x] [Review][Patch] `send` spreads its init and then overrides `signal`, so a future builder that supplies its own would be silently discarded [src/adapters/gmail/GmailAdapter.ts:206]
- [x] [Review][Patch] `sprint-status.yaml` still says `in-progress` while this spec says `in-review` [sprint-status.yaml]

**Deferred:**
- [x] [Review][Defer] The Gmail account-settings suite lacks the non-ENOENT `readdir` propagation case that the M365 suite has, so the throw path the CLI gap depends on is itself unpinned at the adapter level [tests/adapters/gmail/account-settings.test.ts] — deferred: pre-existing from Story 3.1's suite, not caused by this change.

**Rejected:**
- `low` — "the frozen Boundaries clause still says `ensureCategories` also returns the map": the deviation is recorded in the Implementation Notes with the reason (MailPort's `Promise<void>` wins, TS2322), and the finding's fix is to edit this build's frozen spec.
- `low` — "`nearestGmailColor` silently maps a malformed hex to `#000000` (NaN channels)": reachable only by calling the helper with an unvalidated hex, and the taxonomy loader's `GMAIL_COLOR_PATTERN` is the only call site's guarantee; a guard would branch for unreachable state.
- `low` — "a timeout and a refusal both say 'could not be reached'": mirrors the M365 adapter's reviewed behaviour, and distinguishing them needs a new error code or message surface.
- `low` — "`labelIdsFor`'s read-only guarantee is type-level only": `ReadonlyMap` is the contract in a TypeScript codebase, and a caller casting it away is a deliberate escape hatch, not an oversight.
- `low` — "the error contract promises a status, but the two malformed-2xx errors carry none": those messages are already actionable and a 2xx response has no status to name.
- `low` — "a third near-duplicate `FetchLike` shape now exists": consolidating them means a new shared module plus a narrowing in the Story 3.1 adapter, and the divergence is documented.

## Implementation Notes

- **2026-10-09 — `ensureCategories` returns `Promise<void>`; the name → id map is read back
  through `labelIdsFor` (deviation from the Boundaries clause, approved in review).**
  `MailPort.ensureCategories(accountId, labels): Promise<void>` is the frozen core contract
  (Story 1.2, `src/core/ports/MailPort.ts:5-9`) and conforming to it is this story's point,
  but a method returning `Promise<GmailLabelIds>` cannot satisfy it — TypeScript rejects
  `Promise<Map<string, string>>` → `Promise<void>` (TS2322, verified). MailPort conformance
  wins: the adapter still populates the per-account cache on every sync (ids from the list
  for labels that already existed, from each create response for the rest) and exposes it
  through `GmailAdapter.labelIdsFor(accountId)`, which is the AC's "cached in memory per
  account for write-back". `CategorySyncTarget` and the `syncCategories` loop stay exactly
  as Story 4.2 left them, plus the optional `noun`.
- **2026-10-09 — `GmailAdapterDeps.fetchFn` takes a wider init than `GmailAuthAdapter`'s
  `FetchLike`.** Story 3.1's seam types `init.body` as required (its only caller posts a
  form) and is not this story's to edit, while a Gmail label-list `GET` must not carry a body
  (undici throws). The adapter declares its own `{ fetchFn, getAccessToken }` seam whose init
  types `body` as optional — a supertype of Story 3.1's shape, so one injected `fetchFn`
  still serves both — and omits the property on the GET.
- **2026-10-09 — `--sync-categories` now serves both providers.** The command lists M365 and
  Gmail accounts, syncs each provider through its own adapter (`categories` / `labels` log
  noun) and prints a per-provider counted line for the failures plus the settings errors;
  a named account is resolved against both providers' enabled listings, so no provider flag
  was added. `tests/cli/dispatch.test.ts` needed no change — the routing is unchanged.
  Colours are mapped through `labelColors.ts` (nearest of the documented 113-value palette,
  plus black/white by relative luminance), never sent raw. `build`, `lint` and `test`
  (170 tests, 15 files) are green; no file in `src/` or `tests/` imports `googleapis`.
- **2026-10-09 — diff review.** All eight tasks and all eleven matrix rows are done and
  mapped to passing tests, and the ACs hold. Two things were settled while reviewing rather
  than left for the review: `labelIdsFor` now returns a `ReadonlyMap`, so a caller cannot mutate
  the cache Epic 7 will depend on, and the 113-value palette was verified equal to the
  installed package's own Gmail discovery types
  (`node_modules/googleapis/build/src/apis/gmail/v1.d.ts`) — a Google palette change means
  editing `labelColors.ts` alone. Still open for the review: the CLI's `--account all` path
  returns 1 on a provider listing failure without trying the other provider.
- **2026-10-09 — review pass 1 patches applied.** A provider's listing failure is now a counted
  failure that continues to the other provider, in both the `--account all` and the
  named-account loops — the isolation principle now holds at the provider level too. Both
  adapters' `send` merges a caller-supplied `signal` instead of overwriting it, the per-account
  cache is documented (and tested) as a snapshot of the last *complete* sync, and the sprint
  status agrees with the story. Tests added: a provider listing that throws (EISDIR) while the
  other provider still syncs, a named account with a settings error in one provider and a
  healthy sync in the other, and a mid-loop create failure keeping the previous snapshot.
  173 tests green.

## Spec Change Log

## Review Triage Log

## Design Notes

- **Colours are mapped, not passed through.** Google rejects any label colour outside its documented palette, and none of the taxonomy's 11 hexes is in it — so `label.gmailColor` is the *intent* and the palette is the constraint: the adapter sends the nearest allowed colour as the background plus an allowed black/white text colour, which Google always accepts and which keeps each label visually close to what `taxonomy.yaml` says. The user can see the small shift in Gmail; showing the exact hex would need a taxonomy restricted to Google's palette, which is a planning change rather than this story's.
- **One command, two providers.** `--sync-categories` ensures M365 categories and Gmail labels for the selected accounts, because that is what startup will do; a named account is looked up in both providers' enabled listings so no new provider flag is needed, and a name in neither listing is a reported error.
- **Plain `fetch`, not `googleapis`.** The AC names the SDK's method spelling (`users.labels.list`), and the spine seeds a `gmail-client.ts` wrapper, but the repo's reviewed precedent is an injected `FetchLike` (2.1, 3.1, 4.2) and `tests/adapters/**` must stay stdlib-only. The two REST calls are `GET`/`POST https://gmail.googleapis.com/gmail/v1/users/me/labels` with the Bearer token from Story 3.1's seam; `gmail-client.ts` stays unbuilt until Epic 5/7 needs more of the API.
- **`/` in label names is safe.** Gmail accepts `Family/Friends` and `Waiting/Follow-up` verbatim and does not require the parent label to exist (gmailctl issue #70 confirms the API allows a slashed name whose parent is absent); it simply renders them nested in the Gmail UI, which is inherent to Gmail's naming convention and not this story's to change — the names are frozen in `taxonomy.yaml`.
- **Gmail's label list has no page token**, so unlike the M365 category list there is nothing to walk.
- **The name → ID map is the adapter's per-account cache**, keyed by account id, and also returned by `ensureCategories`; that is the "cached in memory per account for write-back" the AC requires, without inventing a new port Epic 7 would have to learn.
- **`ensureCategories` keeps `MailPort`'s name for the Gmail side** even though it creates *labels*: the shared `CategorySyncTarget` seam and `syncCategories` loop then work for both providers unchanged, and Epic 11 can wire one startup call for each.

## Verification

**Commands:**
- `mise exec node@20 -- bun run build` — expected: exit 0.
- `mise exec node@20 -- bun run lint` — expected: exit 0 (the AD-10 direction and the per-adapter SDK ban stay enforced).
- `mise exec node@20 -- bun run test` — expected: exit 0, including the new gmail adapter suite.

**Manual checks:**
- No file in `src/` or `tests/` imports `googleapis`.
- The Gmail adapter issues exactly one list and only as many creates as there are missing labels, and no test reads a real `~/.config/email-classify`.
