---
status: final
stepsCompleted: ["step-01-validate-prerequisites", "step-02-design-epics", "step-03-create-stories", "step-04-final-validation"]
inputDocuments:
  - "_bmad-output/planning-artifacts/prds/prd-email-agent-2025-01-15/prd.md"
  - "_bmad-output/planning-artifacts/architecture/architecture-email-agent-2025-01-15/ARCHITECTURE-SPINE.md"
---

# email-agent - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for email-agent, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

**Scope decisions (2026-10-08):** v1 is **multi-account per provider** and supports **user-editable taxonomy**. PRD, Architecture spine, and this document have been aligned. There is no UX design contract; the five UX-DRs below are PRD-derived and are flagged as such.

## Requirements Inventory

### Functional Requirements

FR1: M365 Graph Authentication (per account) - The CLI can authenticate one or more Microsoft Graph accounts using existing token cache or device code flow, with `Mail.ReadWrite` and `MailboxSettings.ReadWrite` scopes per account. CLI command `email-classify --auth m365 --account <name|all>` completes per enabled M365 account. Tokens cached and refreshed independently per account; silent refresh on 401. Per-account OS keychain entry `email-classify-m365-<accountName>` with fallback to `~/.config/email-classify/accounts/<accountName>/tokens.json.age`. Account settings live in `accounts/m365/<accountName>.yaml`; `accountName` regex `/^[a-z0-9][a-z0-9_-]{0,31}$/` enforced before any keychain or path lookup.

FR2: Gmail OAuth User Consent Flow (per account) - The CLI can authenticate one or more Gmail accounts via OAuth 2.0 user consent flow (installed app), requesting `gmail.readonly`, `gmail.labels`, `gmail.modify` scopes per account. CLI command `email-classify --auth gmail --account <name|all>` opens browser to Google consent screen for the selected account. Per-account OS keychain entry `email-classify-gmail-<accountName>` with fallback to encrypted file. Automatic token refresh on expiry using that account's refresh token. Account settings live in `accounts/gmail/<accountName>.yaml`; same `accountName` regex as FR-1.

FR3: Taxonomy Definition - The skill defines a default 11-label taxonomy in `taxonomy.yaml` (single source of truth), overridable per-user via `config.yaml` `taxonomyOverrides`. The merged taxonomy is what the classifier sees. Bounds: 1–50 labels total after merge; label names match `/^[A-Za-z0-9 /&'-]+$/`; no duplicate names after merge. Taxonomy is loaded, Zod-validated, frozen, and passed via DI to all components.

FR4: M365 Master Category Sync (per account) - On startup (any mode), for each enabled M365 account, the CLI ensures every taxonomy label exists as an M365 master category via `GET /me/outlook/masterCategories` then `POST /me/outlook/masterCategories` for any missing entry. Idempotent (matches by `displayName`). Taxonomy edits create newly-added labels and leave removed ones untouched in the mailbox. Per-account sync errors do not block other accounts or startup.

FR5: Gmail Label Sync (per account) - On startup (any mode), for each enabled Gmail account, the CLI ensures every taxonomy label exists as a Gmail label via `users.labels.list` then `users.labels.create` for any missing entry. Idempotent (matches by `name`). Per-account sync errors do not block other accounts or startup.

FR6: M365 Message Fetch (Backfill, per account) - In backfill mode, for each enabled M365 account, fetches messages from configured folders using `GET /me/messages` with `$top=100`, `$select=id,internetMessageId,subject,bodyPreview,receivedDateTime,categories,isRead`, and pagination via `@odata.nextLink`. Per-account batch size (default 50, max 100). Returns message DTOs with `internetMessageId`, `categories`, `isRead`, `accountId`. Account failures isolated.

FR7: M365 Message Fetch (Cron/Incremental, per account) - In cron mode, for each enabled M365 account, fetches only messages received since last successful cycle using `$filter=receivedDateTime ge {lastRunTimestamp}` and `$orderby=receivedDateTime asc`. The m365 cycle reads and writes its own cursor file `~/.config/email-classify/state/m365-<accountName>.json`, which stores `lastRunTimestamp` (ISO 8601) and `lastProcessedMessageId`.

FR8: Gmail Message Fetch (Backfill, per account) - In backfill mode, for each enabled Gmail account, fetches all messages from INBOX using `users.messages.list` with `labelIds=INBOX`, `maxResults=100`, page tokens, then `users.messages.batchGet` for `internetMessageId`, `labelIds`, `snippet`, `internalDate`. Per-account batch size (default 50, max 100). Returns DTOs with `internetMessageId`, `labelIds`, `internalDate`, `accountId`.

FR9: Gmail Message Fetch (Cron/Incremental, per account) - In cron mode, for each enabled Gmail account, fetches only messages since last cycle using `users.history.list` with that account's `startHistoryId` and `labelId=INBOX`. The Gmail cycle writes its own cursor file `~/.config/email-classify/state/gmail-<accountName>.json`, storing `lastHistoryId` (the history response's top-level history id, or the pre-walk `users.getProfile` id on a list-path cycle) and the cycle-start `lastRunTimestamp`. On history expiry (Gmail answers `users.history.list` with HTTP 404), the cycle logs a `warn` naming the account and falls back to an INBOX list bounded on the wire by `q=after:<epoch of lastRunTimestamp>`; a purged message's 404 hydration is a per-message skip with a warn naming the id, never the account's failure.

FR10: Classification Prompt & Schema - The skill defines a prompt template (system + user) and a strict JSON output schema: `{ "labels": ["label1", "label2", ...] }` where each label must be from the Taxonomy. Empty array valid. Prompt includes taxonomy list with descriptions, few-shot examples (3–5), instruction to return only valid JSON. Output schema validated via Zod; invalid responses rejected and retried (max 2 retries). Model temperature set to 0.1 (configurable).

FR11: Model Abstraction & Config - The skill accepts a model config object: `{ provider: "jev" | "openai" | "anthropic" | "custom", model: string, apiKeyEnvVar: string, temperature: number, maxTokens: number, extraParams?: object }`. The harness resolves `apiKeyEnvVar` from process env at runtime. Default: `provider: "jev", model: "system1", apiKeyEnvVar: "TYPESAFE_API_KEY", temperature: 0.1, maxTokens: 500`. Custom provider supported via `extraParams`.

