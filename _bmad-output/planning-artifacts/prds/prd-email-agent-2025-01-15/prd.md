---
title: "Email Classification Agent Skill"
created: "2025-01-15"
updated: "2025-01-15"
---

# PRD: Email Classification Agent Skill

## 0. Document Purpose

This PRD defines the requirements for a **local CLI skill** that classifies emails from Microsoft 365 and Gmail using a multi-label taxonomy, with Jev System1 as the default model. It is written for the solo builder (Loki) and any downstream workflow owners (architecture, epics/stories, implementation). The PRD builds on the product brief (`_bmad-output/planning-artifacts/briefs/brief-email-agent-2025-01-15/brief.md`) and does not duplicate it — it refines into implementable functional requirements. Glossary-anchored vocabulary is used throughout; FRs are globally numbered (FR-1…FR-N) for stable cross-references.

## 1. Vision

A model-agnostic email classification skill that runs locally, connects to M365 (Graph, read+write) and Gmail (OAuth), fetches messages in batches, classifies each against an 11-label taxonomy using Jev System1 (configurable default), and writes labels back as native M365 categories and Gmail labels. V1 tackles an 8000+ email backfill plus ongoing cron-based classification (default 15 min). The skill is architected so the classifier (prompt + schema + label definitions + model config) is decoupled from the harness — it can be dropped into a Cloudflare Worker, MCP server, or any other runtime without rewrite. Vision: this classification engine becomes the brain of a fully autonomous email agent that triages, drafts, and acts on mail.

## 2. Target User

### 2.1 Jobs To Be Done

- **Functional**: "When my inbox has 8000+ unread emails, I need them automatically labeled so I can triage what matters without reading every message."
- **Emotional**: "I want the anxiety of an unmanageable inbox gone — I want to open my mail client and see only what needs my attention."
- **Contextual**: "I use two mail systems (M365 for work, Gmail for personal). I need one tool that handles both, writes labels natively so they're visible everywhere, and runs on my machine without cloud infra."

### 2.2 Non-Users (v1)

- Other users / multi-tenancy — this is a single-user, single-machine tool.
- Non-technical users — requires CLI comfort, Node/TypeScript environment, API keys.
- Anyone needing real-time push classification — v1 is cron/poll only.

### 2.3 Key User Journeys

- **UJ-1. Loki runs backfill on 8000+ existing M365 emails.**
  - **Persona + context:** Solo technical user, M365 Graph already authenticated with read+write, 8000+ unread in primary inbox.
  - **Entry state:** CLI installed, `TYPESAFE_API_KEY` in env, M365 token cached, Gmail not yet connected.
  - **Path:** Runs `email-classify --backfill --source m365`. Tool fetches messages in batches of 50–100, creates M365 master categories for the 11 labels (idempotent), classifies each message via Jev System1, writes `categories` array on each message. Logs progress (JSON, stdout + rotating file). Resumes on interruption via message-ID + label-hash idempotency key.
  - **Climax:** All 8000+ messages processed; inbox shows colored categories in Outlook/Web. Spot-check of 50 messages shows ≥90% label accuracy.
  - **Resolution:** Backfill complete. Cron mode can now take over for new mail.
  - **Edge case:** Rate limit (429) hit mid-backfill — exponential backoff kicks in, run resumes automatically.

- **UJ-2. Loki enables cron mode for ongoing classification.**
  - **Persona + context:** Same user, backfill done, wants new mail labeled within 15 minutes.
  - **Entry state:** Backfill complete, config file with cron interval (default 15 min), M365 + Gmail both authenticated.
  - **Path:** Runs `email-classify --cron`. Tool enters loop: fetch unread/recent since last run → classify → write labels → sleep until next interval. Structured logs each cycle.
  - **Climax:** New email arrives, next cron cycle picks it up, labels appear in Outlook/Gmail within 15 min.
  - **Resolution:** Cron runs indefinitely; user checks logs only on error.
  - **Edge case:** Jev API transient error — retry with backoff, message re-queued for next cycle.

- **UJ-3. Loki connects Gmail and runs classification there.**
  - **Persona + context:** Same user, M365 working, now adding personal Gmail.
  - **Entry state:** M365 working, Gmail OAuth credentials (client ID/secret) in config.
  - **Path:** Runs `email-classify --auth gmail` → browser opens OAuth consent → tokens stored in OS keychain/local file. Then runs `--backfill --source gmail` or `--cron`.
  - **Climax:** Gmail labels created (matching 11 taxonomy), messages labeled, visible in Gmail UI.
  - **Resolution:** Both mail systems classified by same skill, same model, same taxonomy.
  - **Edge case:** OAuth token refresh fails — tool prompts for re-auth, caches new token.

