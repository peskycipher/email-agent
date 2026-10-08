# Epic 3 Context: Gmail Authentication (per account)

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Enable a user to connect one or more Gmail accounts through an OAuth 2.0 installed-app consent flow, then persist each account's access and refresh tokens independently so later runs can refresh silently without re-consent. This epic establishes the Gmail half of per-account authentication the rest of the pipeline depends on: without a valid per-account token and its refresh path, Gmail label sync, fetching, and write-back cannot run. Because tokens are the user's credentials, the epic also fixes how tokens are stored and recovered when the OS keychain is unavailable.

## Stories

- Story 3.1: Gmail OAuth User Consent Flow (Multi-Account, accountName-validated)

## Requirements & Constraints

- `email-classify --auth gmail --account <name|all>` (or an account picker) authenticates the selected Gmail account(s); each account completes independently.
- The consent flow is the OAuth 2.0 installed-app flow, requesting scopes `gmail.readonly`, `gmail.labels`, and `gmail.modify`. Browser opens to Google's consent screen with `access_type=offline` and `prompt=consent` so a refresh token is issued.
- On consent, the authorization code is exchanged for access + refresh tokens and persisted via `TokenPort`.
- `accountName` must match `/^[a-z0-9][a-z0-9_-]{0,31}$/` and is validated *before* any keychain or filesystem lookup; non-conforming names are rejected with a clear error. This name binds to the per-account config file and directory path.
- Tokens are stored one entry per account. Primary store is the OS keychain under service `email-classify-gmail-<accountId>`; fallback is an encrypted file at `~/.config/email-classify/accounts/gmail/<accountId>/tokens.json.age`.
- If the keychain is unavailable, the age passphrase resolves in this order: the env var named by `Config.tokenFallback.passphraseEnvVar`, then a one-time TTY prompt, then exit 1 with an actionable error naming the env var when stdin is not a TTY.
- Access tokens refresh automatically on expiry using that account's refresh token; a re-auth prompt is required only when the refresh token is revoked or invalid.
- Multiple Gmail accounts can be authenticated independently with distinct `accountId`s; no cross-account coupling.
- Never log tokens (redacted in log context).

## Technical Decisions

- Hexagonal architecture: an auth adapter implements the `TokenPort` and no auth logic leaks into the core.
- `TokenPort` is the account-scoped interface: `get(provider, accountId)`, `set(provider, accountId, tokens)`, `delete(provider, accountId)`. `provider` is `"gmail"` here; every method takes `accountId`.
- Gmail auth adapter lives at `adapters/gmail/GmailAuthAdapter.ts`; the shared keychain-with-age-fallback store lives at `adapters/token/KeychainTokenStore.ts`. The CLI `--auth` command wires them.
- Token shape is the canonical `TokenSet` DTO: `accessToken`, `refreshToken?`, `expiresAt`, `scopes[]`.
- Gmail uses `googleapis`; per-account OAuth client credentials are configured with `clientId` and `clientSecretEnvVar` in `~/.config/email-classify/accounts/gmail/<accountName>.yaml` (referenced by name under `gmail.accounts` in the main config). Secrets are read from env vars, not the config file.
- `accountId` threads through every account-touching port method and DTO so per-account context is never lost.
- Dependency direction is enforced: `core/` (zero deps) ← `adapters/` ← `cli/`; the Gmail auth adapter may depend only on core ports/DTOs.
- Structured logging (`LogPort`) is used for auth events; log context carries `accountId`.

## UX & Interaction Patterns

- The `--auth` command is part of the CLI surface and must have clear help text showing the `--account <name|all>` option and multi-account examples.
- Auth failures (consent denied, revoked refresh token, missing client credentials, keychain unavailable) must produce clear, actionable messages instead of stack traces.
- The consent flow hands control to the browser; the CLI must tolerate the user completing consent asynchronously and surface a timeout/retry path rather than hanging silently.

## Cross-Story Dependencies

- Depends on Epic 1 for `TokenSet` DTO, `TokenPort`, and the core/adapters dependency boundaries, and on Epic 11 for loading and validating the per-account Gmail config (`clientId`/`clientSecretEnvVar`, account-name validation).
- Mirrors Epic 2 (M365 auth): both implement the same `TokenPort` contract and keychain/age fallback, so the fallback and keychain conventions must stay consistent across providers.
- Produces the per-account Gmail credentials consumed by later epics: taxonomy/label sync (Epic 4), Gmail fetching (Epic 5), and Gmail label write-back (Epic 7) all obtain tokens through this epic's stored credentials.

<!-- GAP: no UX design contract exists; UX guidance here is PRD/UX-DR-derived, not an approved UX spec. PRD and architecture spine used as sources; the epics file provided the epic goal, FR coverage (FR2, NFR10), and story acceptance criteria. -->