FR12: Single-Call Classification - Each message classified in a single model call. Input: subject, bodyPreview (truncated to 2000 chars), sender email/name, receivedDateTime, existing labels. Output: label set. Latency per message < 3s p95 on Jev System1 (target). Token usage logged per message.

FR13: M365 Label Write (per account) - Updates message via `PATCH /me/messages/{id}` on the source account with `categories` array = union of existing categories + new label set. Existing M365 categories preserved; only new taxonomy labels added. If message already has all predicted labels, no API call made. On 404, log warning with account name and message ID; do not fail batch.

FR14: Gmail Label Write (per account) - Applies labels via `users.messages.modify` on the source account with `addLabelIds` = label IDs for predicted labels not already present. Existing Gmail labels preserved. Label name → label ID mapping cached per account from FR-5 sync. On 404, log warning with account name and continue.

FR15: Backfill Execution - Command `email-classify --backfill --source <m365|gmail|all> [--account <name|all>] [--since <ISO-date>] [--batch-size <N>]` processes messages per FR-6/FR-8, classifies per FR-12, writes labels per FR-13/FR-14. `--account` defaults to `all`. Progress logged every 100 messages per account. Idempotency: `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))` stored in `~/.config/email-classify/idempotency.db`. On SIGINT, progress saved per account; re-run resumes.

FR16: Rate Limit Handling - On HTTP 429 (M365) or 429/rateLimitExceeded (Gmail), extracts `Retry-After` header or defaults to exponential backoff (2s, 4s, 8s, 16s, 32s, max 60s). Retries up to 5 times per batch, scoped per account. Backoff state is per account — one account in backoff does not pause others. Logs each backoff event with account name, wait time, and provider.

FR17: Cron Loop - Command `email-classify --cron --interval <minutes> --source <m365|gmail|all> [--account <name|all>]` runs an infinite loop: for each selected account, fetch incremental (FR-7/FR-9) → classify (FR-12) → write labels (FR-13/FR-14) → update state → sleep interval. `--account` defaults to `all`. `--interval` default 15, min 1, max 1440 (24h). Each cycle logs per account: cycle start, messages fetched, classified, labeled, duration, next run at. Per-account error isolation.

FR18: Graceful Shutdown - On SIGINT/SIGTERM, finishes current message, flushes logs, saves state, exits 0. `kill <pid>` or Ctrl+C causes clean exit within 5s. State file consistent on restart.

FR19: Structured Logging - All log lines are JSON with fields: `timestamp` (ISO 8601), `level` (debug/info/warn/error), `source` (m365|gmail|classify|write|state), `message`, `context` (object: messageId, labelSet, durationMs, errorCode, accountId, etc.). Stdout: JSON lines. File: rotating daily, max 7 days, max 100MB each, at `~/.local/share/email-classify/logs/`. Log level configurable via `--log-level` (default: info).

FR20: Metrics Summary - On cron cycle completion and backfill completion, logs a summary: `messagesProcessed`, `messagesLabeled`, `messagesSkipped`, `messagesErrored`, `avgLatencyMs`, `totalTokensIn`, `totalTokensOut`, `estimatedCostUSD`. Summary logged at info level. Cost estimate uses Jev pricing (configurable per-model) or OpenAI pricing. Per-account breakdown in cron mode.

FR21: Config File Schema - Main config at `~/.config/email-classify/config.yaml`; per-account settings live in `~/.config/email-classify/accounts/<m365|gmail>/<accountName>.yaml`. The merged layout supports multiple accounts per provider and user-editable taxonomy. `accountName` regex `/^[a-z0-9][a-z0-9_-]{0,31}$/` enforced before any keychain or path lookup. Bounds: 1–50 labels after merge, label names match `/^[A-Za-z0-9 /&'-]+$/`, no duplicate names. CLI validates config on startup; exits with clear error on invalid schema, naming the offending account and field. All paths support `~` expansion. Environment variable overrides for any field via `EMAIL_CLASSIFY_<SECTION>_<KEY>` and per-account `EMAIL_CLASSIFY_<PROVIDER>_ACCOUNTS_<NAME>_<KEY>`.

### NonFunctional Requirements

NFR1: Local-first, zero-infra - Runs on user's machine via cron; no serverless, Docker, or always-on server for v1.

NFR2: Hexagonal architecture - Skill Core (classification) is pure function with zero I/O, zero deps; all I/O in adapters implementing ports.

NFR3: Single shared MessageDTO - All adapters map to/from one canonical shape (carries `accountId`); prevents translation drift.

NFR4: Dependency direction enforced - core/ (zero deps) ← adapters/ and orch/ (depend on core ports) ← cli/ (wires all). Enforced via tsconfig project references and the `no-restricted-imports` rule in `.oxlintrc.json` (`bun run lint`).

NFR5: Multi-label by default - Classification returns a set of labels from the (possibly user-edited) taxonomy; empty set valid.

NFR6: Idempotency required - Backfill and cron must be safely re-runnable; key = `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))`.

NFR7: Never remove user-applied labels - Label write only adds missing taxonomy labels; preserves existing categories/labels.

NFR8: Single-user, multiple accounts per provider supported - One user can connect multiple M365 accounts and/or multiple Gmail accounts. No multi-tenancy (no isolated tenants).

NFR9: Cron/poll only - No push/webhook real-time for v1.

NFR10: OS keychain for tokens - Per-account entry; encrypted file fallback (age); no separate secrets manager.

NFR11: Model-agnostic skill architecture - Classification logic (prompt, schema, label definitions) decoupled from model/harness. Jev System1 is v1 default; swap via config.

NFR12: Native label write-back - Labels appear in user's actual mail clients (Outlook/Gmail UI), not a side dashboard.

NFR13: Backfill-aware - Idempotent, resumable, rate-limit-friendly for 8k+ existing messages per account.

NFR14: Zero infra cost for v1 - Local only, no cloud services required.

NFR15: TypeScript types for all DTOs, Zod schemas for validation.

NFR16: User-configurable taxonomy - The 11-label taxonomy is the default but users can add/remove/edit label names, descriptions, and colors via `config.yaml` `taxonomyOverrides`. Bounds: 1–50 labels; no duplicate names; removed labels stay in the mailbox until the user deletes them.

### Additional Requirements

