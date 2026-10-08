---
title: 'Story 3.1: Gmail OAuth User Consent Flow (Multi-Account, accountName-validated)'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: 'bf6bf9ab27a4390440dd1254edfd2276fc88334f'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Gmail is unreachable: `--auth gmail` is rejected as an unknown provider (`src/cli/commands/auth.ts:150`) and no Gmail auth adapter exists, so no Gmail token is ever stored and Epics 4, 5 and 7 have no credentials to consume.

**Approach:** Mirror Story 2.1's reviewed M365 shape for Gmail. A `GmailAuthAdapter` runs the OAuth 2.0 installed-app consent flow (loopback redirect, plain HTTP requests — no SDK), persists the `TokenSet` through the existing provider-agnostic `KeychainTokenStore`, and refreshes silently on expiry. `--auth` dispatches on provider; `--account all` enumerates the temporary `accounts/gmail/*.yaml` reader.

## Boundaries & Constraints

**Always:**
- Validate the account name against `ACCOUNT_NAME_PATTERN` (`src/core/dto/accountName.ts`) before any keychain or filesystem lookup.
- `src/core/**` untouched (AD-10). Adapters import only `core`; `cli` imports `core` + `adapters`. Relative imports carry explicit `.js` (ESM `nodenext`).
- Scopes exactly `gmail.readonly`, `gmail.labels`, `gmail.modify`; the consent URL carries `access_type=offline` and `prompt=consent` so a refresh token is issued.
- Redirect URI is `http://127.0.0.1:<ephemeral port>` against a Google Cloud *Desktop app* OAuth client (human decision, 2026-10-09); the port is never fixed or configurable.
- Tokens are read/written only through `TokenPort` with provider `"gmail"` — keychain service exactly `email-classify-gmail-<accountId>`, fallback `~/.config/email-classify/accounts/gmail/<accountId>/tokens.json.age`. Reuse the store; do not re-implement its layout.
- Passphrase chain, token-store error codes and `TokenSet` shape are unchanged (Story 1.2/2.1 contracts).
- Access token, refresh token and client secret never appear in stdout, stderr, logs or error messages.
- Errors are typed at the adapter boundary and rendered as one actionable line naming the account — never raw HTTP payloads or stack traces. The secret is read from the env var named by that account's `clientSecretEnvVar`.

**Never:**
- No `googleapis` import: consent URL, code exchange and refresh are plain HTTP (`node:http` loopback + `fetch`), so `tests/adapters/**` stays stdlib-only (`.oxlintrc.json` bans the SDK there). `gmail-client.ts` / `GmailAdapter` stay unbuilt until Epic 4/5 first needs the Gmail API.
- No hosted component, no cloud dependency, no device-code substitute, no headless/remote-consent path — the browser must reach loopback on this machine.
- No change to `TokenPort`/`TokenSet`, no `zod` in `core`, no `Config`/`ConfigLoader`, no taxonomy, no env-override layer, no DI container — Epic 11 owns those.
- No live Google consent in this story's verification: the flow is exercised only through injected mocks and no real Gmail account is touched.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | `--auth gmail --account personal`, no cached token | browser opens consent; code exchanged; `TokenSet` stored via `TokenPort("gmail", …)`; exit 0, one line naming account and scopes | N/A |
| ALREADY_VALID | cached token with `expiresAt > now` | no browser, no network; cached token returned | N/A |
| EXPIRED | cached token carrying a `refreshToken` | silent refresh at the token endpoint; refreshed `TokenSet` re-persisted | N/A |
| REVOKED | refresh returns `invalid_grant` | — | typed `AUTH_REQUIRED` naming `--auth gmail --account <name>` as the remedy |
| TRANSIENT | refresh returns 5xx/429 or the endpoint is unreachable | — | typed `TOKEN_REQUEST_FAILED`; never a re-consent prompt |
| DENIED | Google redirects with `error=access_denied` | — | typed `CONSENT_DENIED`, exit 1 |
| NO_CODE | consent not completed within 5 minutes | — | typed `CONSENT_TIMEOUT`, printing the consent URL so the user can retry |
| BAD_NAME | `--account Bad_Name` | — | typed `INVALID_ACCOUNT_NAME` before any keychain or file access |
| MISSING_SECRET | the named `clientSecretEnvVar` is unset in `env` | — | typed `MISSING_CLIENT_SECRET` naming the env var |
| ALL_ENABLED | `--account all`, a mix of valid and malformed `accounts/gmail/*.yaml` | valid accounts attempted independently; each bad file reported | failures counted, exit 1 — one bad file never aborts the run |

