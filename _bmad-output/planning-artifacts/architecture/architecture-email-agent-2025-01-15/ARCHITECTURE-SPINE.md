---
name: 'email-classification-skill'
type: architecture-spine
purpose: build-substrate
altitude: feature
paradigm: hexagonal
scope: Local CLI skill for multi-label email classification (M365 + Gmail) with model-agnostic core
status: draft
created: '2025-01-15'
updated: '2025-01-15'
binds:
  - FR-1..FR-21 (PRD)
sources:
  - '_bmad-output/planning-artifacts/prds/prd-email-agent-2025-01-15/prd.md'
  - '_bmad-output/planning-artifacts/briefs/brief-email-agent-2025-01-15/brief.md'
companions: []
---

# Architecture Spine — email-classification-skill

## Design Paradigm

**Hexagonal (Ports & Adapters)**. The **Skill Core** (classification engine) is the inside — pure, no I/O, model-agnostic. **Adapters** implement ports for M365, Gmail, Model (Jev/OpenAI), Tokens, Idempotency, Scheduling, Logging, Config. The **CLI** wires adapters to ports at startup.

```
                    ┌─────────────────────┐
                    │    CLI / Main       │
                    │  (wires adapters)   │
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│  M365 Adapter │      │ Gmail Adapter │      │ Model Adapter │
│ (MailPort)    │      │ (MailPort)    │      │ (ModelPort)   │
└───────┬───────┘      └───────┬───────┘      └───────┬───────┘
        │                      │                      │
        ▼                      ▼                      ▼
┌─────────────────────────────────────────────────────────────┐
│                      SKILL CORE                             │
│  classify(message: MessageDTO, taxonomy, config): LabelSet  │
│  (pure function, zero I/O, zero deps)                       │
└─────────────────────────────────────────────────────────────┘
        ▲                      ▲                      ▲
        │                      │                      │
┌───────┴───────┐      ┌───────┴───────┐      ┌───────┴───────┐
│ Token Adapter │      │ Idempotency   │      │  Scheduler    │
│ (TokenPort)   │      │ Adapter       │      │ (SchedulerPort)│
└───────┬───────┘      │ (IdemPort)    │      └───────┬───────┘
        │              └───────┬───────┘              │
        ▼                      ▼                      ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│  Logger       │      │   Config      │      │  (DI Context) │
│ (LogPort)     │      │ (ConfigPort)  │      │               │
└───────────────┘      └───────────────┘      └───────────────┘
```

## Invariants & Rules

### AD-1 — Skill Core is a pure function

- **Binds:** `ClassificationEngine`, all harnesses
- **Prevents:** Harness-specific logic leaking into classification (model calls, API clients, file I/O)
- **Rule:** `classify(message: MessageDTO, taxonomy: Taxonomy, modelConfig: ModelConfig): Promise<LabelSet>` — single async function, no side effects. All I/O happens in adapters outside the core.

### AD-2 — MessageDTO is the single shared data shape

- **Binds:** `M365Adapter`, `GmailAdapter`, `ClassificationEngine`, `LabelWriter`, `IdempotencyStore`
- **Prevents:** Each adapter defining its own message shape → translation drift, fragile mappers
- **Rule:** One `MessageDTO` interface: `{ id, internetMessageId, subject, bodyPreview, sender, receivedDateTime, existingLabels, source: "m365"|"gmail", accountId: string, raw?: unknown }`. `accountId` is the user-chosen account name from config (e.g., `personal`, `work`). Adapters map to/from this shape at their boundaries.

### AD-3 — ModelClient is an adapter (port: `ModelPort`)

- **Binds:** `ClassificationEngine`, `JevModelAdapter`, `OpenAIModelAdapter`, future adapters
- **Prevents:** Model-specific code in ClassificationEngine; hardcoded Jev calls
- **Rule:** `ModelPort = { complete(prompt: string, schema: JsonSchema, config: ModelConfig): Promise<unknown> }`. ClassificationEngine calls `modelPort.complete()` with rendered prompt + output schema. Adapters implement provider-specific auth, request/response shaping, retry.

### AD-4 — TokenStore is an adapter (port: `TokenPort`)