- Hexagonal (Ports & Adapters) paradigm with Skill Core as pure function and adapters for M365, Gmail, Model (Jev/OpenAI), Tokens, Idempotency, Scheduling, Logging, Config
- Stack: Node.js 20 LTS, TypeScript 7.x, @typesafe-ai/sdk 0.6.0, @microsoft/microsoft-graph-client 3.0.7, googleapis 184.0.0, better-sqlite3 9.6.x, zod 4.6.5, pino 10.4.0, keytar 7.9.x
- Dependency direction: core/ (zero deps) ← adapters/ (depend on core ports) ← cli/ (wires all)
- 10 Architecture Decisions (AD-1 through AD-10) covering: pure core function, shared MessageDTO (with `accountId`), ModelPort, TokenPort (with `accountId`), IdempotencyPort (key prefix `accountId`), SchedulerPort, LogPort, MailPort (with `accountId`), frozen Config, dependency direction
- Source tree structure: core/ports, core/dto, core/skill, adapters/m365, adapters/gmail, adapters/model, adapters/token, adapters/idempotency, adapters/scheduler, adapters/logger, adapters/config, cli/commands, cli/di, orch/
- Port interfaces: MailPort, ModelPort, TokenPort, IdempotencyPort, SchedulerPort, LogPort, ConfigPort — all port methods that touch an account take an `accountId` parameter
- DTOs: MessageDTO (carries `accountId`), LabelSet, Taxonomy, LabelDef, ModelConfig, TokenSet, FetchOpts (carries `accountId`)
- Configuration loaded once at startup, Zod-validated, frozen, passed via DI context. Main `config.yaml` references per-account files at `accounts/<provider>/<accountName>.yaml`; the DI container loads each referenced per-account file and instantiates one adapter per enabled account
- Structured JSON logging with pino (stdout + rotating file); per-account context via `accountId` field
- SQLite idempotency store at `~/.config/email-classify/idempotency.db` (single store, `accountId`-prefixed keys)
- OS keychain (keytar) with encrypted file fallback (age) for token storage — per-account entries and per-account fallback files
- Per-provider per-account cron state files at `~/.config/email-classify/state/m365-<accountName>.json` and `gmail-<accountName>.json`; a legacy `<accountName>.json` is read back for m365 only, never written again
- Process-level file lock (flock or SQLite `BEGIN IMMEDIATE`) on the idempotency store and per-account state files to prevent concurrent invocations
- Per-account YAML files at mode 0600; `accounts/<provider>/` directories at mode 0700
- Idempotency store has no retention/GC in v1; size bounded by user message volume (deferred to v1.5+)
- 11 Deferred decisions including: delta query vs filter, Gmail historyId expiry fallback (with FR-9 fallback), label re-apply policy, attachment parsing, cost tracking, Cloudflare Worker/MCP harness, threading, eval framework, push/webhook (multi-account and user-editable taxonomy are in scope, not deferred)

### UX Design Requirements

Note: no UX design contract exists. The five UX-DRs below were derived from PRD §4 (4.6, 4.7, 4.8, 4.9) and the skill's CLI-first nature; treat them as PRD-derived rather than a true UX spec until a UX run folder appears.

UX-DR1: CLI Command Interface — Implement intuitive CLI commands: `email-classify --auth m365|gmail --account <name|all>`, `email-classify --backfill --source m365|gmail|all --account <name|all> [--since] [--batch-size]`, `email-classify --cron --interval <minutes> --source m365|gmail|all --account <name|all>`, `email-classify --sync-categories`, with clear help text and error messages.

UX-DR2: Progress Feedback - Show progress during backfill (every 100 messages: processed, labeled, skipped, errors) and cron cycles (cycle start, fetched, classified, labeled, duration, next run).

UX-DR3: Structured Logging Output - JSON logs to stdout with timestamp, level, source, message, context (including `accountId`) for debugging; rotating log files for persistence.

UX-DR4: Configuration Experience - Main YAML config at `~/.config/email-classify/config.yaml` plus per-account YAML files at `~/.config/email-classify/accounts/<provider>/<accountName>.yaml`, with clear structure, `accountName` regex enforced, taxonomy overrides, `~` expansion, env var overrides (`EMAIL_CLASSIFY_<SECTION>_<KEY>`, `EMAIL_CLASSIFY_<PROVIDER>_ACCOUNTS_<NAME>_<KEY>`), validation with clear error messages naming the offending account and field.

UX-DR5: Error Handling UX - Graceful error messages for auth failures, rate limits, network issues, config validation; never crash silently; re-queue failed messages for next cycle; per-account error isolation.

### Requirements Coverage Map

| Requirement | Epic | Stories |
|-------------|------|---------|
| FR1 | Epic 2: M365 Authentication (per account) | Story 2.1 |
| FR2 | Epic 3: Gmail Authentication (per account) | Story 3.1 |
| FR3, FR4, FR5, NFR16 | Epic 4: Taxonomy & Per-Account Category Sync | Story 4.1, 4.2, 4.3 |
| FR6, FR7, FR8, FR9 | Epic 5: Message Fetching (Backfill & Incremental) | Story 5.1, 5.2, 5.3, 5.4 |
| FR10, FR11, FR12, NFR2, NFR5, NFR11 | Epic 6: Classification Engine (Skill Core) | Story 6.1, 6.2, 6.3, 6.4 |
| FR13, FR14, NFR7 | Epic 7: Label Write-Back (per account) | Story 7.1, 7.2 |
| FR15, FR17 | Epic 8: Backfill & Cron Orchestration | Story 8.1, 8.2, 8.3 |
| FR16, FR18 | Epic 9: Resilience (Rate Limits & Graceful Shutdown) | Story 9.1, 9.2 |
| FR19, FR20, NFR15 | Epic 10: Observability (Logging & Metrics) | Story 10.1, 10.2 |
| FR21, NFR4, NFR9, NFR12, NFR14 | Epic 11: Configuration & CLI | Story 11.1, 11.2, 11.3, 11.4 |
| AD-1..AD-10, Stack, Source Tree, NFR1, NFR3, NFR4, NFR6, NFR8, NFR10, NFR13 | Epic 1: Project Foundation & Type System | Story 1.1, 1.2, 1.3 |

## Epic List

### Epic 1: Project Foundation & Type System

**Goal**: A developer can scaffold the repo, define all ports and DTOs, enforce the hexagonal dependency direction, and run a smoke build of the empty core.

**Binds:** AD-1, AD-2, AD-3, AD-4, AD-5, AD-6, AD-7, AD-8, AD-9, AD-10; Stack; Source Tree; NFR1, NFR3, NFR4.

**FRs covered:** none directly (binding epic).

### Epic 2: M365 Authentication (per account)