- **UJ-4. Loki swaps the model from Jev System1 to GPT-4o-mini.**
  - **Persona + context:** Same user, wants to test cheaper/faster model.
  - **Entry state:** Skill running with Jev, config has `model: jev-system1`.
  - **Path:** Edits config: `model: gpt-4o-mini`, adds `OPENAI_API_KEY`. Runs `--cron` or `--backfill`.
  - **Climax:** Classification works with new model; only config changed, no code changes.
  - **Resolution:** Model-agnostic architecture verified.
  - **Edge case:** New model returns malformed label set — validation catches, logs error, message re-queued.

## 3. Glossary

- **Skill** — The portable classification unit: prompt template, JSON output schema, label definitions, model configuration. Harness-agnostic; can run in local CLI, Cloudflare Worker, MCP server, etc.
- **Harness** — The runtime that executes the skill (local Node CLI, Cloudflare Worker, MCP server). Provides auth, scheduling, I/O, logging.
- **Taxonomy** — The fixed set of 11 labels: `Action Needed`, `Waiting/Follow-up`, `Important`, `Invoices`, `Crypto`, `Business`, `Family/Friends`, `Newsletters`, `Promos`, `Notifications`, `Real-estate`.
- **Label Set** — The multi-label output for a single email: a subset of the Taxonomy (e.g., `["Action Needed", "Business", "Crypto"]`). Empty set allowed (no labels match).
- **Master Category (M365)** — An Outlook category defined in the user's master list via `POST /me/outlook/masterCategories` (displayName + preset color). Created once per label at startup.
- **Message Categories (M365)** — The `categories` property on a `message` resource (`string[]`). Updated via `PATCH /messages/{id}` to apply/remove labels.
- **Gmail Label** — A user-created label in Gmail (via Gmail API `users.labels.create`). Applied to messages via `users.messages.modify` with `addLabelIds`.
- **Idempotency Key** — `sha256(message.internetMessageId + "|" + sorted(labelSet).join(","))`. Used to skip re-processing already-classified messages during backfill/resume.
- **Backfill Mode** — One-shot operation that processes all historical messages (configurable date range, default: all) in batches, with resume capability.
- **Cron Mode** — Recurring operation that polls for new/unread messages since last successful run, classifies, and writes labels. Interval configurable (default 15 min).
- **Jev System1** — Typesafe's reasoning model, accessed via `TYPESAFE_API_KEY`. Default model for v1.
- **Model Config** — YAML/JSON file specifying `provider`, `model`, `apiKeyEnvVar`, `temperature`, `maxTokens`, and any provider-specific params.

## 4. Features

### 4.1 Authentication & Token Management

**Description:** Handles OAuth for Gmail and token caching for M365, per account. One user may have multiple M365 and/or multiple Gmail accounts; each account authenticates and refreshes independently. Tokens stored securely in OS keychain or local encrypted file. Realizes UJ-1, UJ-3.

**Functional Requirements:**

#### FR-1: M365 Graph Authentication

The CLI can authenticate one or more Microsoft Graph accounts using existing token cache or device code flow, with `Mail.ReadWrite` and `MailboxSettings.ReadWrite` scopes per account. Realizes UJ-1, UJ-3.

**Consequences (testable):**
- CLI command `email-classify --auth m365 --account <name|all>` (or interactive account picker) completes per enabled M365 account without error when valid tenant/app config exists.
- Tokens cached and refreshed independently per account; silent refresh on 401 using that account's refresh token.
- Tokens stored per-account in OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service) under service `email-classify-m365-<accountName>`, with fallback to encrypted file at `~/.config/email-classify/accounts/<accountName>/tokens.json.age`.
- User configures one or more accounts in `~/.config/email-classify/accounts/m365/<accountName>.yaml` (per-account file). The main `config.yaml` references enabled accounts by name under `m365.accounts: [name, ...]`.
- `accountName` is bound to `/^[a-z0-9][a-z0-9_-]{0,31}$/` and used directly as a directory name; the CLI rejects non-conforming names before any path or keychain lookup.
- **Encrypted-file fallback (age) key model** (resolved from §9 deferred): the adapter reads the OS keychain first. If the keychain is unavailable, the adapter reads the passphrase from the env var named by `Config.tokenFallback.passphraseEnvVar` (default `EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE`). If the env var is unset and stdin is a TTY, the CLI prompts once at startup. If the env var is unset and stdin is not a TTY, the CLI exits 1 with an actionable error naming the env var.