- **Binds:** `M365AuthAdapter`, `GmailAuthAdapter`, CLI auth commands
- **Prevents:** Auth logic scattered; token format coupled to OS keychain
- **Rule:** `TokenPort = { get(provider: "m365"|"gmail", accountId: string): Promise<TokenSet>, set(provider, accountId, tokens): Promise<void>, delete(provider, accountId): Promise<void> }`. Implementation: OS keychain (keytar) with encrypted file fallback. Each account gets its own keychain service entry (`email-classify-<provider>-<accountId>`) and its own fallback file at `~/.config/email-classify/accounts/<provider>/<accountId>/tokens.json.age`. **Age passphrase resolution chain** (resolved from the original deferred item): adapter reads OS keychain first; if unavailable, reads passphrase from `Config.tokenFallback.passphraseEnvVar` (default `EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE`); if env var unset and stdin is a TTY, prompts once at startup; if env var unset and stdin is not a TTY, CLI exits 1 with an actionable error.

### AD-5 — IdempotencyStore is an adapter (port: `IdempotencyPort`)

- **Binds:** Backfill orchestration, Cron orchestration
- **Prevents:** Duplicate labels on re-run; backfill non-resumable
- **Rule:** `IdempotencyPort = { has(key: string): Promise<boolean>, set(key: string): Promise<void> }`. Key = `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))` — `accountId` prefix prevents cross-account collisions in the same SQLite file. Implementation: `better-sqlite3` at `~/.config/email-classify/idempotency.db` (single-writer).

### AD-6 — Scheduler is an adapter (port: `SchedulerPort`)

- **Binds:** Cron mode, Backfill mode (as "run once" scheduler)
- **Prevents:** Cron logic baked into orchestration; hard to test, hard to swap to systemd/launchd/Cloudflare Worker
- **Rule:** `SchedulerPort = { runOnce(fn: () => Promise<void>): Promise<void>, runInterval(fn: () => Promise<void>, intervalMs: number): Promise<AbortController> }`. CLI implements via `setInterval` + signal handling.

### AD-7 — Logger is an adapter (port: `LogPort`)

- **Binds:** All components
- **Prevents:** `console.log` scattered; no structured output; can't swap to external sink
- **Rule:** `LogPort = { debug(info, context?), info(...), warn(...), error(...) }` with structured context object. Implementation: `pino` (JSON to stdout + rotating file via `pino-roll`).

### AD-8 — MailClient is an adapter (port: `MailPort`)

- **Binds:** `M365Adapter`, `GmailAdapter`, orchestration (fetch, write labels)
- **Prevents:** M365/Gmail specifics leaking into orchestration; duplicate fetch/write logic
- **Rule:** `MailPort = { fetchMessages(opts: FetchOpts): Promise<MessageDTO[]>, writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void>, ensureCategories(accountId: string, labels: LabelDef[]): Promise<void> }`. `FetchOpts = { source, accountId, since?, batchSize?, folder? }`. Each adapter handles its own pagination, rate limits, delta/history, and is instantiated once per enabled account by the DI container.

### AD-9 — Config is loaded once at startup, validated, frozen

- **Binds:** All components (via DI container or context)
- **Prevents:** Config drift mid-run; env vars read in random places
- **Rule:** Single `Config` object (Zod-validated) created in `main.ts`, passed to all adapters. Schema per PRD FR-21: main `config.yaml` with global settings plus `m365.accounts: [name, ...]` and `gmail.accounts: [name, ...]` references; each account's settings live in `~/.config/email-classify/accounts/<provider>/<accountName>.yaml`. `taxonomyOverrides[]` merged on top of `taxonomy.yaml`. `tokenFallback.passphraseEnvVar` (non-empty string, default `EMAIL_CLASSIFY_TOKEN_FALLBACK_PASSPHRASE`) records the age-fallback passphrase resolution chain. `accountName` regex `/^[a-z0-9][a-z0-9_-]{0,31}$/` enforced before any filesystem or keychain lookup. Env overrides applied at load time only and validated against the same Zod schema.

### AD-10 — Dependency direction: Core depends on nothing; Adapters depend on Core ports

- **Binds:** Entire codebase
- **Prevents:** Circular deps; core pulling in heavy adapters (graph-client, googleapis, better-sqlite3, pino)
- **Rule:** Dependency graph:
  ```
  core/ (skill, ports, DTOs)           ← zero deps
  adapters/ (m365, gmail, model, token, idempotency, scheduler, logger, config) → depend on core/ports only
  cli/ (commands, DI wiring)           → depends on core + adapters
  ```
  Enforced via `tsconfig` project references or eslint `no-restricted-imports`.

## Consistency Conventions

