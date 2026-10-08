---
title: 'Story 4.2: M365 Master Category Sync (Multi-Account)'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: '667ba46e2741c667a87b0d2d43fbc8a05f2ce8c6'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The merged taxonomy exists (Story 4.1) but nothing puts it into a mailbox. There is no `M365Adapter`, no `ensureCategories` implementation and no orchestrator, so no M365 master category exists for a classified label to be written into (Epic 7), and the labels never appear in Outlook.

**Approach:** Add `M365Adapter.ensureCategories(accountId, labels)` — read `/me/outlook/masterCategories`, then create only the labels that are missing, matched by exact `displayName`, each carrying the taxonomy's `presetN` colour — plus an orchestrator loop in `src/orch/sync.ts` that runs it for every enabled M365 account with per-account error isolation and `LogPort` logging. Plain `fetch` behind Story 2.1's `getAccessToken` seam; no SDK. A temporary `--sync-categories` command makes the sync reachable today.

## Boundaries & Constraints

**Always:**
- Read the account's existing master categories first, following `@odata.nextLink` to exhaustion, then create only labels whose `name` is absent — exact, case-sensitive match on `displayName`. Re-running against an already-synced account creates nothing.
- Each created category carries `displayName: label.name` and `color: label.m365Color`, the taxonomy's `preset0`–`preset24` string, which the Graph colour enum accepts verbatim.
- The adapter takes injected deps (`fetchFn`, the token seam, the per-account settings reader) typed exactly like `M365AuthAdapter`'s, so `tests/**` stay stdlib-only: no `@microsoft/microsoft-graph-client` import anywhere in `src/` or `tests/`.
- **Per-account isolation:** a failing account (auth, non-2xx, network) is caught, logged through `LogPort` with `accountId` in the context, and never aborts the others; the run returns the failure count and the CLI maps it to the exit code.
- **Scope (human decision, 2026-10-09):** the story also ships a temporary `--sync-categories --account <name|all>` command plus the minimal console `LogPort` it needs, so the sync is reachable before Epic 11's DI/startup lands. Both are throwaway, like the temporary readers in Stories 2.1/3.1/4.1.
- Nothing is ever deleted, renamed or re-coloured in a mailbox: a category already present is left exactly as it is, and a label dropped from the taxonomy simply stops being created.
- Errors are typed at the adapter boundary, name the account, and never carry a raw HTTP payload or stack trace.
- AD-10: `core` untouched; adapters import only `core`; `orch` imports only `core` ports/DTOs; `cli` wires all. Relative imports carry explicit `.js`.

**Never:**
- No Graph SDK import and no `googleapis` (Story 4.3 owns Gmail).
- No retry, backoff or rate-limit handling — Epic 9 owns those; a 429 surfaces as a typed per-account error.
- No `MailPort` conformance for the other two methods: `fetchMessages`/`writeLabels` stay Epic 5/7, and no stubbing method that only throws is added.
- No DI container, no `main.ts`, no `Config`/`ConfigLoader`, no env-override layer, no startup wiring — Epic 11 owns those.
- No taxonomy loading or validation work (Story 4.1 owns it), no Gmail label sync (4.3), no classification (Epic 6).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY | account with no categories yet | one POST per taxonomy label, each with its `displayName` and `presetN` colour | N/A |
| IDEMPOTENT | every label already exists as a category | the list is read once and nothing is POSTed | N/A |
| PARTIAL | some labels exist | only the absent labels are POSTed; existing ones untouched | N/A |
| PAGED | the list response carries `@odata.nextLink` | every page is followed before deciding what is missing | N/A |
| COLOUR | a label with `m365Color: preset12` | the POST body carries `color: "preset12"` exactly | N/A |
| AUTH | the token seam throws for one account | that account is reported and skipped; the others still sync | logged with `accountId`; counted as a failure |
| API_ERROR | the GET or a POST returns non-2xx | the account is reported and skipped | typed error naming the account and status; never the raw body |
| THROTTLED | a 429 | reported for that account | typed error; no retry (Epic 9) |
| ISOLATION | two accounts, the first fails | the second is synced in full; the run reports one failure | exit code reflects the failure count |
| CLI_ALL | `--sync-categories --account all` with two enabled accounts | both are synced, one line each, exit 0 | — non-zero exit and a counted failure line when an account fails |

