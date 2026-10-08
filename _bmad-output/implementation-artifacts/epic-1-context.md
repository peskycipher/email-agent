# Epic 1 Context: Project Foundation & Type System

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Establish the repository's structural skeleton and type vocabulary before any feature work begins. This epic delivers a scaffolded Node.js/TypeScript project with the full hexagonal directory layout, the dependency-direction enforcement that keeps the core pure, and the complete set of port interfaces and DTOs that every later epic implements against. It matters because all subsequent epics (auth, fetch, classify, write-back, orchestration) depend on these shared contracts being defined once, correctly, and enforced by the toolchain — the core must remain free of I/O and external dependencies, and every account-touching type must carry `accountId` so multi-account context can never be dropped. This is a binding epic: it covers no functional requirement directly, only the architectural invariants (AD-1..AD-10) and the cross-cutting NFRs the rest of the system rests on.

## Stories

- Story 1.1: Project Initialization & Dependencies
- Story 1.2: Port Interfaces Definition (per-account)
- Story 1.3: DTOs & Shared Types (with accountId)

## Requirements & Constraints

- **Local-first, zero-infra (NFR1):** Runs on the user's machine only; no serverless, Docker, or always-on server. Do not introduce infra dependencies in the scaffold.
- **Single shared MessageDTO (NFR3):** All adapters map to/from one canonical message shape carrying `accountId`, preventing translation drift.
- **Enforced dependency direction (NFR4):** `core/` (zero deps) ← `adapters/` (depend on core ports only) ← `cli/` (wires all). Must be enforced mechanically, not by convention.
- **Multi-account by construction:** Every port method that touches an account takes an `accountId` parameter; adapters are instantiated per enabled account.
- **Core purity:** The classification core must be a pure async function — no side effects, no I/O, no external dependencies. All I/O lives in adapters.

## Technical Decisions

- **Paradigm:** Hexagonal (Ports & Adapters). Skill Core is the inside (pure, model-agnostic); adapters implement ports for M365, Gmail, Model, Tokens, Idempotency, Scheduling, Logging, Config; CLI wires adapters to ports at startup.
- **Stack:** Node.js 20 LTS, TypeScript 7.x. Runtime deps: `@typesafe-ai/sdk`, `@microsoft/microsoft-graph-client`, `@microsoft/microsoft-graph-types`, `googleapis`, `better-sqlite3`, `zod`, `js-yaml`, `commander`, `pino`, `pino-roll`, `keytar`, `age-encryption`. Dev: `typescript`, `@types/node`, `@types/better-sqlite3`, `@types/js-yaml`, `@types/keytar`, `vitest`, `oxlint`.
- **Enforcement mechanics:** `tsconfig` project references (separate core/adapters/cli configs) plus the oxlint `no-restricted-imports` rule in `.oxlintrc.json` (run by `bun run lint`). The lint rule additionally bars files under `tests/adapters/**` from importing real adapter SDKs (`@microsoft/microsoft-graph-client`, `googleapis`, `@typesafe-ai/sdk`, `openai`), so per-adapter tests use stdlib-only mocks.
- **Directory layout:** `src/core/{ports,dto,skill}`, `src/adapters/{m365,gmail,model,token,idempotency,scheduler,logger,config}`, `src/cli/{commands,di}`, `src/orch/`, and mirrored `tests/{core,adapters,orch}`.
- **Port interfaces (in `core/ports/`):** `MailPort` (fetchMessages/writeLabels/ensureCategories), `ModelPort` (complete), `TokenPort` (get/set/delete, keyed by provider + accountId), `IdempotencyPort` (has/set), `SchedulerPort` (runOnce/runInterval), `LogPort` (debug/info/warn/error with structured context), `ConfigPort` (load). Account-touching methods thread `accountId`.
- **DTOs (in `core/dto/`):** `MessageDTO` (canonical message shape + `accountId`), `LabelSet`, `Taxonomy` (array of `LabelDef`), `LabelDef` (name, description, m365Color, gmailColor), `ModelConfig` (provider/model/apiKeyEnvVar/temperature/maxTokens/extraParams), `TokenSet`, `FetchOpts` (source/accountId/since/batchSize/folder).
- **Idempotency key format:** `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))` — the `accountId` prefix partitions a single shared store, preventing cross-account collisions.
- **Config shape:** `Config` carries `m365.accounts[]`, `gmail.accounts[]`, `taxonomyOverrides[]`, and `tokenFallback.passphraseEnvVar`, with the `accountName` regex `/^[a-z0-9][a-z0-9_-]{0,31}$/` enforced before any keychain or filesystem lookup.
- **Conventions:** `PascalCase` types, `camelCase` functions, kebab-case files/dirs, `UPPER_SNAKE` env vars. Ports end in `Port`, adapters in `Adapter`, DTOs in `DTO`. Every port that later gets implemented needs its interface frozen here.
- **AD-1..AD-10 bind this epic:** pure core function (AD-1), shared MessageDTO (AD-2), and adapter-backed ports for Model/Tokens/Idempotency/Scheduler/Logger/Mail (AD-3..AD-8), config loaded-once-validated-frozen (AD-9), dependency direction (AD-10).

## Cross-Story Dependencies

- Story 1.2 (ports) and Story 1.3 (DTOs) both depend on the scaffold and toolchain from Story 1.1; ports reference DTO types, so define DTOs and ports together.
- All later epics (2–11) are blocked on this epic: each implements one of these ports or consumes these DTOs, and each relies on the dependency-direction enforcement established here.