</frozen-after-approval>

## Code Map

- `src/adapters/m365/M365AuthAdapter.ts:34-65,134-174,319-362,365-386` — the shape to mirror: injected `{fetchFn, tokenStore, accountSettings, now, sleep}`, typed error codes, `authenticate`/`getAccessToken`, the `invalid_grant`→`AUTH_REQUIRED` split in `refresh`, `postForm` with `AbortSignal.timeout`, `tokenSetFromResponse`. Do not edit this file.
- `src/adapters/m365/accountSettings.ts:1-176` — per-account YAML reader: `read`, `listEnabled(): {accounts, errors}`, `assertAccountName` before I/O, typed `AccountSettingsError`, injectable `configDir`. Generic apart from `PROVIDER`, the schema and the display strings → extract `createPerAccountSettings({provider, schema, displayDir})`.
- `src/adapters/token/KeychainTokenStore.ts:87-241` — reuse as-is: `get/set/delete(provider, accountId)`, lazy `keytar`, age fallback. Already provider-generic; no edit.
- `src/core/ports/TokenPort.ts:3-7`, `src/core/dto/TokenSet.ts`, `src/core/dto/accountName.ts` — contracts; unchanged.
- `src/cli/commands/auth.ts:73-170` — `runAuth` dispatches on the provider, but `authenticateOne`/`authenticateAccounts` (:73-110) hardcode the `m365` message prefix and `authenticateAll` (:112-147) is typed to `M365AuthAdapter` + the m365 listing. `src/cli/index.ts:8-18` — help text and examples say "m365" only.
- `tests/cli/auth.test.ts:27-31` — asserts `runAuth({provider: "gmail"})` is rejected; must become a still-unknown provider.
- `prd-email-agent-2025-01-15/prd.md:394-401` — canonical `accounts/gmail/<accountName>.yaml` keys (`name`, `enabled`, `clientId`, `clientSecretEnvVar`; `labels`/`batchSize` belong to Epic 5); `prd.md:102-115` FR-2; `epics.md:305-330` Story 3.1 AC.
- **Scope wire form (pinned in review pass 1):** Google's Gmail scope *values* are `https://www.googleapis.com/auth/<name>`, so the consent URL must send `GMAIL_SCOPE_URIS`; `GMAIL_SCOPES` (the short names the AC writes) stays the value persisted in `TokenSet`. The short names are not valid scope values — sending them fails `invalid_scope`, so do not re-derive that.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/config/perAccountSettings.ts` — extract the generic reader factory — one implementation, not two divergent temporary readers.
- [x] `src/adapters/m365/accountSettings.ts` — reduce to schema + factory instantiation + re-exports of today's names — keeps the story-2.1 suite green unchanged.
- [x] `src/adapters/gmail/accountSettings.ts` — gmail schema over `accounts/gmail/` — the `--account all` source.
- [x] `src/adapters/gmail/GmailAuthAdapter.ts` — consent URL, loopback redirect, code exchange, `getAccessToken`/silent refresh, typed `GmailAuthError` — the deliverable.
- [x] `src/adapters/index.ts` — export the gmail adapter, its error type and scopes, and the gmail settings types — single adapter barrel.
- [x] `src/cli/commands/auth.ts` + `src/cli/index.ts` — dispatch on `m365|gmail`, thread the provider prefix through `authenticateOne`/`authenticateAccounts` and the provider's listing through `authenticateAll`, update help and examples.
- [x] `tests/adapters/gmail/gmail-auth-adapter.test.ts`, `tests/adapters/gmail/account-settings.test.ts` — stdlib-only mocks covering every I/O-matrix row.
- [x] `tests/cli/auth.test.ts` — repoint the unknown-provider case and cover gmail dispatch — the current assertion becomes false.