</frozen-after-approval>

## Code Map

- `src/core/ports/MailPort.ts:5-9` — `ensureCategories(accountId: string, labels: LabelDef[]): Promise<void>`; the signature this adapter implements for real.
- `src/adapters/m365/M365AuthAdapter.ts:15-26,154-164,365-386` — the house style to mirror: `FetchLike`/`FetchResponseLike`, the injected-deps constructor, `getAccessToken(accountName, { forceRefresh })` as the bearer-token seam, and `postForm`/`readJsonObject` as the plain-fetch helpers. Do not edit this file.
- `src/adapters/config/taxonomy.ts` + `src/core/dto/LabelDef.ts` — Story 4.1's `loadTaxonomy()` returns the frozen `Taxonomy` (`LabelDef[]`); the sync consumes it and never re-validates it.
- `src/adapters/m365/accountSettings.ts` — `listEnabledAccounts(): { accounts, errors }`, `readAccountSettings(accountName, { configDir })`, `accountsDirDisplayPath()`; the temporary per-account surface the orchestrator/CLI reuses for `--account all`.
- `src/cli/commands/auth.ts:84-181` — the per-account isolation pattern to mirror: a `report(outcome)` callback per account, an aggregate failure count, and an exit code; plus `authenticateAll`'s "no enabled accounts" and "N of M failed" wording.
- `src/cli/commands/auth.ts:20-29,149-170` and `src/cli/index.ts:1-30` — how a command is wired today: `createPassphrasePrompt` shows the house style for a small temporary CLI-side adapter, and `runAuth(options, runtime)` shows the injectable test seam (`fetchFn`, `tokenStore`, `configDir`, `env`) that lets a CLI test run without network or a real home.
- `src/core/ports/LogPort.ts` + `src/adapters/logger/.gitkeep` — no LogPort implementation exists until Epic 10, so the temporary command supplies a minimal console one and the tests inject a recording fake.
- `src/orch/.gitkeep` — empty; `src/orch/sync.ts` is this story's home for the loop (`ARCHITECTURE-SPINE.md:250-255`).
- `src/adapters/index.ts` — the adapter barrel; add the new adapter, its error type and options.
- `epics.md:355-367` — Story 4.2 AC; `prd.md:139-147` — FR-4; `ARCHITECTURE-SPINE.md:197-200` — the seed's `M365Adapter.ts # implements MailPort`; `:250` — the capability map; `package.json` — `@microsoft/microsoft-graph-client` is installed and stays unused.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/m365/M365Adapter.ts` — `ensureCategories(accountId, labels)`: paged list, exact-name diff, POST the missing with `displayName` + `presetN`, typed `M365AdapterError` — the story's deliverable.
- [x] `src/orch/sync.ts` — `syncCategories({ accounts, labels, mailPort, logPort }): Promise<number>` looping per account with isolation and an aggregate failure count — the shared loop Story 4.3 reuses for Gmail.
- [x] `src/adapters/index.ts` — export the adapter, its error/codes and options — one adapter barrel.
- [x] `tests/adapters/m365/m365-adapter.test.ts` — stdlib-only scripted-fetch mocks covering every matrix row — the adapter's only executable check.
- [x] `tests/orch/sync.test.ts` — isolation, logging context and the aggregate failure count — the orchestrator's only executable check.
- [x] `src/cli/commands/sync-categories.ts` + `src/cli/index.ts` — temporary `--sync-categories --account <name|all>` wiring `loadTaxonomy` → the adapter → the orchestrator, with a console `LogPort` — makes the sync reachable until Epic 11.
- [x] `tests/cli/sync-categories.test.ts` — per-account lines, exit codes, the "no enabled accounts" path and the injectable runtime seam — pins the CLI surface before Epic 11 replaces it.