**Goal**: A user can authenticate one or more Microsoft Graph accounts via device code flow with per-account token persistence and refresh.

**FRs covered:** FR1, NFR10.

### Epic 3: Gmail Authentication (per account)

**Goal**: A user can authenticate one or more Gmail accounts via OAuth 2.0 user consent with per-account token persistence and refresh.

**FRs covered:** FR2, NFR10.

### Epic 4: Taxonomy & Per-Account Category Sync

**Goal**: A user can edit labels in `config.yaml`; the CLI loads the merged taxonomy and ensures those labels exist as M365 categories and Gmail labels for each account.

**FRs covered:** FR3, FR4, FR5, NFR16.

### Epic 5: Message Fetching (Backfill & Incremental)

**Goal**: The system can backfill historical messages across all accounts and incrementally fetch new messages per account for cron mode.

**FRs covered:** FR6, FR7, FR8, FR9, NFR3.

### Epic 6: Classification Engine (Skill Core)

**Goal**: The skill core classifies each message in a single model call using the (possibly user-edited) taxonomy, model-agnostic via the ModelPort.

**FRs covered:** FR10, FR11, FR12, NFR2, NFR5, NFR11.

### Epic 7: Label Write-Back (per account)

**Goal**: The system writes predicted labels to the message in the source mailbox, adding only missing taxonomy labels, never removing user-applied labels.

**FRs covered:** FR13, FR14, NFR7.

### Epic 8: Backfill & Cron Orchestration

**Goal**: A user can run a one-shot backfill or a recurring cron loop that exercises all accounts with isolation and resumability.

**FRs covered:** FR15, FR17, NFR6, NFR8, NFR13.

### Epic 9: Resilience (Rate Limits & Graceful Shutdown)

**Goal**: The system backs off cleanly on 429 / rateLimitExceeded (per account) and exits cleanly on SIGINT/SIGTERM, leaving state consistent.

**FRs covered:** FR16, FR18.

### Epic 10: Observability (Logging & Metrics)

**Goal**: Operators see structured JSON logs to stdout and rotating files, plus per-cycle metrics summaries with cost estimates.

**FRs covered:** FR19, FR20, NFR15.

### Epic 11: Configuration & CLI

**Goal**: A user has a validated, frozen YAML config supporting multiple accounts per provider and user-editable taxonomy, plus an intuitive CLI surface.

**FRs covered:** FR21, NFR4, NFR9, NFR12, NFR14.

---

## Epic 1: Project Foundation & Type System

**Goal**: A developer can scaffold the repo, define all ports and DTOs, enforce the hexagonal dependency direction, and run a smoke build of the empty core.

### Story 1.1: Project Initialization & Dependencies

As a **developer**,
I want **to initialize the Node.js/TypeScript project with all dependencies and the hexagonal directory structure**,
So that **the codebase has a solid foundation with dependency direction enforced**.

**Acceptance Criteria:**

**Given** the project is created
**When** the project is initialized
**Then** it uses Node.js 20 LTS and TypeScript 7.x
**And** dependencies installed: @typesafe-ai/sdk, @microsoft/microsoft-graph-client, @microsoft/microsoft-graph-types, googleapis, better-sqlite3, zod, js-yaml, commander, pino, pino-roll, keytar, age
**And** dev dependencies: typescript, @types/node, @types/better-sqlite3, @types/js-yaml, @types/keytar, vitest, oxlint
**And** directory structure created: core/ports, core/dto, core/skill, adapters/m365, adapters/gmail, adapters/model, adapters/token, adapters/idempotency, adapters/scheduler, adapters/logger, adapters/config, cli/commands, cli/di, orch/, tests/{core,adapters,orch}
**And** tsconfig.json with project references enforcing: core (zero deps) ← adapters (depend on core) ← cli (depends on all)
**And** lint rule `no-restricted-imports` (`oxlint`, configured in `.oxlintrc.json`, run by `bun run lint`) prevents core from importing adapters, cli or orch, and additionally prevents files under `tests/adapters/**` from importing real adapter SDKs (`@microsoft/microsoft-graph-client`, `googleapis`, `@typesafe-ai/sdk`, `openai`) so per-adapter tests use stdlib-only mocks

### Story 1.2: Port Interfaces Definition (per-account)

As a **developer**,
I want **to define all port interfaces in core/ports, with accountId threading through account-touching methods**,
So that **adapters can be instantiated per account and the core remains dependency-free**.

**Acceptance Criteria:**

**Given** the core/ports directory exists
**When** port interfaces are defined
**Then** `MailPort.ts`: `fetchMessages(opts: FetchOpts): Promise<MessageDTO[]>`, `writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void>`, `ensureCategories(accountId: string, labels: LabelDef[]): Promise<void>`
**And** `ModelPort.ts`: `complete(prompt: string, schema: JsonSchema, config: ModelConfig): Promise<unknown>`
**And** `TokenPort.ts`: `get(provider: "m365"|"gmail", accountId: string): Promise<TokenSet>`, `set(provider, accountId, tokens): Promise<void>`, `delete(provider, accountId): Promise<void>`
**And** `IdempotencyPort.ts`: `has(key: string): Promise<boolean>`, `set(key: string): Promise<void>`; key format `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))`
**And** `SchedulerPort.ts`: `runOnce(fn: () => Promise<void>): Promise<void>`, `runInterval(fn: () => Promise<void>, intervalMs: number): Promise<AbortController>`
**And** `LogPort.ts`: `debug(info, context?), info(...), warn(...), error(...)`; context may include `accountId`
**And** `ConfigPort.ts`: `load(): Promise<Config>`
**And** `FetchOpts.ts`: `source: "m365"|"gmail"`, `accountId: string`, `since?: Date`, `batchSize?: number`, `folder?: string`

### Story 1.3: DTOs & Shared Types (with accountId)

As a **developer**,
I want **canonical DTOs and shared types in core/dto, with `accountId` carried by every account-touching DTO**,
So that **all adapters share a single data shape and per-account context cannot be lost**.

**Acceptance Criteria:**

