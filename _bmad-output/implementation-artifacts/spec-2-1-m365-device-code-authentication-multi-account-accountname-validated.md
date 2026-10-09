---
title: 'Story 2.1: M365 Device Code Authentication (Multi-Account, accountName-validated)'
type: 'feature'
created: '2026-10-08'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'bfcd504b4072944d0366b9c310a013efa4ce7e93'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing can authenticate a mailbox yet. Epic 1 shipped the type layer and an empty adapter tree, so `TokenPort` has no implementation and no M365 account can obtain a token — fetch, labels and cron are all blocked on this. Story 2.1 is also the first real adapter, where the per-account `accountId` threading and the `core ← adapters ← cli` boundary stop being theory.

**Approach:** Implement `KeychainTokenStore` (`TokenPort`: keychain with age-encrypted file fallback) and `M365AuthAdapter` (Microsoft device code flow, per-account reuse and silent refresh), then surface them as `email-classify --auth m365 --account <name|all>`.

**Decisions (human, 2026-10-08):** (1) **Scope** — include a minimal CLI (`cli/commands/auth.ts`, `cli/index.ts` via commander) plus a ~40-line per-account reader (`accounts/m365/<name>.yaml` → `{name, enabled, tenantId, clientId}`) living in `adapters/m365/`, so the AC is runnable end to end; the reader is temporary and is replaced by Epic 11's `ConfigLoader`/DI. (2) **Refresh surface** — `TokenPort` stays as Story 1.2 froze it; silent refresh is exposed as the M365-specific, non-port method `getAccessToken(accountName, { forceRefresh? })`. (3) **Verification** — stdlib-mock tests plus a documented one-time manual live smoke against a real Entra registration.

## Boundaries & Constraints

**Always:**
- Validate the account name against `ACCOUNT_NAME_PATTERN` (`src/core/dto/accountName.ts`) _before_ any keychain or filesystem lookup — the name is used directly as a directory name.
- `src/core/**` untouched (AD-10). Adapters import only `core`; `cli` imports `core` + `adapters`. Relative imports carry explicit `.js` (ESM `nodenext`).
- Tokens are written only through `TokenPort`; keychain service exactly `email-classify-m365-<accountId>`; fallback file exactly `~/.config/email-classify/accounts/m365/<accountId>/tokens.json.age` (file `0600`, parents `0700`).
- Passphrase resolution order is fixed: `Config.tokenFallback.passphraseEnvVar` (default `EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE`) → one-time TTY prompt → exit 1 naming the env var.
- Scopes exactly `Mail.ReadWrite` + `MailboxSettings.ReadWrite`; device-code wait capped at 5 minutes.
- Access and refresh tokens never appear in stdout, stderr, logs or error messages.
- Errors are typed, caught at the adapter boundary, rendered as one actionable line naming the account — never raw SDK/HTTP payloads or stack traces.

**Never:**
- No callback server, hosted component or cloud dependency — device code only.
- No `@microsoft/microsoft-graph-client` import: token acquisition needs no Graph SDK, and importing it would collide with the per-adapter SDK ban in `.oxlintrc.json` for `tests/adapters/**`.
- No change to `TokenPort`/`TokenSet` shape (story-1.2 contract), no `zod` in `core`, no shared `Provider` union.
- No full `config.yaml` loader, env-override layer, taxonomy merge or DI container — Epic 11 owns those.
- No logging of raw HTTP responses.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | valid name; granted within 5 min | prints user code + verification URL, polls with progress, persists `TokenSet` via `TokenPort`, exit 0 | n/a |
| Bad name | `--account 'Work!'` | rejected before any keychain/file call | typed error naming the pattern; exit 1 |
| Keychain unavailable, env passphrase set | passphrase env var set | tokens at `…/tokens.json.age`, file `0600`, parents `0700` | n/a |
| Keychain unavailable, no passphrase, non-TTY stdin | env unset, `process.stdin.isTTY` falsy | nothing written | exit 1, error names `EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE` |
| Device code timeout | nothing authorized after 300 s | nothing stored | typed timeout error carrying the verification URL; exit 1 |
| Cached token valid | `expiresAt` in the future | no network call | n/a |
| Cached token expired | refresh token present | silent `refresh_token` grant, refreshed `TokenSet` re-persisted | `invalid_grant` → error telling the user to re-run auth for that account |
| Multi-account partial failure | `--account all`, account `b` fails | `a` and `c` still complete, one result line each | exit 1 after the last account, failures summarised |