**Acceptance Criteria:**
- Given `mise exec node@20 -- bun run build`, `bun run lint`, `bun run test`, when run, then all exit 0.
- Given an account with no categories, when `ensureCategories` runs with the 11-label taxonomy, then 11 POSTs carry the 11 `name`s and their taxonomy colours, and a second run issues none.
- Given an account that already has a subset, when it runs, then only the absent labels are created and the existing ones are neither renamed nor re-coloured.
- Given two accounts where the first fails, when `syncCategories` runs, then the second is synced, the failure is logged with its `accountId`, and the returned failure count is 1.

### Review Findings

Code review of `667ba46..` working tree (2026-10-09, 12 files, +1139/−7). Three layers ran — blind-hunter, edge-case-hunter, verification-gap; none was skipped and none returned empty. Edge-case and claim tracing found every added call site matching its declaration and no falsified claim; the verification-gap layer confirmed every matrix row and the orchestrator/CLI suites are pinned, and raised only the CLI-entry gap below.

**Decision needed:** _none — every surviving finding has an unambiguous fix._

**Patch:**
- [x] [Review][Patch] Graph requests carry no `AbortSignal`, so a stalled connection hangs the sync forever — the sibling `M365AuthAdapter.postForm` bounds every request, and `send`'s catch never fires on a hung fetch [src/adapters/m365/M365Adapter.ts:40-53]
- [x] [Review][Patch] The commander dispatch is the only user-facing wiring and is untested: `--sync-categories` routing, the documented `--account` default of `all`, and the `--auth`-plus-`--sync-categories` precedence all live in an unexported action body [src/cli/index.ts:12-22]
- [x] [Review][Patch] `--auth` passed alongside `--sync-categories` is silently ignored — reject the combination with one line instead [src/cli/index.ts:17-21]
- [x] [Review][Patch] A create POST returning a generic non-2xx (500) and a non-2xx on the second page of a paginated list are both untested, though the matrix covers "the GET or a POST returns non-2xx" and paging [tests/adapters/m365/m365-adapter.test.ts]
- [x] [Review][Patch] `labels` holding the same name twice issues two POSTs for one category — a successful create never adds its name to the `existing` set [src/adapters/m365/M365Adapter.ts:95-97]

**Deferred:** _none — nothing in this pass is deferred._

**Rejected:**
- `false` (intent-excluded) — "network failures discard the thrown cause/status": the frozen Always requires the typed error to carry neither Graph's payload nor the thrown cause, and a sanitized hint would need a new field.
- `low` — "`--account <name>` bypasses the `enabled` filter and a cached token hides a missing settings file": explicitly naming an account intentionally overrides the `--account all` listing filter (exactly as `--auth` does), and the cached-token path that skips reading settings is Story 2.1's reviewed behaviour.
- `low` — "`readJsonObject` is duplicated from `M365AuthAdapter`": eight lines, and a shared module for it is more surface than the copy.
- `low` — "CLI program messages bypass the injected `LogPort`": the split is the established one — `LogPort` carries per-account outcomes (AD-7) while setup hints and the aggregate summary go to stderr, exactly as `auth.ts` does, and the CLI tests pin those lines.
- `low` — "`accountId` vs `accountName` naming drift": `accountId` is the spelling the `MailPort` and `LogContext` contracts use; the older auth adapter's `accountName` is the outlier, and renaming a Story 2.1 file is not this story's to do.
- `low` — "`errorLine` is duplicated in the orchestrator": AD-10 forbids `orch` importing `cli`, so the duplication is structural; two three-line copies do not warrant a core utility.
- `low` — "a cyclic `@odata.nextLink` would loop forever": the walk follows the server's own link; a cycle means a broken Graph, and the guard would add state a healthy server never exercises.

## Implementation Notes

- **2026-10-09 — `M365AdapterDeps` drops the spec's per-account settings reader (approved deviation).**
  `ensureCategories` needs only `fetchFn` and Story 2.1's `getAccessToken` seam, so the
  injected deps are `{ fetchFn, getAccessToken }`; the `AccountSettingsReader` the
  Always-bullet enumerates would be dead constructor surface every test had to fake.
  The bullet's intent — injected deps, stdlib-only tests, no Graph SDK — is unchanged.