#### FR-2: Gmail OAuth User Consent Flow

The CLI can authenticate one or more Gmail accounts via OAuth 2.0 user consent flow (installed app), requesting `gmail.readonly`, `gmail.labels`, `gmail.modify` scopes per account. Realizes UJ-3.

**Consequences (testable):**
- CLI command `email-classify --auth gmail --account <name|all>` (or interactive picker) opens browser to Google consent screen for the selected account.
- On consent, access + refresh tokens stored per-account in OS keychain under service `email-classify-gmail-<accountName>`, or `~/.config/email-classify/accounts/<accountName>/tokens.json.age` (encrypted).
- Automatic token refresh on expiry using that account's refresh token; re-auth prompt only on revoked/invalid refresh token.
- User configures one or more accounts in `~/.config/email-classify/accounts/gmail/<accountName>.yaml` (per-account file). The main `config.yaml` references enabled accounts by name under `gmail.accounts: [name, ...]`.
- `accountName` is bound to `/^[a-z0-9][a-z0-9_-]{0,31}$/` and used directly as a directory name; the CLI rejects non-conforming names before any path or keychain lookup.
- **Encrypted-file fallback (age) key model** (resolved from §9 deferred): same model as FR-1 — OS keychain first, then `Config.tokenFallback.passphraseEnvVar` env var, then TTY prompt, then exit 1 with an actionable error when stdin is not a TTY and the env var is unset.

**Out of Scope:**
- Service account / domain-wide delegation (not needed for personal Gmail).
- IMAP / app password fallback.

### 4.2 Taxonomy & Category Management

**Description:** Loads the default 11-label taxonomy from `taxonomy.yaml` and merges user overrides from `config.yaml`. Ensures the merged labels exist as M365 master categories and Gmail labels for each account before classification. Idempotent create-on-startup. Realizes UJ-1, UJ-3, UJ-4.

**Functional Requirements:**

#### FR-3: Taxonomy Definition

The skill defines a default 11-label taxonomy in `taxonomy.yaml` (single source of truth), overridable per-user via `config.yaml`. The merged taxonomy is what the classifier sees. Realizes UJ-1, UJ-3, UJ-4.

