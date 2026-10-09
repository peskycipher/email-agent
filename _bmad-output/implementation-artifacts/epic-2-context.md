# Epic 2 Context: M365 Authentication (per account)

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Let a user connect one or more Microsoft 365 mailboxes to the CLI via Microsoft Graph device code flow, so the rest of the pipeline can read and label mail on every account without re-authenticating. Each account authenticates, caches, and refreshes independently, so one expired or broken account never blocks the others. Credentials stay on the local machine: tokens live in the OS keychain, with an age-encrypted file as the fallback when no keychain is available. This is also the first real adapter in the system, so it proves the per-account `accountId` threading and the port/adapter boundary that later fetch, write-back, and orchestration epics depend on.

## Stories

- Story 2.1: M365 Device Code Authentication (Multi-Account, accountName-validated)

## Requirements & Constraints

- **Command surface:** `email-classify --auth m365 --account <name|all>` authenticates one named account or every enabled M365 account.
- **Account-name safety:** the name must match `/^[a-z0-9][a-z0-9_-]{0,31}$/` and is rejected with a clear error before any keychain or filesystem lookup, because it is used directly as a directory name.
- **Scopes:** request `Mail.ReadWrite` and `MailboxSettings.ReadWrite` per account.
- **Device code flow:** display the user code and verification URL, poll until authorized, and time out after 5 minutes with an actionable error.
- **Independent accounts:** each account authenticates, caches, and refreshes separately; a failure on one must not abort an `--account all` run.
- **Silent reuse and refresh:** later runs reuse the cached token until expiry and refresh silently on expiry using that account's refresh token; the fetch consumer (Epic 5) additionally force-refreshes once and retries on a Graph 401. Re-prompt only when the refresh token is revoked or invalid.
- **Token storage:** OS keychain is primary, one entry per account under service `email-classify-m365-<accountName>`; fallback is an encrypted file at `~/.config/email-classify/accounts/m365/<accountName>/tokens.json.age`. No separate secrets manager.
- **Fallback passphrase chain:** when the keychain is unavailable, resolve the age passphrase in order — env var named by config (`tokenFallback.passphraseEnvVar`, default `EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE`), then a one-time TTY prompt, then exit 1 with an error naming the env var when stdin is not a TTY.
- **Local-first:** no server, hosted OAuth callback, or cloud dependency for v1.
- **Secrecy:** access and refresh tokens must never appear in logs, errors, or progress output.

## Technical Decisions

- Hexagonal (Ports & Adapters): `M365AuthAdapter` lives under `adapters/m365/` and implements the core `TokenPort`; the CLI `--auth` command wires it. Dependency direction `core ← adapters ← cli` must hold.
- One auth adapter instance per enabled account. The DI container iterates `Config.m365.accounts[]` and loads each account's own settings file.
- `TokenPort` threads `accountId` through every method: `get(provider, accountId)`, `set(provider, accountId, tokens)`, `delete(provider, accountId)`, with `provider` fixed to `"m365"`. The same port serves Gmail auth, so keep the M365 implementation provider-agnostic at the port boundary.
- `TokenSet` carries `accessToken`, optional `refreshToken`, `expiresAt`, and `scopes[]`. The adapter owns serialization for both the keychain entry and the age-encrypted fallback file.
- Per-account credentials live in `accounts/m365/<accountName>.yaml` (`name`, `enabled`, `tenantId`, `clientId`); the main `config.yaml` only references enabled names under `m365.accounts`. Config is Zod-validated and frozen at startup, before auth runs, so the command never operates on an unvalidated name.
- Credential-bearing files are written mode 0600 with their `accounts/m365/` parent directory at 0700; broader permissions are refused by default.
- Graph access goes through `@microsoft/microsoft-graph-client`; the adapter builds the client from its loaded per-account credentials and resolved token, and maps provider errors into the shared error shape.
- Errors follow the established adapter pattern: caught at the adapter boundary, logged with the account name in structured context, re-thrown typed. Users see actionable messages, not raw SDK errors or stack traces.
- Conventions: `PascalCase` types, kebab-case files, adapter names ending in `Adapter`, ISO 8601 UTC dates, structured error shape `{ code, message, context? }`.

## UX & Interaction Patterns

- Auth is driven entirely from the CLI, with `--account <name|all>` available on auth (and later fetch/run) commands; `--help` documents multi-account usage with examples.
- The interactive flow must make the wait legible: print the verification URL and user code, and surface polling progress so the user knows the process is alive.
- Under `--account all`, report per-account success or failure as each account finishes instead of stopping at the first problem.
- Error text names the account and the remediation (bad account name, unavailable keychain passphrase, device-code timeout) rather than a stack trace.

## Cross-Story Dependencies

- **Blocked by Epic 1:** needs the `TokenPort` and `TokenSet` definitions, the config/DTO shapes, and the enforced dependency direction established by the foundation epic.
- **Interacts with Epic 11:** the CLI surface, config loading/validation (including the missing-file and account-name checks), and the DI container that instantiates one adapter per account belong to that epic; this story supplies the M365 auth command and adapter behind them.
- **Shared with Epic 3 (Gmail auth):** the same `TokenPort`, keychain service naming scheme, age-fallback passphrase chain, and account-name validation. Implement once so Gmail auth reuses rather than duplicates.
- **Blocks Epics 5, 7, 8 and 9:** fetching, label write-back, backfill/cron orchestration, and rate-limit handling all need a valid per-account authenticated client; they consume this epic's cached tokens and silent-refresh behavior.