**Given** the core/dto directory exists
**When** DTOs are defined
**Then** `MessageDTO.ts`: `id`, `internetMessageId`, `subject`, `bodyPreview`, `senderEmail`, `senderName`, `receivedDateTime`, `existingLabels: string[]`, `source: "m365"|"gmail"`, `accountId: string`, `raw?: unknown`
**And** `LabelSet.ts`: `labels: string[]` (validated against taxonomy)
**And** `Taxonomy.ts`: array of `LabelDef`
**And** `LabelDef.ts`: `name`, `description`, `m365Color`, `gmailColor`
**And** `ModelConfig.ts`: `provider`, `model`, `apiKeyEnvVar`, `temperature`, `maxTokens`, `extraParams?`
**And** `TokenSet.ts`: `accessToken`, `refreshToken?`, `expiresAt`, `scopes: string[]`
**And** `Config.ts`: `m365.accounts: string[]`, `gmail.accounts: string[]`, `taxonomyOverrides?[]`, `tokenFallback: { passphraseEnvVar: string }`, full validated schema with `accountName` regex enforced

---

## Epic 2: M365 Authentication (per account)

**Goal**: A user can authenticate one or more Microsoft Graph accounts via device code flow with per-account token persistence and refresh.

### Story 2.1: M365 Device Code Authentication (Multi-Account, accountName-validated)

As a **user**,
I want **to authenticate to multiple Microsoft Graph accounts using device code flow**,
So that **I can access all my M365 mailboxes with read/write permissions**.

**Acceptance Criteria:**

**Given** the user runs `email-classify --auth m365 --account <account-name>` (or `--account all`)
**When** the authentication flow completes
**Then** it validates `account-name` against `/^[a-z0-9][a-z0-9_-]{0,31}$/` before any keychain or filesystem lookup, rejecting non-conforming names with a clear error
**And** it initiates device code flow with `Mail.ReadWrite` and `MailboxSettings.ReadWrite` scopes
**And** displays user code and verification URL
**And** polls for token until authorized or timeout (5 min)
**On** success, stores tokens via `TokenPort` with `accountId`
**And** tokens stored in OS keychain (keytar) with service `email-classify-m365-<accountId>`
**And** fallback to encrypted file (`~/.config/email-classify/accounts/m365/<accountId>/tokens.json.age`) if keychain unavailable
**And** when the OS keychain is unavailable, the age passphrase is resolved in this order: env var `Config.tokenFallback.passphraseEnvVar`, then a one-time TTY prompt, then exit 1 with an actionable error if stdin is not a TTY
**And** subsequent runs reuse the cached token until expiry, refreshing silently on expiry with that account's refresh token; a Graph 401 is handled by Epic 5's fetch consumer, which force-refreshes once and retries
**And** multiple accounts can be authenticated independently with different `accountId`s

---

## Epic 3: Gmail Authentication (per account)

**Goal**: A user can authenticate one or more Gmail accounts via OAuth 2.0 user consent with per-account token persistence and refresh.

### Story 3.1: Gmail OAuth User Consent Flow (Multi-Account, accountName-validated)

As a **user**,
I want **to authenticate to multiple Gmail accounts via OAuth 2.0 user consent**,
So that **I can access all my Gmail mailboxes with read/write permissions**.

**Acceptance Criteria:**

**Given** the user runs `email-classify --auth gmail --account <account-name>` (or `--account all`)
**When** the authentication flow completes
**Then** it validates `account-name` against `/^[a-z0-9][a-z0-9_-]{0,31}$/` before any keychain or filesystem lookup, rejecting non-conforming names with a clear error
**And** it initiates OAuth 2.0 installed app flow with `gmail.readonly`, `gmail.labels`, `gmail.modify` scopes
**And** opens browser to Google consent screen with `access_type=offline` and `prompt=consent`
**On** consent, exchanges code for access + refresh tokens
**And** stores tokens via `TokenPort` with `accountId`
**And** tokens stored in OS keychain (keytar) with service `email-classify-gmail-<accountId>`
**And** fallback to encrypted file (`~/.config/email-classify/accounts/gmail/<accountId>/tokens.json.age`) if keychain unavailable
**And** when the OS keychain is unavailable, the age passphrase is resolved in this order: env var `Config.tokenFallback.passphraseEnvVar`, then a one-time TTY prompt, then exit 1 with an actionable error if stdin is not a TTY
**And** automatic token refresh on expiry using that account's refresh token
**And** multiple accounts can be authenticated independently with different `accountId`s

---

## Epic 4: Taxonomy & Per-Account Category Sync

**Goal**: A user can edit labels in `config.yaml`; the CLI loads the merged taxonomy and ensures those labels exist as M365 categories and Gmail labels for each account.

### Story 4.1: Taxonomy Definition & User Overrides

As a **user**,
I want **a default `taxonomy.yaml` plus per-user overrides in `config.yaml`**,
So that **my labels match my workflow and I can add, remove, or edit them**.

**Acceptance Criteria:**

**Given** the skill starts
**When** it loads taxonomy
**Then** `taxonomy.yaml` contains 11 default labels: Action Needed, Waiting/Follow-up, Important, Invoices, Crypto, Business, Family/Friends, Newsletters, Promos, Notifications, Real-estate
**And** each entry has: `name`, `description`, `m365Color` (preset0–preset24), `gmailColor` (hex)
**And** `config.yaml` `taxonomyOverrides[]` can change any label's `name`, `description`, `m365Color`, `gmailColor`
**And** `taxonomyOverrides[]` can add new labels or drop defaults; merged result holds 1–50 labels
**And** validation rejects duplicate names and label names outside `/^[A-Za-z0-9 /&'-]+$/`
**And** merged taxonomy is frozen after load and passed to classification engine

### Story 4.2: M365 Master Category Sync (Multi-Account)

As a **user**,
I want **all merged taxonomy labels to exist as M365 master categories for every account on startup**,
So that **they appear in Outlook/Web UI with correct colors for each account**.

**Acceptance Criteria:**

**Given** the CLI starts with M365 accounts configured
**When** it initializes
**Then** for each enabled M365 account, it calls `GET /me/outlook/masterCategories`
**And** creates missing categories via `POST /me/outlook/masterCategories` with `displayName` and `preset` color from taxonomy
**And** idempotent: re-running does not create duplicates (matches by `displayName`)
**And** taxonomy edits create newly-added labels and leave removed ones untouched in the mailbox
**And** per-account sync errors are logged but do not block other accounts or startup

### Story 4.3: Gmail Label Sync (Multi-Account)

As a **user**,
I want **all merged taxonomy labels to exist as Gmail labels for every account on startup**,
So that **they appear in Gmail UI with correct colors for each account**.

**Acceptance Criteria:**