**Acceptance Criteria:**
- Given `mise exec node@20 -- bun run build`, `bun run lint`, `bun run test`, when run, then all exit 0.
- Given `--auth gmail --account personal` with a mocked network and a canned authorization code, when the flow completes, then `TokenPort.set("gmail","personal", …)` was called once with access/refresh token, `expiresAt` and `scopes`, and the CLI printed exactly one success line.
- Given `--auth gmail --account all`, when one account file is malformed, then the remaining accounts are still attempted and the exit code is 1.
- Given any error in the matrix, when the CLI renders it, then the line names the account and no token, secret or raw payload appears.

## Implementation Notes

**Implementation pass (2026-10-09).** All tasks complete. `mise exec node@20 -- bun run build`, `bun run lint` and `bun run test` (72 tests) are green; `tests/adapters/m365/` is untouched.

- **`GmailConsentErrorCode`/`GmailAuthErrorCode` gained `CONSENT_UNAVAILABLE`.** The loopback seam learns its port by reserving `127.0.0.1:0` and rebinding it (the frozen `authorize(authUrl, redirectUri)` seam has no channel to hand a port back), so a bind/listen failure — and any unexpected rejection from an injected seam — is a plain `Error`. Left alone it escaped the adapter untyped and reached the CLI as a raw socket message, contradicting the typed-error invariant; both are now mapped to `CONSENT_UNAVAILABLE` naming the account.
- **The reserve→rebind window is a deliberate, named race** (`reserveLoopbackPort`): between the reservation's `close()` and the callback's `listen()` another process could take the port. It surfaces as the typed `CONSENT_UNAVAILABLE` above, so it costs a retry rather than a raw crash. Removing the race needs the seam to own the server, i.e. a different seam signature — a decision for whoever next touches that design note.
- **Loopback test consent caps raised to 60 s.** With a 2 s cap the full parallel suite starved the test's `fetch`; the cap fired first, closed the server mid-request and the client saw `ECONNRESET` (`authorizeWithLoopback` also became an unhandled rejection because the test never awaited it). The cap is a safety net, not the behaviour under test; the deliberate-timeout test keeps its 20 ms cap.
- **No OAuth `state` parameter** (CSRF) — not required by the spec and the loopback listener is single-shot on `127.0.0.1`; add it if the flow ever becomes concurrent or remotely reachable.
- `GmailAuthAdapter` takes `tokenStore: TokenPort` like the M365 adapter rather than implementing `TokenPort` itself; the seed's `gmail-client.ts`/`GmailAdapter` stay unbuilt until Epic 4/5.
- `src/adapters/index.ts` exports the gmail adapter, its error/scopes/seam and the gmail settings namespace. The temporary reader factory and its `PerAccountSettings*` types are deliberately not barrelled — nothing imports them from there.

**Review pass 1 (2026-10-09) patches applied.** `buildConsentUrl` now sends Google's full scope URIs while `TokenSet.scopes` keeps the short names (the bare names are rejected as `invalid_scope` — see the Code Map). A synchronous throw from the injectable `open` hook now settles the consent promise with a typed `CONSENT_UNAVAILABLE` instead of escaping uncaught, and `consentFailure` preserves that code's specific message. The gmail CLI test takes its `FetchLike`/`FetchResponseLike` from the gmail adapter instead of m365's structurally identical types. Tests added: gmail empty-store `getAccessToken` → `AUTH_REQUIRED`, `forceRefresh` over an unexpired cached token, `--account all` with only-invalid files, `--account all` on an unlistable directory, and `runAuth`'s m365 dispatch (device-code fetch scripted, so no live network). 77 tests green.

## Spec Change Log

## Review Triage Log