- **2026-10-09 — `syncCategories` takes `labels` (approved gap-fill).** The task line's
  `{ accounts, mailPort, logPort }` carried no taxonomy, but `ensureCategories(accountId,
  labels)` requires one, so the options are `{ accounts, labels, mailPort, logPort }` and the
  return value is the failure count as a `number` (`authenticateAccounts`' split).
- **Graph GETs omit `body`.** The shared `FetchLike` declares `body` required because its
  only prior caller posts a form; a Graph GET must not carry one (undici throws
  `TypeError`), so `M365Adapter` omits the property and asserts the init back to that shape.
- **2026-10-09 — diff review.** All six tasks and all ten matrix rows are done and mapped to
  passing tests; `build`, `lint` and `test` (136 tests, 12 files) are green on the patched
  tree. Two things the review should see: `--auth` combined with `--sync-categories` runs the
  sync and ignores `--auth` (the spec never specified the combination, and no matrix row
  covers it), and `src/cli/commands/auth.ts` gained two `export` keywords so this command
  reuses `errorLine`/`createPassphrasePrompt` instead of duplicating the TTY code.
- **2026-10-09 — review pass 1 patches applied.** Every Graph request is now bounded by
  `AbortSignal.timeout(30_000)` in `send` (the unguarded hang the blind-hunter and
  edge-case layers both found), a successful create records its name in the `existing` set so
  a duplicated input name is POSTed once, and `M365AuthAdapter`'s `FetchLike` now types
  `init.body` as optional — which let `getRequest` drop its `as FetchInit` cast, the one edit
  to a Story 2.1 file. The commander action body moved into a pure, exported
  `resolveCliCommand` in `src/cli/dispatch.ts` (with `tests/cli/dispatch.test.ts`), so the
  routing, the `--account`-defaults-to-`all` contract and the now-rejected
  `--auth` + `--sync-categories` combination are all pinned. Tests added: the dispatch
  resolver's six cases, a create returning 500, a non-2xx on a later page, a duplicated input
  name, and a `signal` assertion on every recorded request. 145 tests green.

## Spec Change Log

## Review Triage Log

## Design Notes

- **Plain `fetch`, not the Graph SDK.** `@microsoft/microsoft-graph-client` is installed but Story 2.1 deliberately avoided the SDK for auth, and `tests/adapters/**` must stay stdlib-only (`.oxlintrc.json` bans the SDK there). `masterCategories` is one GET and one POST, so the adapter mirrors `M365AuthAdapter`'s injected `FetchLike` instead.
- **`MailPort` conformance is deliberately partial.** The spine's seed says `M365Adapter.ts # implements MailPort`, but two of that port's three methods belong to Epics 5 and 7; this story ships `ensureCategories` alone rather than stub methods that only throw. `MailPort` conformance lands when the other two exist.
- **Colours need no mapping table:** the taxonomy stores `preset0`–`preset24`, which is exactly the Graph colour enum's spelling.
- **Pagination is followed but nothing else is retried:** a `@odata.nextLink` walk is needed for the "re-running creates nothing" guarantee to hold on a large mailbox, while retry/backoff is explicitly Epic 9's.
- **The orchestrator returns a result as well as logging:** `LogPort` satisfies AD-7's per-account context, and the returned summary is what the CLI (or a later caller) turns into an exit code — the same split `authenticateAccounts` uses.
- **The temporary CLI surface (decision 1)** is `src/cli/commands/sync-categories.ts` plus a commander option and a console `LogPort` in `src/cli/index.ts`: small, injectable through the same runtime seam `runAuth` uses, and deleted wholesale when Epic 11's DI container and `main.ts` land.

## Verification

**Commands:**
- `mise exec node@20 -- bun run build` — expected: exit 0.
- `mise exec node@20 -- bun run lint` — expected: exit 0 (the AD-10 direction and the per-adapter SDK ban stay enforced).
- `mise exec node@20 -- bun run test` — expected: exit 0, including the new m365 adapter and orch suites.

**Manual checks:**
- No file in `src/` or `tests/` imports `@microsoft/microsoft-graph-client`.
- The orchestrator logs through `LogPort` rather than `console`, and no test reads a real `~/.config/email-classify`.