**Consequences (testable):**
- Default `taxonomy.yaml` contains 11 entries (Action Needed, Waiting/Follow-up, Important, Invoices, Crypto, Business, Family/Friends, Newsletters, Promos, Notifications, Real-estate).
- Each entry has: `name`, `description`, `m365Color` (preset0–preset24), `gmailColor` (hex).
- `config.yaml` can override any label's `name`, `description`, `m365Color`, `gmailColor`; can add new labels or remove defaults. Bounds: 1–50 labels total, label names match `/^[A-Za-z0-9 /&'-]+$/`, no duplicate names after merge.
- Taxonomy is loaded once at startup, Zod-validated, frozen, and passed via DI to all components.

#### FR-4: M365 Master Category Sync (per account)

On startup (any mode), for each enabled M365 account, the CLI ensures every taxonomy label exists as an M365 master category via `GET /me/outlook/masterCategories` then `POST /me/outlook/masterCategories` for any missing entry. Realizes UJ-1, UJ-3.

**Consequences (testable):**
- After first run, `GET /me/outlook/masterCategories` returns every taxonomy label for that account.
- Re-running does not create duplicates (matches by `displayName`); re-running after taxonomy edits creates any newly-added labels and leaves removed ones untouched in the mailbox (taxonomy removal is a user decision, never auto-deleted by the CLI).
- Each created category uses the taxonomy's `m365Color` preset.
- Sync errors on one account do not block other accounts or startup; each account logs success/failure independently.

#### FR-5: Gmail Label Sync (per account)

On startup (any mode), for each enabled Gmail account, the CLI ensures every taxonomy label exists as a Gmail label via `users.labels.list` then `users.labels.create` for any missing entry. Realizes UJ-1, UJ-3.

**Consequences (testable):**
- After first run, `users.labels.list` returns every taxonomy label for that account.
- Re-running does not create duplicates (matches by `name`); re-running after taxonomy edits creates newly-added labels and leaves removed ones untouched.
- Each created label uses the taxonomy's `gmailColor` hex.
- Sync errors on one account do not block other accounts or startup; per-account success/failure logged.

### 4.3 Message Fetching & Batching

**Description:** Fetches messages from each enabled M365 and Gmail account in configurable batches, with pagination, delta query (M365), and history ID (Gmail) for efficient incremental polling. Respects rate limits; one account's failure does not stop others. Realizes UJ-1, UJ-2, UJ-3.

**Functional Requirements:**

#### FR-6: M365 Message Fetch (Backfill, per account)

In backfill mode, for each enabled M365 account, fetches messages from configured folders (default: Inbox) using `GET /me/messages` with `$top=100`, `$select=id,internetMessageId,subject,bodyPreview,receivedDateTime,categories,isRead`, and pagination via `@odata.nextLink`. Realizes UJ-1.

**Consequences (testable):**
- Backfill processes all messages in Inbox (configurable folder list) for each selected account.
- Batch size configurable per account (default 50, max 100 per Graph limits).
- Returns message DTOs with `internetMessageId` (idempotency key), `categories` (current labels), `isRead`, `accountId`.
- Handles `@odata.nextLink` pagination until complete per account before moving on.
- Account failures isolated: one account failing does not abort the others; errors logged per account.

#### FR-7: M365 Message Fetch (Cron/Incremental, per account)

In cron mode, for each enabled M365 account, fetches only messages received since last successful cycle for that account, using `$filter=receivedDateTime ge {lastRunTimestamp}` and `$orderby=receivedDateTime asc`. Realizes UJ-2.

**Consequences (testable):**
- Per-account state file at `~/.config/email-classify/state/<accountName>.json` stores `lastRunTimestamp` (ISO 8601) and `lastProcessedMessageId`.
- Fetch returns only messages newer than `lastRunTimestamp` per account.
- On successful cycle for an account, that account's `lastRunTimestamp` updates to the cycle start time.

#### FR-8: Gmail Message Fetch (Backfill, per account)

In backfill mode, for each enabled Gmail account, fetches all messages from INBOX using `users.messages.list` with `labelIds=INBOX`, `maxResults=100`, page tokens. Then batch-gets details via `users.messages.batchGet` for `internetMessageId`, `labelIds`, `snippet`, `internalDate`. Realizes UJ-3.

**Consequences (testable):**
- Backfill processes all messages in INBOX (configurable label list) for each selected account.
- Batch size configurable per account (default 50, max 100 per Gmail limits).
- Returns message DTOs with `internetMessageId`, `labelIds` (current labels), `internalDate`, `accountId`.
- Account failures isolated; per-account error logging.

#### FR-9: Gmail Message Fetch (Cron/Incremental, per account)

In cron mode, for each enabled Gmail account, fetches only messages since last successful cycle for that account, using `users.history.list` with that account's `startHistoryId` and `labelId=INBOX`. Realizes UJ-2, UJ-3.

**Consequences (testable):**
- Per-account state stores `lastHistoryId` at `~/.config/email-classify/state/<accountName>.json`.
- Fetch returns only messages with history ID greater than `lastHistoryId` per account.
- On successful cycle for an account, `lastHistoryId` updates to the latest processed for that account.
- On history-expiry detection (Gmail returns `historyId` < requested `startHistoryId`), fall back to a full INBOX list with `$since=lastRunTimestamp`; log a warn event with the account name.

### 4.4 Classification Engine (Skill Core)

**Description:** The portable skill: given a message (subject, body preview, sender, existing labels), returns a label set via the configured model. Decoupled from harness. Realizes UJ-1, UJ-2, UJ-3, UJ-4.

**Functional Requirements:**

#### FR-10: Classification Prompt & Schema

The skill defines a prompt template (system + user) and a strict JSON output schema: `{ "labels": ["label1", "label2", ...] }` where each label must be from the Taxonomy. Empty array valid. Realizes UJ-1, UJ-4.

**Consequences (testable):**
- Prompt template includes: taxonomy list with descriptions, few-shot examples (3–5), instruction to return only valid JSON.
- Output schema validated via Zod (TypeScript) or Pydantic (Python); invalid responses rejected and retried (max 2 retries).
- Model temperature set to 0.1 (configurable) for deterministic output.

#### FR-11: Model Abstraction & Config

The skill accepts a model config object: `{ provider: "jev" | "openai" | "anthropic" | "custom", model: string, apiKeyEnvVar: string, temperature: number, maxTokens: number, extraParams?: object }`. The harness resolves `apiKeyEnvVar` from process env at runtime. Realizes UJ-4.

**Consequences (testable):**
- Default config: `provider: "jev", model: "system1", apiKeyEnvVar: "TYPESAFE_API_KEY", temperature: 0.1, maxTokens: 500`.
- Swapping to `provider: "openai", model: "gpt-4o-mini", apiKeyEnvVar: "OPENAI_API_KEY"` requires only config change.
- Custom provider supported via `extraParams` (e.g., base URL for local Ollama).

#### FR-12: Single-Call Classification

Each message classified in a single model call (no chaining, no tool use). Input: subject, bodyPreview (truncated to 2000 chars), sender email/name, receivedDateTime, existing labels. Output: label set. Realizes UJ-1, UJ-4.

**Consequences (testable):**
- One API call per message (batched at harness level for throughput).
- Latency per message < 3s p95 on Jev System1 (target; not a hard SLA).
- Token usage logged per message (input/output tokens) for cost tracking.

### 4.5 Label Write-Back

**Description:** Applies the classified label set to the message in the source mailbox (M365 categories / Gmail labels). Idempotent: only adds missing labels, never removes user-applied labels. Realizes UJ-1, UJ-2, UJ-3.

**Functional Requirements:**

#### FR-13: M365 Label Write (per account)

Updates message via `PATCH /me/messages/{id}` on the source account with `categories` array = union of existing categories + new label set. Realizes UJ-1, UJ-2.

**Consequences (testable):**
- Existing M365 categories preserved; only new taxonomy labels added.
- If message already has all predicted labels, no API call made (idempotent).
- On 404 (message moved/deleted), log warning with account name and message ID; do not fail batch.
- Writes are scoped to the account that owns the message; cross-account writes are not allowed.

#### FR-14: Gmail Label Write (per account)

Applies labels via `users.messages.modify` on the source account with `addLabelIds` = label IDs for predicted labels not already present. Realizes UJ-3.

**Consequences (testable):**
- Existing Gmail labels preserved; only new taxonomy labels added.
- Label name → label ID mapping cached per account from FR-5 sync.
- If message not found (404), log warning with account name and continue.

### 4.6 Backfill Mode

**Description:** One-shot command to classify historical messages. Processes in batches, resumable via idempotency keys, rate-limit aware. Realizes UJ-1.

**Functional Requirements:**

#### FR-15: Backfill Execution

Command `email-classify --backfill --source <m365|gmail|all> [--account <name|all>] [--since <ISO-date>] [--batch-size <N>]` processes messages per FR-6/FR-8, classifies per FR-12, writes labels per FR-13/FR-14. `--account` defaults to `all`. Realizes UJ-1.

**Consequences (testable):**
- `--account <name>` processes a single account; `--account all` (default) iterates every enabled account of the chosen provider type.
- `--since` filters messages received after date (default: all time), applied per account.
- `--batch-size` controls fetch batch per account (default 50, max 100).
- Progress logged every 100 messages per account: processed, labeled, skipped (already labeled), errors.
- Idempotency: key per FR-3 (message-ID + label hash) scoped per account to avoid cross-account key collisions; skips if key exists in `~/.config/email-classify/idempotency.db`.
- On interrupt (SIGINT), saves progress; re-run with same args resumes from the per-account idempotency store.

#### FR-16: Rate Limit Handling

On HTTP 429 (M365) or 429/rateLimitExceeded (Gmail), extracts `Retry-After` header (seconds) or defaults to exponential backoff (2s, 4s, 8s, 16s, 32s, max 60s). Retries up to 5 times per batch, scoped per account. Realizes UJ-1.

**Consequences (testable):**
- Backoff state is per account — one account in backoff does not pause others.
- Backfill completes 8000 messages per account without manual intervention under typical Graph/Gmail limits.
- Logs each backoff event with account name, wait time, and provider.

### 4.7 Cron Mode

**Description:** Recurring classification of new mail. Runs as foreground process with configurable interval; designed for systemd/cron/launchd supervision. Realizes UJ-2.

**Functional Requirements:**

#### FR-17: Cron Loop

Command `email-classify --cron --interval <minutes> --source <m365|gmail|all> [--account <name|all>]` runs an infinite loop: for each selected account, fetch incremental (FR-7/FR-9) → classify (FR-12) → write labels (FR-13/FR-14) → update state → sleep interval. `--account` defaults to `all`. Realizes UJ-2.

**Consequences (testable):**
- `--interval` default 15, min 1, max 1440 (24h).
- Each cycle logs per account: cycle start, messages fetched, classified, labeled, duration, next run at.
- On classification error for one account: log error with account name, re-queue the failed message for that account's next cycle; other accounts continue.
- On fetch/write error: log error, back off 30s, retry same cycle once for that account, then continue to next interval.

#### FR-18: Graceful Shutdown

On SIGINT/SIGTERM, finishes current message, flushes logs, saves state, exits 0. Realizes UJ-2.

**Consequences (testable):**
- `kill <pid>` or Ctrl+C causes clean exit within 5s.
- State file consistent on restart.

### 4.8 Logging & Observability

**Description:** Structured JSON logging to stdout and rotating file. No external dependencies. Realizes all UJs.

**Functional Requirements:**

#### FR-19: Structured Logging

All log lines are JSON with fields: `timestamp` (ISO 8601), `level` (debug/info/warn/error), `source` (m365|gmail|classify|write|state), `message`, `context` (object: messageId, labelSet, durationMs, errorCode, etc.). Realizes UJ-1, UJ-2.

**Consequences (testable):**
- Stdout: JSON lines, one per event.
- File: rotating daily, max 7 days, max 100MB each, at `~/.local/share/email-classify/logs/`.
- Log level configurable via `--log-level` (default: info).

#### FR-20: Metrics Summary

On cron cycle completion and backfill completion, logs a summary: `messagesProcessed`, `messagesLabeled`, `messagesSkipped`, `messagesErrored`, `avgLatencyMs`, `totalTokensIn`, `totalTokensOut`, `estimatedCostUSD`. Realizes UJ-1, UJ-2.

**Consequences (testable):**
- Summary logged at info level.
- Cost estimate uses Jev pricing (configurable per-model) or OpenAI pricing.

### 4.9 Configuration

**Description:** YAML config file supporting multiple accounts per provider and user-editable taxonomy. Environment variables for secrets. Realizes all UJs.

**Functional Requirements:**

#### FR-21: Config File Schema

Main config at `~/.config/email-classify/config.yaml`; per-account settings live in `~/.config/email-classify/accounts/<m365|gmail>/<accountName>.yaml`. The merged layout supports multiple accounts per provider and user-editable taxonomy.

`config.yaml`:

```yaml
taxonomy: ./taxonomy.yaml          # default 11 labels; can also be inline
taxonomyOverrides:                 # optional; merged on top of taxonomy.yaml
  - name: Invoices
    description: Vendor invoices and receipts
    m365Color: preset6
    gmailColor: "#FF9800"
  - name: Crypto
    # removed from defaults — drop the entry entirely