**Given** the CLI starts with Gmail accounts configured
**When** it initializes
**Then** for each enabled Gmail account, it calls `users.labels.list`
**And** creates missing labels via `users.labels.create` with `name` and hex color from taxonomy
**And** idempotent: re-running does not create duplicates (matches by `name`)
**And** label name → label ID mapping is cached in memory per account for write-back
**And** per-account sync errors are logged but do not block other accounts or startup

---

## Epic 5: Message Fetching (Backfill & Incremental)

**Goal**: The system can backfill historical messages across all accounts and incrementally fetch new messages per account for cron mode.

### Story 5.1: M365 Backfill Message Fetch (Multi-Account)

As a **user**,
I want **to fetch all historical messages from multiple M365 accounts in batches**,
So that **I can classify my existing emails across all accounts**.

**Acceptance Criteria:**

**Given** the user runs `email-classify --backfill --source m365 --account <account-list>`
**When** the backfill starts
**Then** it processes each specified account sequentially
**And** for each account, it fetches messages from configured folders using `GET /me/messages` with `$top=100`, `$select=id,internetMessageId,subject,bodyPreview,receivedDateTime,categories,isRead`
**And** it handles pagination via `@odata.nextLink` until complete per account
**And** batch size is configurable per account (default 50, max 100)
**And** returned MessageDTOs include `internetMessageId`, `categories`, `isRead`, and `accountId`

### Story 5.2: M365 Incremental Message Fetch (Cron, Multi-Account)

As a **user**,
I want **to fetch only new messages since the last cron run per account**,
So that **ongoing classification is efficient across all accounts**.

**Acceptance Criteria:**

**Given** the cron mode runs with multiple M365 accounts
**When** it fetches messages
**Then** it processes each account sequentially
**And** for each account, it uses `$filter=receivedDateTime ge {lastRunTimestamp}` with that account's timestamp
**And** it reads `lastRunTimestamp` from the account's m365 cursor file `~/.config/email-classify/state/m365-<accountName>.json`
**And** it only returns messages newer than the timestamp per account
**And** on successful cycle, that account's `lastRunTimestamp` is updated

### Story 5.3: Gmail Backfill Message Fetch (Multi-Account)

As a **user**,
I want **to fetch all historical messages from multiple Gmail accounts in batches**,
So that **I can classify my existing Gmail emails across all accounts**.

**Acceptance Criteria:**

**Given** the user runs `email-classify --backfill --source gmail --account <account-list>`
**When** the backfill starts
**Then** it processes each specified account sequentially
**And** for each account, it fetches messages using `users.messages.list` with `labelIds=INBOX`, `maxResults=100`, page tokens
**And** it batch-gets details via `users.messages.batchGet` for `internetMessageId`, `labelIds`, `snippet`, `internalDate`
**And** batch size is configurable per account (default 50, max 100)
**And** returned MessageDTOs include `internetMessageId`, `labelIds`, `internalDate`, and `accountId`

### Story 5.4: Gmail Incremental Message Fetch (Cron, Multi-Account, with history-expiry fallback)

As a **user**,
I want **to fetch only new Gmail messages since the last cron run using history ID per account, with a safe fallback when history expires**,
So that **ongoing Gmail classification is efficient across all accounts and never silently misses messages**.

**Acceptance Criteria:**

**Given** the cron mode runs with multiple Gmail accounts
**When** it fetches messages
**Then** it processes each account sequentially
**And** for each account, it uses `users.history.list` with that account's `startHistoryId` and `labelId=INBOX`
**And** it only returns messages with history ID > `lastHistoryId` per account
**And** on successful cycle, that account's `lastHistoryId` is updated
**And** on history expiry (Gmail answers `users.history.list` with HTTP 404), the cycle logs a `warn` naming the account and falls back to an INBOX list bounded by `q=after:<epoch of lastRunTimestamp>`, recording the pre-walk profile history id on a successful cycle
**And** a purged message's 404 hydration is skipped with a warn naming the id, without failing the account

---

## Epic 6: Classification Engine (Skill Core)

**Goal**: The skill core classifies each message in a single model call using the (possibly user-edited) taxonomy, model-agnostic via the ModelPort.

### Story 6.1: Classification Prompt Template

As a **developer**,
I want **a prompt template (system + user) that produces valid multi-label JSON against the loaded taxonomy**,
So that **the model returns only labels from the active taxonomy**.

**Acceptance Criteria:**

**Given** the classification engine runs
**When** it builds the prompt
**Then** system prompt includes: the active taxonomy (names + descriptions), 3–5 few-shot examples, instruction to return only valid JSON
**And** user prompt includes: subject, bodyPreview (truncated to 2000 chars), sender email/name, receivedDateTime, existing labels
**And** output schema: `{ "labels": ["label1", "label2", ...] }` where each label must be from the active taxonomy
**And** empty array is a valid output
**And** prompt is parameterized by the merged taxonomy (user edits take effect on next load)

### Story 6.2: Output Schema Validation (Zod)

As a **developer**,
I want **Zod schema validation on model output with bounded retries**,
So that **invalid responses are caught and retried automatically**.

**Acceptance Criteria:**

**Given** the model returns a response
**When** validation runs
**Then** it validates against Zod schema: `labels` is `string[]`, each string in the active taxonomy
**And** invalid responses are rejected and retried (max 2 retries)
**And** on max retries exceeded, returns empty label set and logs an error with the raw response and reason
**And** model temperature is configurable (default 0.1)

### Story 6.3: Model Abstraction Layer (ModelPort)

As a **developer**,
I want **a `ModelPort` adapter interface with Jev and OpenAI implementations**,
So that **swapping models requires only a config change**.

**Acceptance Criteria:**