**Loop iteration 0 (2026-10-09).** Three layers ran (blind-hunter, edge-case-hunter, verification-gap) over the diff since `bf6bf9ab`; no layer was skipped. Verdicts are mine, re-verified against the source — not the reviewers' own rankings.

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | Consent URL sends the bare names `gmail.readonly …`, not Google's scope URIs (BH) | high | Real: Google's Gmail scope values are `https://www.googleapis.com/auth/<name>` (Choose Gmail API scopes), so `buildConsentUrl` sending them verbatim fails with `invalid_scope` and the first live consent could not succeed. The canonical form is unambiguous and `TokenSet.scopes` keeps the AC's short names. | patch |
| 2 | No OAuth `state`; the loopback resolves on any request carrying `code` (BH) | low | Real but exotic: a hostile page the user visits during the 5-minute wait can GET the loopback port with an attacker's `code`, storing a token for the attacker's mailbox — the tool then processes the attacker's mail, not a leak of the user's. The fix adds a parameter, stored state and a comparison. | reject (low) |
| 3 | No PKCE (`code_challenge`/`code_verifier`) (BH) | low | Real but not required: Google's loopback migration guide deprecates loopback only for iOS/Android/Chrome client types and keeps it for Desktop app clients, and the exchange does send `client_secret`. The fix adds two parameters and a verifier lifecycle. | reject (low) |
| 4 | `AccountSettingsError` escapes the gmail adapter untyped; no matrix row for settings failures (BH) | low | Real type leak, no user-visible harm: the reader is called un-guarded in `runConsentFlow`/`refresh`, but both CLI entry points catch everything and print its message, which already names the account and the file. Mirrors the reviewed M365 shape. | reject (low) |
| 5 | `reserveLoopbackPort` can yield port 0 → misleading `redirect_uri_mismatch` (BH) | false | `probe.address()` cannot be null or non-object inside a successful `listen(0)` callback, so the cited state is unreachable. Its race half (reservation `close()` then the callback's `listen()`) is filed as a deferral below. | reject (false) |
| 6 | `consentFailure` discards the `CONSENT_UNAVAILABLE` reason (BH) | low | Real: a listener failure's message, which names the port, was replaced by the generic "could not start" line. One extra branch preserving the existing message. | patch |
| 7 | `accounts/**/*.yaml` whose stem fails `ACCOUNT_NAME_PATTERN` are skipped silently (BH/EH) | low | Real: `listEnabledAccounts` `continue`s, so `My_Account.yaml` yields "No enabled gmail accounts found" with no hint a file exists. Inherited verbatim from Story 2.1's reader, which documents the skip, and the ALL_ENABLED row covers *malformed* files, which are reported. | defer |
| 8 | `getAccessToken({forceRefresh})` untested (BH) | medium | Real: no gmail test passed `forceRefresh`, while the mirrored M365 suite pins that branch. | patch (test) |
| 9 | CLI `--account all` branches half covered (BH) | medium | Real: the all-invalid-files message, the `listEnabledAccounts`-throws path and the m365 `--account all` wiring had no test. | patch (test) |
| 10 | `deferred-work.md` not updated with this story's deliberate deferrals (BH) | low | Real bookkeeping gap; discharged by this pass's three `defer` entries. | patch |
| 11 | `sprint-status.yaml` said `in-progress` while the spec said `in-review` (BH) | low | Real transient: step-03 synced `in-progress`, and the sprint legend's state for implementation-complete is `review`. One-line correction. | patch |
| 12 | Spine still says `GmailAuthAdapter implements TokenPort`; no ledger entry (BH) | low | Real: `ARCHITECTURE-SPINE.md:199` vs the shipped constructor, which takes `tokenStore: TokenPort` like the M365 adapter. Planning artifacts are human-owned, so the reconcile is a planning pass. | defer |
| 13 | Barrel exports are dead and asymmetric with m365 (BH) | low | Real but cosmetic: nothing imports `src/adapters/index.ts`, and mirroring m365's flat exports collides on `AccountSettingsError` unless gmail excludes it — churn on an unconsumed barrel. | reject (low) |
| 14 | No user-facing Gmail OAuth setup docs (BH) | low | Real but one-time setup: the runtime errors name the yaml path, the four keys and the env var; a docs page is a new file beyond this story's shape (Story 2.1 shipped none). | reject (low) |
| 15 | Verification records expectations, not results (BH) | low | The finding's fix is to edit this build's spec. | reject (spec-edit) |
| 16 | Test helpers duplicated; the gmail CLI test took `FetchLike` from the m365 adapter (BH) | low | Real trap: a gmail-side signature change would keep type-checking through the m365 types. The import source is a one-line correction; extracting shared helpers is not. | patch (import only) |
| 17 | Implementation Notes and Design Notes restate the same decisions (BH) | low | The finding's fix is to edit this build's spec. | reject (spec-edit) |
| 18 | A synchronous throw from `open(authUrl)` leaves the consent promise unsettled and escapes uncaught (EH) | medium | Real: `open` runs inside the `listen` callback, so `requestConsentCode`'s catch never sees it — the process takes an uncaught exception and `authenticate` never settles. Demonstrated by injecting a throwing `open`. | patch |
| 19 | `getAccessToken` `forceRefresh` + empty-store `AUTH_REQUIRED` untested (VG) | medium | Pre-verified by the verification-gap layer; same root cause as #8. | patch (test) — grouped with #8 |
| 20 | `runAuth({provider:"m365"})` rewired by this diff but untested (VG) | medium | Pre-verified: the diff renames its imports and threads `configDir`/`provider` through it, with no test exercising it. Same root cause as #9. | patch (test) — grouped with #9 |

**Grouping:** #8+#19 and #9+#20 are one root cause each (a missing mirrored test family, a missing rewired-path test). All other survivors stand alone. Root causes: one high (scope wire form), one medium (untyped escape from `open`), one low (lost `CONSENT_UNAVAILABLE` diagnostic).

**Outcome:** Rejected #2, #3, #4, #13, #14 (low), #5 (false), #15, #17 (spec-edit). Deferred #7, #12 plus the `reserveLoopbackPort` reserve→rebind race. Patched #1 (high), #6, #8+#19, #9+#20, #10, #11, #16 (import only), #18. No `intent_gap` and no `bad_spec` entries — the scope finding is a code defect against a frozen intent whose canonical wire form has exactly one reading, not an incomplete intent — so no loopback was triggered. Every patch is applied and covered by the 77-test green run.

## Design Notes

- **Loopback, not device code.** Google removed the out-of-band paste-the-code flow, so the installed-app flow needs a redirect the CLI can read: a `node:http` server on `127.0.0.1` supplies the port, and the adapter opens the consent URL (platform opener via `node:child_process`, falling back to printing it — never failing when no browser exists). Listen/open/collect is one injectable seam, `authorize(authUrl, redirectUri) => Promise<string>`, so tests supply a canned code without a socket or a browser.
- **Consent cap 5 minutes**, matching the M365 `MAX_WAIT_SECONDS`; the loopback server closes on every exit path.
- **Stored `scopes` are the requested `GMAIL_SCOPES`**, hardcoded like Story 2.1 rather than parsed from the token response (reviewed there as defensible).
- **The reader is extracted, not duplicated.** Story 2.1 made `KeychainTokenStore` provider-generic in anticipation of this story; the reader gets the same treatment now that a second provider exists, with every current m365 export re-exported so the existing suite proves the change behaviour-preserving. The gmail schema validates only the four auth keys and tolerates the Epic-5 keys in the same file.
- **`GmailAuthAdapter` takes a `tokenStore: TokenPort`**, exactly as the M365 adapter does, rather than implementing `TokenPort` as the spine's Structural Seed comment suggests; the seed's `gmail-client.ts` is deferred to Epic 4/5.

## Verification

**Commands:**
- `mise exec node@20 -- bun run build` — expected: exit 0.
- `mise exec node@20 -- bun run lint` — expected: exit 0 (the AD-10 and per-adapter SDK bans stay enforced).
- `mise exec node@20 -- bun run test` — expected: exit 0, including the new gmail suites.

**Manual checks:**
- No gmail test imports `googleapis`; the m365 account-settings tests were not edited.
- No token or secret value appears in any error string or in `tests/**` fixtures.