| Concern | Convention |
| --- | --- |
| Naming (entities, files, interfaces, events) | `PascalCase` types/interfaces, `camelCase` functions/variables, `kebab-case` files/dirs, `UPPER_SNAKE` env vars. Port interfaces end in `Port` (e.g., `MailPort`). Adapters end in `Adapter` (e.g., `M365Adapter`). DTOs end in `DTO`. |
| Data & formats (ids, dates, error shapes, envelopes) | IDs: `string` (internetMessageId RFC 5322). Dates: ISO 8601 UTC (`DateTimeOffset`). Errors: `{ code: string, message: string, context?: object }` — all adapters throw/return this shape. Envelopes: `{ data: T, meta?: { timestamp, source, ... } }`. |
| State & cross-cutting (mutation, errors, logging, config, auth) | No global mutable state. All state passed via DI context. Errors caught at adapter boundary, logged via `LogPort`, re-thrown as typed error. Auth tokens never logged (redacted in context). Config frozen after validation. |

## Stack

| Name | Version |
| --- | --- |
| Node.js | 20 LTS |
| TypeScript | 5.5.x |
| @typesafe-ai/sdk (Jev System1) | 0.6.0 |
| @microsoft/microsoft-graph-client | 3.0.7 |
| @microsoft/microsoft-graph-types | 2.43.x |
| googleapis | 184.0.0 |
| better-sqlite3 | 9.6.x |
| zod | 3.23.x |
| js-yaml | 4.1.x |
| commander | 12.1.x |
| pino | 9.2.x |
| pino-roll | 1.11.x |
| keytar | 7.9.x |
| age-encryption | (for file fallback) |

## Structural Seed

```text
email-classify/
├── package.json
├── tsconfig.json
├── tsconfig.core.json
├── tsconfig.adapters.json
├── tsconfig.cli.json
├── .eslintrc.json
├── .prettierrc
├── config.yaml.example
├── taxonomy.yaml
├── src/
│   ├── core/                      # ZERO external deps
│   │   ├── ports/
│   │   │   ├── MailPort.ts
│   │   │   ├── ModelPort.ts
│   │   │   ├── TokenPort.ts
│   │   │   ├── IdempotencyPort.ts
│   │   │   ├── SchedulerPort.ts
│   │   │   ├── LogPort.ts
│   │   │   └── ConfigPort.ts
│   │   ├── dto/
│   │   │   ├── MessageDTO.ts
│   │   │   ├── LabelSet.ts
│   │   │   ├── Taxonomy.ts
│   │   │   ├── LabelDef.ts
│   │   │   ├── ModelConfig.ts
│   │   │   ├── TokenSet.ts
│   │   │   └── FetchOpts.ts
│   │   ├── skill/
│   │   │   ├── classify.ts           # pure function: classify(message, taxonomy, modelConfig, modelPort) -> LabelSet
│   │   │   ├── prompt.ts             # prompt template + few-shots
│   │   │   ├── schema.ts             # Zod schema for LabelSet output
│   │   │   └── taxonomy.ts           # loads taxonomy.yaml
│   │   └── index.ts                  # barrels core exports
│   │
│   ├── adapters/                    # depend on core/ports only
│   │   ├── m365/
│   │   │   ├── M365Adapter.ts        # implements MailPort
│   │   │   ├── M365AuthAdapter.ts    # implements TokenPort (m365)
│   │   │   ├── graph-client.ts       # Graph client wrapper
│   │   │   └── mappers.ts            # Graph message → MessageDTO
│   │   ├── gmail/
│   │   │   ├── GmailAdapter.ts       # implements MailPort
│   │   │   ├── GmailAuthAdapter.ts   # implements TokenPort (gmail)
│   │   │   ├── gmail-client.ts       # googleapis wrapper
│   │   │   └── mappers.ts            # Gmail message → MessageDTO
│   │   ├── model/
│   │   │   ├── JevAdapter.ts         # implements ModelPort
│   │   │   ├── OpenAIAdapter.ts      # implements ModelPort
│   │   │   └── ModelAdapterFactory.ts
│   │   ├── token/
│   │   │   └── KeychainTokenStore.ts # implements TokenPort (keytar + age fallback)
│   │   ├── idempotency/
│   │   │   └── SqliteIdempotencyStore.ts # implements IdempotencyPort
│   │   ├── scheduler/
│   │   │   └── SimpleScheduler.ts    # implements SchedulerPort
│   │   ├── logger/
│   │   │   └── PinoLogger.ts         # implements LogPort
│   │   ├── config/
│   │   │   └── ConfigLoader.ts       # implements ConfigPort
│   │   └── index.ts                  # barrels adapters
│   │
│   ├── cli/                         # depends on core + adapters
│   │   ├── commands/
│   │   │   ├── auth.ts               # --auth m365|gmail
│   │   │   ├── backfill.ts           # --backfill
│   │   │   ├── cron.ts               # --cron
│   │   │   └── sync-categories.ts    # --sync-categories
│   │   ├── di/
│   │   │   └── container.ts          # wires ports → adapters, creates Config
│   │   ├── main.ts                   # entry point, commander setup
│   │   └── index.ts
│   │
│   └── orch/                        # orchestration (depends on core ports)
│       ├── backfill.ts               # backfill flow
│       ├── cron.ts                   # cron flow
│       └── sync.ts                   # category/label sync
│
├── tests/
│   ├── core/
│   │   └── classify.test.ts
│   ├── adapters/
│   └── orch/
│
└── dist/                            # compiled output
```