**Given** the classification engine calls `ModelPort` (reconciled to the classification seam — spine AD-3, Story 6.3 decision 1)
**When** it calls `complete(prompt: PromptParts, taxonomy, config)`
**Then** `JevAdapter` uses `@typesafe-ai/sdk`, reads the API key from the env var named by `config.apiKeyEnvVar` (default `TYPESAFE_API_KEY`)
**And** `OpenAIAdapter` uses the OpenAI SDK, reading the API key from `config.apiKeyEnvVar`
**And** both implement `ModelPort` identically; no `JsonSchema` crosses the port
**And** the factory selects the adapter: `"jev" | "openai"` implemented, `"custom"` routed to the OpenAI adapter (`extraParams` as client options), `"anthropic"` a typed `UNSUPPORTED_PROVIDER` naming the remedy
**And** Jev maps the prompt halves to one joined `state` string and one `noul` question per taxonomy label, thresholded at `config.labelThreshold ?? 0.5`; `temperature`/`maxTokens` are not sent to Jev (the API rejects unknown request fields — verified 2026-10-09)
**And** wiring-time validation: the factory rejects an unknown provider and an unresolvable `apiKeyEnvVar` at construction
**And** default config: `provider="jev"`, `model="jev-latest"` (the original `system1` is a model-class name; the API's models are `jev-latest` and `jev-preview`), `apiKeyEnvVar="TYPESAFE_API_KEY"`, `temperature=0.1`, `maxTokens=500`

### Story 6.4: Single-Call Classification Function

As a **developer**,
I want **a pure classification function that orchestrates prompt → model → validation**,
So that **each message is classified in one model call with full observability**.

**Acceptance Criteria:**

**Given** a `MessageDTO` and the active taxonomy
**When** `classify(options: ClassifyOptions)` is called with `{ message, taxonomy, model: ModelPort, config: ModelConfig, logPort: LogPort, context? }` (reconciled 2026-10-09, Story 6.4 decisions 6-7 — composition in `orch/classify.ts`, options-object idiom per 6.2's precedent)
**Then** it builds the prompt from the template (6.1's `buildPrompt`, core-pure), calls `ModelPort.complete()` through 6.2's `completeWithRetry`, validates the output
**And** returns `LabelSet` (validated labels array)
**And** latency per message < 3s p95 on Jev System1 (target, not hard SLA)
**And** token usage logged per message (input/output tokens)
**And** engine logic stays pure: `buildPrompt` is zero-dep core; all I/O arrives via the injected `ModelPort`/`LogPort` from the application layer

---

## Epic 7: Label Write-Back (per account)

**Goal**: The system writes predicted labels to the message in the source mailbox, adding only missing taxonomy labels, never removing user-applied labels.

### Story 7.1: M365 Label Write (Multi-Account)

As a **user**,
I want **classified labels written as M365 categories on messages per account**,
So that **they appear in Outlook/Web UI for each account**.

**Acceptance Criteria:**

**Given** a message is classified with a label set for an account
**When** the label write executes
**Then** it calls `PATCH /me/messages/{id}` with `categories` = union of existing + new labels for that account
**And** existing M365 categories are preserved
**And** only new taxonomy labels are added
**And** if the message already has all predicted labels, no API call is made
**And** on 404 (message moved/deleted), a warning is logged with account name and message ID, and the batch continues

### Story 7.2: Gmail Label Write (Multi-Account)

As a **user**,
I want **classified labels applied as Gmail labels on messages per account**,
So that **they appear in Gmail UI for each account**.

**Acceptance Criteria:**

**Given** a message is classified with a label set for an account
**When** the label write executes
**Then** it calls `users.messages.modify` with `addLabelIds` for predicted labels not already present for that account
**And** existing Gmail labels are preserved
**And** label name → label ID mapping is cached from sync per account
**And** on 404, a warning is logged with account name and message ID, and the batch continues

---

## Epic 8: Backfill & Cron Orchestration

**Goal**: A user can run a one-shot backfill or a recurring cron loop that exercises all accounts with isolation and resumability.

### Story 8.1: Backfill Mode Execution (Multi-Account)

As a **user**,
I want **to run a one-shot backfill that processes all historical messages across multiple accounts**,
So that **my existing emails across all accounts get classified**.

**Acceptance Criteria:**

**Given** the user runs `email-classify --backfill --source m365|gmail|all --account <account-list> [--since] [--batch-size]`
**When** the command executes
**Then** it processes each specified account sequentially
**And** for each account: fetch per FR-6/FR-8, classify per FR-12, write labels per FR-13/FR-14
**And** `--since` filters messages received after date per account (default: all time)
**And** `--batch-size` controls fetch batch per account (default 50, max 100)
**And** progress is logged every 100 messages per account: processed, labeled, skipped, errors

### Story 8.2: Idempotency & Resume (Multi-Account)

As a **user**,
I want **backfill to be resumable after interruption per account**,
So that **I don't lose progress if the process is killed**.

**Acceptance Criteria:**

**Given** a message is processed for an account
**When** the idempotency key is computed (`sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))`)
**Then** it checks the **single, shared** SQLite store at `~/.config/email-classify/idempotency.db` (one database, all accounts; rows are partitioned by the `accountId` prefix baked into every key, not by per-account files)
**And** if the key exists, the message is skipped
**And** if the key does not exist, the message is processed and the key is stored
**And** the CLI acquires a process-level file lock covering the idempotency store and the per-account state files; concurrent invocations exit 1 with a clear "another email-classify run is in progress" error
**And** on SIGINT, progress is saved per account
**And** re-running with the same args resumes from where it left off per account

### Story 8.3: Cron Mode Loop (Multi-Account)

As a **user**,
I want **a recurring cron mode that classifies new mail on a configurable schedule with per-account isolation**,
So that **all my inboxes stay labeled automatically**.

**Acceptance Criteria:**

**Given** the user runs `email-classify --cron --interval <minutes> --source m365|gmail|all --account <account-list>`
**When** the cron loop runs
**Then** it processes each specified account sequentially per cycle
**And** for each account: fetch incremental → classify → write labels → update state → sleep interval
**And** interval is configurable (default 15, min 1, max 1440)
**And** each cycle logs per account: cycle start, messages fetched, classified, labeled, duration, next run at
**And** on classification error for one account: log error with account name, re-queue the failed message for that account's next cycle; other accounts continue
**And** on fetch/write error: log error, back off 30s, retry same cycle once for that account, then continue to next interval

---

## Epic 9: Resilience (Rate Limits & Graceful Shutdown)

**Goal**: The system backs off cleanly on 429 / rateLimitExceeded (per account) and exits cleanly on SIGINT/SIGTERM, leaving state consistent.

### Story 9.1: Rate Limit Handling (Multi-Account)

As a **user**,
I want **automatic rate-limit handling with exponential backoff, scoped per account**,
So that **backfill completes without manual intervention across all accounts**.

**Acceptance Criteria:**

**Given** an HTTP 429 or `rateLimitExceeded` response for an account
**When** the fetch or write occurs
**Then** it extracts the `Retry-After` header or defaults to exponential backoff (2s, 4s, 8s, 16s, 32s, max 60s)
**And** it retries up to 5 times per batch per account
**And** each backoff event is logged with wait time and account name
**And** one account in backoff does not pause the others
**And** backfill completes 8000+ messages per account without manual intervention under typical Graph/Gmail limits

### Story 9.2: Graceful Shutdown (Multi-Account)

As a **user**,
I want **the running process to shut down cleanly on SIGINT/SIGTERM with per-account state**,
So that **state is consistent on restart for all accounts**.

**Acceptance Criteria:**

**Given** the process receives SIGINT or SIGTERM
**When** the signal is handled
**Then** it finishes the current message for the current account
**And** flushes logs
**And** saves state (`lastRunTimestamp`, `lastHistoryId`) for every account that was being processed
**And** exits with code 0 within 5 seconds
**And** on restart, state files are consistent for all accounts

---

## Epic 10: Observability (Logging & Metrics)

**Goal**: Operators see structured JSON logs to stdout and rotating files, plus per-cycle metrics summaries with cost estimates.

### Story 10.1: Structured JSON Logging (Pino)

As a **developer**,
I want **structured JSON logging via Pino with rotating file output and per-account context**,
So that **all operations are observable and debuggable per account**.

**Acceptance Criteria:**

**Given** the application runs
**When** any log event occurs
**Then** stdout emits JSON lines: `timestamp` (ISO 8601), `level` (debug/info/warn/error), `source` (m365|gmail|classify|write|state), `message`, `context` (object with messageId, labelSet, durationMs, errorCode, `accountId`, etc.)
**And** file output: rotating daily, max 7 days, max 100MB each, at `~/.local/share/email-classify/logs/`
**And** log level configurable via `--log-level` (default: info) and `config.yaml`
**And** `LogPort` adapter wraps Pino and implements the `LogPort` interface

### Story 10.2: Metrics Summary & Cost Tracking

As a **user**,
I want **metrics summary on cron cycle and backfill completion with cost estimation**,
So that **I can monitor performance and API costs per cycle and per account**.

**Acceptance Criteria:**

**Given** a cron cycle or backfill completes
**When** the cycle ends
**Then** it logs a summary at info level: `messagesProcessed`, `messagesLabeled`, `messagesSkipped`, `messagesErrored`, `avgLatencyMs`, `totalTokensIn`, `totalTokensOut`, `estimatedCostUSD`
**And** the cost estimate uses Jev pricing (configurable per-model) or OpenAI pricing based on the configured provider
**And** cron summaries include a per-account breakdown
**And** metrics are emitted via `LogPort` (structured JSON)

---

## Epic 11: Configuration & CLI

**Goal**: A user has a validated, frozen YAML config supporting multiple accounts per provider and user-editable taxonomy, plus an intuitive CLI surface.

### Story 11.1: Config File Loading & Validation (Multi-Account via Per-Account Files, Taxonomy Overrides)

As a **user**,
I want **a main `config.yaml` plus per-account files at `accounts/<provider>/<accountName>.yaml`, loaded, validated, and frozen at startup**,
So that **configuration is correct, frozen, and consistent across all accounts**.

**Acceptance Criteria:**

**Given** the CLI starts
**When** it loads config from `~/.config/email-classify/config.yaml`
**Then** it loads the merged taxonomy against Zod: 1–50 labels, names match `/^[A-Za-z0-9 /&'-]+$/`, no duplicates
**And** it resolves every name in `m365.accounts: [name, ...]` and `gmail.accounts: [name, ...]` against `accounts/m365/<name>.yaml` or `accounts/gmail/<name>.yaml`, fails with a single error report listing every missing file, schema error, and offending account+field (no fail-fast at the first error)
**And** it validates `accountName` against `/^[a-z0-9][a-z0-9_-]{0,31}$/` before any keychain or filesystem lookup, so names cannot escape their directory
**And** it validates `Config.tokenFallback.passphraseEnvVar` as a non-empty string
**And** all paths support `~` expansion
**And** the merged `Config` object is frozen after validation and passed via DI
**And** if `config.yaml` is missing, the CLI exits 1 with a clear error pointing at `config.yaml.example` in the repo
**And** per-account YAML files are created with mode 0600 and the `accounts/<provider>/` parent directories with mode 0700; the CLI refuses to load a file with broader permissions (configurable strictness, default strict)

### Story 11.2: Environment Variable Overrides (Multi-Account)

As a **user**,
I want **to override any config field via environment variables, including per-account settings**,
So that **secrets and environment-specific settings don't need config-file changes**.

**Acceptance Criteria:**

**Given** an environment variable `EMAIL_CLASSIFY_<SECTION>_<KEY>` is set
**When** config is loaded
**Then** it overrides the corresponding config field
**And** per-account overrides use `EMAIL_CLASSIFY_<PROVIDER>_ACCOUNTS_<NAME>_<KEY>` (e.g., `EMAIL_CLASSIFY_M365_ACCOUNTS_WORK_ENABLED=false` disables the M365 account named `work`)
**And** env vars take precedence over the config file
**And** env overrides are parsed and validated against the same Zod schema as the YAML config; invalid values exit 1 with the env var name and a parse-error message

### Story 11.3: CLI Commands & Help (Multi-Account)

As a **user**,
I want **intuitive CLI commands with account selection and clear help**,
So that **I can use the tool across multiple accounts without reading documentation**.

**Acceptance Criteria:**

**Given** the user runs `email-classify --help`
**When** help is displayed
**Then** it shows all commands: `--auth`, `--backfill`, `--cron`, `--sync-categories`
**And** each command shows `--account <name|all>` option
**And** examples show multi-account usage
**And** error messages are clear and actionable (not stack traces)

### Story 11.4: Dependency Injection & Wiring (Per Account)

As a **developer**,
I want **a DI container that wires ports to per-account adapters at startup**,
So that **components are loosely coupled and testable per account**.

**Acceptance Criteria:**

**Given** the CLI starts
**When** the DI container is created
**Then** it iterates the enabled account names from `Config.m365.accounts[]` and `Config.gmail.accounts[]`, loads each referenced `accounts/<provider>/<accountName>.yaml`, and instantiates one adapter per account (`MailPort`, `TokenPort`)
**And** shared singletons are created once: `ModelPort` (Jev/OpenAI), `IdempotencyPort` (SQLite), `SchedulerPort` (SimpleScheduler), `LogPort` (PinoLogger), `ConfigPort` (ConfigLoader)
**And** the frozen `Config` (with per-account settings and merged taxonomy) is passed to all components
**And** dependency direction is enforced: core ← adapters ← cli