model:
  provider: jev
  model: system1
  apiKeyEnvVar: TYPESAFE_API_KEY
  temperature: 0.1
  maxTokens: 500
m365:
  accounts: [personal, work]       # names; each maps to accounts/m365/<name>.yaml
gmail:
  accounts: [personal-gmail]       # names; each maps to accounts/gmail/<name>.yaml
cron:
  intervalMinutes: 15
backfill:
  batchSize: 50
  since: null                      # ISO date or null for all
  account: all                     # name or 'all'
logging:
  level: info
  fileRetentionDays: 7
  maxFileSizeMB: 100
idempotency:
  storePath: ~/.config/email-classify/idempotency.db
tokenFallback:
  # Used when the OS keychain is unavailable (locked session, headless container, etc.).
  # Resolved at startup in this order:
  #   1. env var named by passphraseEnvVar
  #   2. one-time TTY prompt (if stdin is a TTY)
  #   3. exit 1 with an actionable error (if stdin is not a TTY and the env var is unset)
  passphraseEnvVar: EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE
```

`accounts/m365/work.yaml`:

```yaml
name: work                          # must match the reference in config.yaml
enabled: true
tenantId: <guid>
clientId: <guid>
folders: [Inbox, "To Review"]
batchSize: 50
```

`accounts/gmail/personal-gmail.yaml`:

```yaml
name: personal-gmail
enabled: true
clientId: <oauth-client-id>
clientSecretEnvVar: GMAIL_PERSONAL_CLIENT_SECRET
labels: [INBOX]
batchSize: 50
```

**Consequences (testable):**
- CLI loads `config.yaml`, then loads each referenced per-account file and merges in-memory.
- CLI exits with a clear error if any referenced account file is missing, unreadable, or fails Zod validation; the error names the offending account and field.
- `accountName` is bound to `/^[a-z0-9][a-z0-9_-]{0,31}$/` in the main config and in the per-account file; non-conforming names are rejected before any keychain or filesystem path is touched.
- Multiple accounts per provider supported; each account has independent auth, state, and sync (FR-1, FR-2).
- Taxonomy is editable: `config.yaml` `taxonomyOverrides` may change any label's `name`/`description`/`m365Color`/`gmailColor` and may add or remove labels. Bounds: 1–50 labels total after merge, label names match `/^[A-Za-z0-9 /&'-]+$/`, no duplicate names.
- All paths support `~` expansion.
- Environment variable overrides for any field via `EMAIL_CLASSIFY_<SECTION>_<KEY>` (e.g., `EMAIL_CLASSIFY_MODEL_TEMPERATURE=0.2`) and per-account `EMAIL_CLASSIFY_<PROVIDER>_ACCOUNTS_<NAME>_<KEY>` (e.g., `EMAIL_CLASSIFY_M365_ACCOUNTS_WORK_ENABLED=false`).

## 5. Non-Goals (Explicit)

- **No autonomous actions** — archive, delete, reply, forward, move to folders. Vision only.
- **No dashboard/UI** — labels live in Outlook/Gmail.
- **No multi-user / multi-tenancy** — single user, single machine; multiple mailboxes owned by that user are in scope, multiple users sharing an install is not.
- **No push/webhook real-time** — cron/poll only (Graph subscriptions, Gmail push = v2).
- **No threading/conversation awareness** — classifies per-message; threading = v2.
- **No encryption at rest beyond OS keychain + age fallback** — OS keychain is primary; when unavailable, the age-encrypted file fallback uses a passphrase resolved at startup (env var, or one-time TTY prompt, or fail-fast with a clear error). No KMS, no secret manager.
- **No eval/benchmark framework** — manual spot-check v1; eval harness = v2.
- **No Cloudflare Worker / MCP deployment** — documented as v2 path.

## 6. MVP Scope

### 6.1 In Scope

- Local CLI (TypeScript/Node) with `--backfill`, `--cron`, `--auth` commands
- M365 Graph auth (device code / cached token) **per account** + Gmail OAuth user consent **per account**
- Multiple accounts per provider (one user, several M365 and/or several Gmail mailboxes)
- 11-label default taxonomy with per-user overrides via `config.yaml` (add/remove/edit labels, colors)
- Multi-label output, JSON schema validation
- Jev System1 default, model config abstraction (swap via config)
- M365 master categories + message categories write-back **per account**
- Gmail labels create + apply **per account**
- Backfill mode: batch 50–100, idempotency (SQLite), exponential backoff, resume, `--account` selector
- Cron mode: 15-min default, incremental fetch (delta/history), graceful shutdown, `--account` selector
- Structured JSON logging (stdout + rotating file), per-cycle metrics summary, per-account context
- YAML config with env overrides, `~` expansion, multi-account via per-account files (`accounts/<provider>/<name>.yaml`), `accountName` regex, taxonomy override validation
- TypeScript types for all DTOs, Zod schemas for validation

### 6.2 Out of Scope for MVP

| Item | Reason |
|------|--------|
| Gmail push / Graph subscriptions | Adds webhook infra, cert management; cron sufficient for v1 |
| Autonomous actions (archive, reply, etc.) | Requires trust in classification accuracy first; vision |
| Dashboard / web UI | Labels visible in native clients; no separate UI needed |
| Multi-user / multi-tenancy | Solo tool; adds auth complexity |
| Conversation/threading awareness | Per-message classification is 80% value; threading = v2 |
| Eval framework / regression tests | Manual spot-check sufficient for solo v1; eval = v2 |
| Cloudflare Worker / MCP deployment | Harness swap is the point of the skill architecture; v2+ |
| Encrypted token store beyond OS keychain | OS keychain standard; file fallback encrypted via age/sops |
| Idempotency store growth (no GC/retention in v1) | Store size is bounded by user message volume; GC/retention deferred to v1.5+ |

## 7. Success Metrics

**Primary**
- **SM-1**: Backfill completion — 8000+ M365 messages classified and labeled within 7 calendar days of first run. Validates FR-15, FR-16.
- **SM-2**: Cron latency — new messages labeled within 15 minutes of arrival (cron interval). Validates FR-17.
- **SM-3**: Multi-label accuracy — ≥90% of 50 spot-checked messages have correct label set (human judgment). Validates FR-10, FR-12.

**Secondary**
- **SM-4**: Model swap verified — skill runs with GPT-4o-mini (or other) by changing only config, no code changes. Validates FR-11.
- **SM-5**: Zero infra cost — v1 runs entirely on local machine, no cloud services. Validates FR-21 (no cloud config required).
- **SM-6**: Idempotency — re-running backfill on same mailbox produces zero duplicate labels, zero errors. Validates FR-15.

**Counter-metrics (do not optimize)**
- **SM-C1**: Classification latency per message — do not optimize below ~1s; Jev reasoning quality matters more than speed. Counterbalances SM-2.
- **SM-C2**: Number of labels per message — do not maximize; precision > recall. An email with 1 correct label beats 3 wrong ones. Counterbalances SM-3.

## 8. Open Questions

1. **Gmail history ID persistence**: Gmail `historyId` can expire (typically ~7 days). If cron stops >7 days, incremental fetch fails. Mitigation: fall back to full Inbox list on history gap. Need to confirm behavior and implement fallback.
2. **M365 delta query vs. filter**: `$filter=receivedDateTime ge ...` may not capture moved messages. Delta query (`/messages/delta`) is more robust but requires state token. Evaluate for v1.1.
3. **Label conflict resolution**: If user manually removes a label the skill applied, should skill re-apply on next cron? Current design: only adds missing, never removes. Confirm this is desired.
4. **Attachment handling**: Current input uses `bodyPreview` only. Some labels (Invoices) may need attachment parsing. Deferred to v2.
5. **Cost tracking accuracy**: Jev pricing not public; estimate based on token count. Need actual pricing when available.
6. ~~**Age encryption key model**~~ — **resolved** (recorded in §4.1 FR-1 / FR-2 inline assumption and in `Config.tokenFallback.passphraseEnvVar` per FR-21): OS keychain first; then env var `EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE` (or `Config.tokenFallback.passphraseEnvVar`); then TTY prompt; then exit 1 when stdin is not a TTY and the env var is unset.

## 9. Assumptions Index

- Inline assumption from §4.1 (FR-1) — M365 token cache persists across CLI invocations via MSAL or custom cache; device code flow only for initial auth.
- Inline assumption from §4.1 (FR-2) — Gmail OAuth client ID/secret stored in config (not secret manager); user creates in Google Cloud Console.
- Inline assumption from §4.2 (FR-3) — Taxonomy definitions (descriptions, colors) are stable; changes require re-sync of master categories/labels.
- Inline assumption from §4.3 (FR-6) — M365 `internetMessageId` is stable and unique per message (RFC 5322); used as idempotency key component, scoped per account.
- Inline assumption from §4.3 (FR-8) — Gmail `internetMessageId` from message payload headers matches RFC 5322; used for idempotency, scoped per account.
- Inline assumption from §4.2 (FR-3) — Taxonomy overrides in `config.yaml` are merged over `taxonomy.yaml` at startup; users are responsible for label changes, and removed labels stay in the mailbox until the user deletes them.
- Inline assumption from §4.9 (FR-21) — Per-account settings live in `accounts/<provider>/<accountName>.yaml`; the main `config.yaml` references them by name; the CLI never inlines per-account credentials into the main config.
- Inline assumption from §4.4 (FR-10) — Jev System1 accepts the prompt format and returns valid JSON without additional parsing; few-shot examples sufficient.
- Inline assumption from §4.4 (FR-12) — 2000-char bodyPreview captures enough signal for 11-label classification; full body not needed.
- Inline assumption from §4.5 (FR-13) — M365 `categories` array update is atomic and preserves order; no race condition with user manually editing in Outlook.
- Inline assumption from §4.6 (FR-15) — SQLite idempotency store at `~/.config/email-classify/idempotency.db` is single-writer (only one CLI instance at a time).
- Inline assumption from §4.7 (FR-17) — Cron mode runs as single process; no distributed locking needed.
- Inline assumption from §4.8 (FR-20) — Jev token pricing estimated at $X/1M tokens (placeholder); actual cost tracked when pricing published.
- Inline assumption from §4.9 (FR-21) — Config file location `~/.config/email-classify/config.yaml` follows XDG Base Directory spec.