</frozen-after-approval>

## Code Map

- `_bmad-output/planning-artifacts/epics.md:282-303` — Story 2.1 AC, authority for scopes, timeout, service name, fallback path, passphrase chain; `:309-330` Story 3.1 reuses the same port, keychain naming, passphrase chain and name rule, so keep the store provider-agnostic; `:699-757` Epic 11 owns config/CLI/DI.
- `…/ARCHITECTURE-SPINE.md:78-82` AD-4 `TokenPort` + passphrase chain; `:108-112` AD-9 `Config`/`tokenFallback.passphraseEnvVar`/per-account YAML; `:114-127` AD-10 direction; structural seed names `adapters/m365/M365AuthAdapter.ts` (`:194`), `adapters/token/KeychainTokenStore.ts` (`:207`), `cli/commands/auth.ts` and `cli/index.ts` (`:220-222`).
- `src/core/ports/TokenPort.ts` — implement, do not change; already `accountId`-threaded.
- `src/core/dto/TokenSet.ts` — `{ accessToken, refreshToken?, expiresAt (epoch ms), scopes[] }`; the adapter owns serialization.
- `src/core/dto/accountName.ts` — import `ACCOUNT_NAME_PATTERN`; never re-declare the regex.
- `src/adapters/index.ts`, `src/cli/index.ts` — `export {}` today; the barrels to extend. `age-encryption` 0.3.1 is ESM (`import { encrypt, decrypt } from "age-encryption"`); `keytar` resolves at runtime, but lazy-load it so tests never touch the native module.
- `config.yaml.example` does **not** exist in the repo (Epic 1 deferred it) — the missing-settings error must name the expected per-account path, never a non-existent example.
- `tsconfig.{adapters,cli}.json` / `tsconfig.base.json` — new files under `src/adapters`/`src/cli` need no per-project config edit, but TypeScript 7.0.2 (tsgo) does not auto-include `@types/node`, so `tsconfig.base.json` gained `"types": ["node"]`; widening `rootDir` is the AD-10 violation to avoid.
- `.oxlintrc.json` — AD-10 bans for `src/core/**`; per-adapter SDK ban for `tests/adapters/**` (keytar is not banned, but keep the store injectable so tests need no native-module mock).
- `package.json` — `keytar`, `age-encryption`, `js-yaml`, `zod`, `commander` are already installed; no installs needed. `tests/` is still outside every tsconfig.
- `tests/core/scaffold.test.ts` — asserts `Object.keys(core)` is empty; keep `src/core/index.ts` type-only.
- `_bmad-output/implementation-artifacts/deferred-work.md` — open items touching this story: the core external-import guard; "pin non-`accountId` contract shapes when a real consumer lands" (this story is the first `TokenSet` consumer).
- `_bmad-output/implementation-artifacts/epic-1-retro-2026-10-08.md:48` — process lesson: cite the exact command that fails when the spec claims a boundary is enforced.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/token/KeychainTokenStore.ts` — `TokenPort` impl: keytar primary behind an injected `keychain` port (keytar-backed default via lazy dynamic import so tests never load the native module), age fallback with the passphrase chain behind an injected `promptPassphrase`, JSON serialization of `TokenSet`, `0600`/`0700` writes.
- [x] `src/adapters/m365/M365AuthAdapter.ts` — device code flow over an injected `fetch`-like fn (`/devicecode` → poll `/token`, honouring `interval`, `slow_down`, `expires_in` clamped to 300 s); resolves `tenantId`/`clientId` via the injected account-settings reader and reads/writes tokens via the injected `TokenPort`; `authenticate(accountName)`; `getAccessToken(accountName, { forceRefresh? })` returns the cached token when `expiresAt` is in the future and no refresh is forced, otherwise runs the refresh grant and re-persists the result (decision 2); typed errors.
- [x] `src/adapters/m365/accountSettings.ts` — read + zod-validate `~/.config/email-classify/accounts/m365/<name>.yaml` (`name`, `enabled`, `tenantId`, `clientId`), expand `~`; add `listEnabledAccounts()` that globs that directory and keeps `enabled: true` entries (the only implementable `--account all` source until Epic 11's `Config.m365.accounts[]` exists); missing file → one error naming the expected path `~/.config/email-classify/accounts/m365/<name>.yaml`; `--account all` with zero enabled accounts → exit 1 naming the directory to populate.
- [x] `src/adapters/index.ts` — export `KeychainTokenStore` and `M365AuthAdapter`.
- [x] `src/cli/commands/auth.ts` — `--auth m365 --account <name|all>`: construct `KeychainTokenStore` (real keytar binding + TTY passphrase prompt) and `M365AuthAdapter`, validate, iterate enabled accounts for `all`, per-account result lines, aggregate exit code.
- [x] `src/cli/index.ts` — commander setup wiring `--auth`, with `--help` documenting `--account <name|all>`.
- [x] `tests/adapters/token/token-store.test.ts` — keychain hit; keychain unavailable + env passphrase → `0600` file, `0700` parents; no passphrase + non-TTY → throws naming the env var and writes nothing.
- [x] `tests/adapters/m365/m365-auth-adapter.test.ts` — injected fetch: happy path persists the two scopes; 5-minute timeout; invalid name rejects with the store spy never called; valid cached token makes zero requests; expired token refreshes and re-persists; `invalid_grant` → re-auth message; no error message contains token material.
- [x] `tests/cli/auth.test.ts` — multi-account partial failure (I/O matrix row 8): a and c complete with one result line each, b fails, aggregate exit code 1.

**Acceptance Criteria:**
- Given a valid account and a granting user, when `--auth m365 --account <name>` completes, then the user code and URL were displayed, a `TokenSet` carrying both scopes was persisted through `TokenPort`, and the process exited 0.
- Given a name failing `ACCOUNT_NAME_PATTERN`, when auth runs, then it exits 1 before any keychain or filesystem call.
- Given an unavailable keychain and a passphrase in `EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE`, when auth completes, then `…/accounts/m365/<name>/tokens.json.age` exists `0600` with `0700` parents.
- Given two independently authenticated accounts, when both tokens are read back, then each holds its own token and neither overwrote the other's entry.
- Given an unexpired cached token, when auth runs again, then no HTTP request is made.
- Given an expired token, when auth runs again, then the refresh grant runs silently and the refreshed token is re-persisted.
- Given no authorization within 5 minutes, when the poll deadline passes, then it exits 1 with the verification URL and stores nothing.
- Given `bun run build`, `bun run lint`, `bun run test`, all exit 0.

### Review Findings

Code review of commit `c3fae11` (2026-10-09, 15 files, +1808/−7).

**Decision needed:**
- [x] [Review][Decision] Malformed settings files silently dropped from `--account all` — `listEnabledAccounts` catches every `readAccountSettings` failure and `continue`s (`src/adapters/m365/accountSettings.ts`), so a broken `<name>.yaml` vanishes from the run with no result line, while the frozen I/O matrix row 8 asks that failures be summarised. Surfacing skipped files changes the function's return shape (`M365AccountSettings[]`), so the fix needs a call. Options: (a) surface skipped files as per-account failure lines (return `{ accounts, errors }`), (b) abort the run on a malformed file (pre-patch behavior), (c) keep the silent skip and document it.

**Patch:**
- [x] [Review][Patch] `refresh()` maps every non-OK token response to `AUTH_REQUIRED`, so a transient 5xx/429 is reported as a revoked token and re-prompts [src/adapters/m365/M365AuthAdapter.ts:322-345]
- [x] [Review][Patch] `readAccountSettings` reports a non-ENOENT read failure (EACCES/EISDIR) as `SETTINGS_NOT_FOUND` with the wrong remediation [src/adapters/m365/accountSettings.ts:84-95]
- [x] [Review][Patch] `getAccessToken({ forceRefresh: true })` branch is untested [src/adapters/m365/M365AuthAdapter.ts:157]
- [x] [Review][Patch] Device-code poll `slow_down` / `expired_token` / `authorization_declined` / unexpected-error branches are untested [src/adapters/m365/M365AuthAdapter.ts:210-227,296-318]
- [x] [Review][Patch] `authenticate`'s non-`AUTH_REQUIRED` refresh-failure branch is untested [src/adapters/m365/M365AuthAdapter.ts:141-147]
- [x] [Review][Patch] `requestDeviceCode` rejection and missing-verification-URL paths are untested [src/adapters/m365/M365AuthAdapter.ts:258-277]
- [x] [Review][Patch] `runAuth` unknown-provider path is untested [src/cli/commands/auth.ts:141-146]
- [x] [Review][Patch] `listEnabledAccounts` non-ENOENT `readdir` re-throw is untested [src/adapters/m365/accountSettings.ts:135-138]
- [x] [Review][Patch] Token-store read-failure paths (wrong passphrase, corrupt JSON) are untested [src/adapters/token/KeychainTokenStore.ts:198-235]

**Deferred:**
- [x] [Review][Defer] "Silent refresh on 401" (epics.md / epic-2-context) is not implemented — refresh is expiry-only [src/adapters/m365/M365AuthAdapter.ts:152-163] — deferred: the 401→refresh hook belongs to the fetch consumer (Epic 5); the frozen Story 2.1 matrix is expiry-based, so the planning docs are reconciled separately.
- [x] [Review][Defer] `KeychainTokenStore.delete` silently no-ops on a keychain failure and has no caller or test [src/adapters/token/KeychainTokenStore.ts:126-147] — deferred: no consumer yet (Epic 7/11), so the delete contract is settled when it is first used.

**Rejected:**
- `readKeychain` swallows keychain read errors — low: falling through to the fallback file / `TOKEN_NOT_FOUND` is the intended degradation; distinguishing adds guards.
- Keychain and fallback are not mirrored — low: the frozen design is fallback-only, not dual-write.
- Spec Code Map / Implementation Notes say `tsconfig.base.json` gained the node types and "20 tests" — rejected: the fix edits the spec under review.
- Per-request timeout decoupled from the total deadline — low: needs a hung TCP connection; the polling loop already caps the wait.
- Ctrl-C during the passphrase prompt does not abort — false: `undefined` passphrase → `PASSPHRASE_UNAVAILABLE` → CLI exits 1; the run does not proceed into device code.
- Single- vs multi-account failure line formats diverge — low: cosmetic refactor.
- `parseTokenSet` casts unvalidated JSON — low: corrupt-store edge; the fix adds guards.
- `mkdir` 0700 leaves pre-existing parents broad — low: the token file is 0600, so contents stay protected.
- Store's default `promptPassphrase` returns undefined — low: the CLI injects the TTY prompt; the AC holds.
- `authenticateAll` zero-account / `authenticateOne` single-account untested — low: smoke-covered; injecting would add public surface.

## Implementation Notes

**Implementation pass (2026-10-09).** All tasks complete; `mise exec node@20 -- bun run build`, `bun run lint`, `bun run test` (20 tests) and the four CLI smoke paths are green.

Deviations from the planned spec text, all required to build/pass:
- `tsconfig.base.json` gained `"types": ["node"]`: TypeScript 7.0.2 (tsgo) does not auto-include `@types/node`, so every `node:*` import and `process` failed with TS2591 until set. The spec's "no config edit needed" claim was wrong for this toolchain; Code Map corrected.
- `KeychainTokenStore` takes an optional `scryptWorkFactor` (default = age's 18). age's default scrypt costs ~25 s per op here, blowing test timeouts; tests inject `12`, production default unchanged.
- `M365AuthAdapter` takes a 6th dep, `onDeviceCode`, so the CLI prints the user code/URL before polling (AC requirement).
- Missing CLI options print one line to stderr and set `process.exitCode = 1` instead of `program.error()` because tsgo does not apply never-return narrowing for a method call.
- `authenticateAll`'s per-account loop was extracted to exported `authenticateAccounts` so I/O matrix row 8 (partial failure) is unit-testable; `tests/cli/auth.test.ts` covers it. `readCached` matches the token store's `TOKEN_NOT_FOUND` structurally, since AD-10 forbids the m365 adapter importing the token adapter.

Residual risks:
- **`offline_access` tension:** the frozen "scopes exactly Mail.ReadWrite + MailboxSettings.ReadWrite" omits `offline_access`, which Microsoft's v2 endpoint usually needs to return a refresh token. Live silent refresh after expiry may therefore fail (adapter throws `AUTH_REQUIRED` and re-prompts). Confirm during the manual smoke; adding it would be a human spec change.
- The decision-3 live Entra smoke was not run — no tenant/clientId available.
- `--account all` aborts on a malformed settings YAML (config error) rather than isolating it as an auth failure; not spec'd either way.

## Spec Change Log

- 2026-10-09 (revisit pass, human-approved): `KeychainTokenStore.delete` silently no-oped when the keychain `deletePassword` call failed and the age fallback file was missing, allowing a caller to be told "deleted" while the token likely remained in the keychain. Amended: the method now throws `TOKEN_DELETE_FAILED` when the keychain is inaccessible and no fallback file exists. If the keychain fails but the fallback file exists and is removed, delete still succeeds (fallback-first degradation). Added 3 unit tests covering keychain-only deletion, fallback-only deletion, and the new failure path. Known-bad state avoided: a successful `delete` return while a token may still be stored. KEEP: the store's fallback-first design; keychain errors still fall through to the file delete rather than aborting early. The 401→refresh hook remains outside this story's scope (deferred to Epic 5's fetch consumer).

## Review Triage Log

**Loop iteration 0 (2026-10-09).** Three layers ran (blind-hunter, edge-case-hunter, verification-gap). All three runs were later flagged `model_verification_failed` (launched `ollama-cloud/deepseek-v4.1-flash`, child reported `deepseek-v4-pro:0813`) — the harness mismatch is noted; every finding was independently re-verified against the source before triage.

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `offline_access` omitted, so live refresh may lack a refresh token (BH) | medium | Real: Microsoft v2 needs `offline_access` to return a refresh token; `M365_SCOPES` (`M365AuthAdapter.ts:6`) is frozen to two scopes. The only fix edits the frozen spec. | reject — frozen intent; already recorded as a residual risk for the manual smoke |
| 2 | `readAccountSettings` never checks the file's `name` matches the requested name (BH) | medium | `accountSettings.ts:101-108` validates `name` against the pattern but never compares to `accountName`; a `work.yaml` with `name: personal` returns `personal`'s tenant/client while the token is stored under `work`. | patch |
| 3 | `tsconfig.base.json` `types:["node"]` widens core (BH) | medium | `tsconfig.base.json:11`; `tsconfig.core.json` extends it, giving `src/core` node types and weakening the boundary this story proves (core external-import guard is already deferred). | patch |
| 4 | Empty refresh `catch` re-prompts on any refresh error, incl. network (BH/EH/VG) | medium | `M365AuthAdapter.ts:139-143` `catch {}` falls through to device code for `TOKEN_REQUEST_FAILED` too, masking a transient outage as a revoked token. | patch |
| 5 | `parseTokenSet` casts unvalidated JSON (BH/EH) | low | `KeychainTokenStore.ts:221-240`; corrupt-but-valid JSON yields undefined fields, treated as expired. Rare; fix adds guards. | reject (low) |
| 6 | `tokenSetFromResponse` ignores the returned `scope` (BH) | low | Hardcodes `[...M365_SCOPES]`; Entra grants the requested scopes. Defensible; fix adds parsing. | reject (low) |
| 7 | `KeychainTokenStore.delete` untested (BH) | low | No test references `delete`; `delete` has no caller in this story. | reject (low) |
| 8 | `getAccessToken` no-token / `forceRefresh` untested (BH/VG) | medium | `M365AuthAdapter.ts:152-163`; every `getAccessToken` test seeds a cached token. VG-3 verified this path has no test. | patch (test) |
| 9 | `readAccountSettings`/`listEnabledAccounts` untested (BH/VG) | medium | `accountSettings.ts:75-136`; all adapter tests inject a mock reader. VG-1/VG-2 verified no test references either. | patch (test) |
| 10 | `listEnabledAccounts` swallows every `readdir` error as `[]` (BH) | medium | `accountSettings.ts:118-123`; an EACCES dir is reported as "no enabled accounts". | patch |
| 11 | `globalThis.fetch` taken by loose cast, unchecked (BH) | low | `auth.ts:148`; Node 20 is the pinned runtime and always has global fetch. | reject (low) |
| 12 | Store's default `promptPassphrase` returns undefined, so the chain is really CLI-wired (BH) | low | `KeychainTokenStore.ts:93`; the CLI always injects the prompt, so the AC holds. Named risk: a future constructor (Gmail) could omit it. | reject (low) |
| 13 | Success/failure line formats diverge (BH) | low | `authenticateOne` vs `authenticateAccounts` in `auth.ts`; cosmetic. | reject (low) |
| 14 | Cached token scopes not re-checked on reuse (BH) | low | `M365AuthAdapter.ts:152-157`; a token stored under a prior scope set is reused as-is. | reject (low) |
| 15 | No fetch timeout; a hung request outlives the 5-min cap (EH) | medium | `FetchLike` has no `signal`; `postForm` (`M365AuthAdapter.ts:356-374`) can hang past the deadline the loop otherwise enforces. | patch |
| 16 | A malformed settings file aborts `--account all` (EH) | medium | `listEnabledAccounts` lets `readAccountSettings` throw, so a/c never run — contradicts I/O matrix row 8. | patch |
| 17 | `mkdir` mode only applies to new dirs; pre-existing parents stay broad (EH) | low | `KeychainTokenStore.ts:173`; the token file itself is `0600`, so content stays protected. | reject (low) |
| 18 | `readAccountSettings` missing/invalid paths untested (VG) | medium | Pre-verified by the verification-gap layer; the real reader is never executed by a test. | patch (test) |
| 19 | `listEnabledAccounts` + zero-account exit untested (VG) | medium | Pre-verified; only `authenticateAccounts` is tested. Zero-account exit is smoke-covered only. | patch (test) |
| 20 | `getAccessToken` empty-store `AUTH_REQUIRED` untested (VG) | medium | Pre-verified; the only `AUTH_REQUIRED` assertion goes through the `invalid_grant` path. | patch (test) |
| 21 | `authenticate` refresh-failure → re-prompt untested (VG) | medium | Pre-verified; only refresh-success is tested. | patch (test) |
| 22 | Refresh `catch` swallows `TOKEN_REQUEST_FAILED` (VG other) | medium | Same root cause as #4. | patch (grouped with #4) |

Rejected: #1 (frozen intent), #5/#6/#7/#11/#12/#13/#14/#17 (low). Patches: #2, #3, #4+#22, #8, #9, #10, #15, #16, #18, #19, #20, #21. No intent_gap or bad_spec entries, so no loopback.

## Design Notes

**Temporary config surface (decision 1):** with Epic 11 unbuilt there is no `config.yaml` to read, so `--account all` enumerates `~/.config/email-classify/accounts/m365/*.yaml`, validates each candidate name against `ACCOUNT_NAME_PATTERN`, and keeps `enabled: true` entries. Epic 11 replaces this with `Config.m365.accounts[]`; the reader is deliberately one file so deleting it is one import change.

**Filenames follow the spine's Structural Seed**, not `AGENTS.md`'s kebab-case rule: the tree already ships export-named files (`ConfigPort.ts`, `MessageDTO.ts`) and reviewers cite spine paths. Recorded so it is not re-flagged.

**No SDK, no native mocks:** the adapter takes `{ fetchFn, now, sleep, tokenStore, accountSettings }` and the store takes `{ keychain, promptPassphrase }`; tests pass plain objects and canned device-code/poll bodies. This is also why the Graph SDK is not a dependency here — the flow is two plain form posts (`login.microsoftonline.com/<tenant>/oauth2/v2.0/devicecode`, `…/token`, public client, no secret).

## Verification

**Commands:**
- `mise exec node@20 -- bun run build` — expected: `tsc -b` exits 0 (Node 20 is the pinned runtime; bare `node` fails to build `better-sqlite3`).
- `bun run lint` — expected: oxlint exits 0; proves AD-10 survives the new `adapters`/`cli` imports.
- `bun run test` — expected: vitest + fixture typecheck exit 0.
- `node dist/cli/index.js --help` under the pinned Node 20 — expected: help lists `--auth` and `--account <name|all>`, exits 0 with no config file present (Node 20 has no `--experimental-strip-types`, so run the built output).

**Manual checks (decision 3A):**
- With a real Entra app registration (public client, device code flow enabled; `tenantId`/`clientId` in `~/.config/email-classify/accounts/m365/<name>.yaml`): run `node dist/cli/index.js --auth m365 --account <name>`, authorise at the printed URL, then read the token back through the store and confirm `scopes` are exactly the two AC scopes. Re-run and confirm no second authorisation is requested.