## Capability → Architecture Map

| Capability / Area | Lives in | Governed by |
| --- | --- | --- |
| Classification (FR-10, FR-11, FR-12) | `core/skill/classify.ts` | AD-1, AD-2, AD-3 |
| M365 Auth (FR-1, multi-account) | `adapters/m365/M365AuthAdapter.ts` (one per account) | AD-4, AD-8 |
| Gmail Auth (FR-2, multi-account) | `adapters/gmail/GmailAuthAdapter.ts` (one per account) | AD-4, AD-8 |
| Taxonomy load + user overrides | `adapters/config/taxonomy.ts` | AD-9 |
| M365 Category Sync (FR-4, multi-account) | `adapters/m365/M365Adapter.ts` (one per account) | AD-8 |
| Gmail Label Sync (FR-5, multi-account) | `adapters/gmail/GmailAdapter.ts` (one per account) | AD-8 |
| M365 Fetch (FR-6, FR-7, multi-account) | `adapters/m365/M365Adapter.ts` | AD-2, AD-8 |
| Gmail Fetch (FR-8, FR-9, multi-account) | `adapters/gmail/GmailAdapter.ts` | AD-2, AD-8 |
| Label Write (FR-13, FR-14, multi-account) | `adapters/m365/M365Adapter.ts`, `adapters/gmail/GmailAdapter.ts` | AD-2, AD-8 |
| Backfill Mode (FR-15, FR-16) | `orch/backfill.ts` | AD-5, AD-6, AD-8 |
| Cron Mode (FR-17, FR-18) | `orch/cron.ts` | AD-6, AD-8 |
| Logging (FR-19, FR-20) | `adapters/logger/PinoLogger.ts` (accountId in context) | AD-7 |
| Config (FR-21, multi-account via per-account files + taxonomy overrides) | `adapters/config/ConfigLoader.ts` (merges main + per-account files) | AD-9 |
| DI wiring per account | `cli/di/container.ts` | AD-10 |

## Deferred

| Decision | Reason |
| --- | --- |
| Delta query vs. filter for M365 incremental fetch | PRD Open Question #2 — evaluate after v1 ships; delta query more robust but requires state token management |
| Gmail historyId expiry fallback | PRD Open Question #1 — implement full Inbox list fallback when history gap detected |
| Label re-apply policy (user removes skill-applied label) | PRD Open Question #3 — current design: never remove, only add; revisit if user friction |
| Attachment parsing for Invoices label | PRD Open Question #4 — bodyPreview only v1; attachment download + OCR = v2 |
| Jev pricing / cost tracking accuracy | PRD Open Question #5 — placeholder pricing; update when public |
| Cloudflare Worker / MCP harness | PRD Non-Goal — separate harness implementation, same core skill |
| Multi-account per provider | In scope v1 — DI instantiates a per-account adapter per enabled account; idempotency and logging carry `accountId` |
| User-editable taxonomy | In scope v1 — `Config.taxonomy` merged from `taxonomy.yaml` + `taxonomyOverrides`; Zod-validated and frozen at startup |
| Conversation/threading awareness | PRD Non-Goal — per-message classification is 80% value |
| Encrypted token store beyond OS keychain + age | **Resolved** — OS keychain primary; age fallback uses `Config.tokenFallback.passphraseEnvVar` env var → TTY prompt → fail-fast with clear error. No KMS, no secret manager. |
| Eval/benchmark framework | PRD Non-Goal — manual spot-check v1; eval harness = v2 |
| Push/webhook real-time (Graph subscriptions, Gmail push) | PRD Non-Goal — cron sufficient v1; infra cost not justified |