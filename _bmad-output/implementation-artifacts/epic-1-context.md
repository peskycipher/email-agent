# Epic 1 Context: Project Foundation & Type System

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Stand up the whole repo skeleton and the contract layer that every later epic builds on: initialize the Node.js/TypeScript project and its hexagonal directory layout, define all ports and canonical DTOs, and lock in the one-way dependency direction core ← adapters ← cli. This epic is a binding foundation with no direct FRs — it delivers the type system, DI seam, and package/tooling baseline so that authentication, fetching, classification, write-back, orchestration, resilience, and observability stories can be implemented against stable interfaces. Success is a developer being able to scaffold the repo, create all ports/DTOs, and run a smoke build of the empty core with enforcement of the dependency rule.

## Stories

- Story 1.1: Project Initialization & Dependencies
- Story 1.2: Port Interfaces Definition (per-account)
- Story 1.3: DTOs & Shared Types (with accountId)

## Requirements & Constraints

- Local-first, zero-infra: v1 runs on the user's machine; no serverless, Docker, or always-on server. Foundation must not introduce cloud dependencies.
- Single canonical message shape across all adapters (prevents translation drift); every account-scoped DTO and port method carries `accountId`.
- Dependency direction is a hard rule: `core/` has zero external/library dependencies; `adapters/` depend only on `core/ports`; `cli/` depends on core + adapters. Enforce via TypeScript project references and the `no-restricted-imports` rule in `.oxlintrc.json`, run by `bun run lint`.
- The classification core must remain a pure function: no I/O, no side effects, no external imports.
- All DTOs get explicit TypeScript types; all runtime validation uses Zod schemas.
- Backfill/cron idempotency and multi-account operation are first-class from the start: the idempotency key format and per-account `accountId` threading are established here, since retconning them later is costly.
- Token storage relies on OS keychain with an age-encrypted file fallback; no separate secrets manager is introduced.
- Package/tooling baseline: Node.js 20 LTS (mise-pinned, resolved 20.20.2), TypeScript 7.0.2, vitest, oxlint (`.oxlintrc.json`, run by `bun run lint`). `eslint` and `@typescript-eslint/*` were removed on 2026-10-08 — no published `@typescript-eslint` accepts TypeScript 7 — so `oxlint` (which parses TypeScript itself and needs no TS API) is the linter. `tests/` mirrors `core/`, `adapters/`, `orch/`, and per-adapter tests must not import real adapter SDKs (stdlib-only mocks, enforced by `.oxlintrc.json`).

## Technical Decisions

- **Paradigm:** Hexagonal (Ports & Adapters). Skill Core is the inside; adapters implement ports for M365, Gmail, Model, Tokens, Idempotency, Scheduling, Logging, Config; the CLI wires adapters to ports.
- **Port interfaces (core/ports):** `MailPort` (`fetchMessages`, `writeLabels`, `ensureCategories`), `ModelPort` (`complete`), `TokenPort` (`get`/`set`/`delete`), `IdempotencyPort` (`has`/`set`), `SchedulerPort` (`runOnce`/`runInterval`), `LogPort` (`debug`/`info`/`warn`/`error`), `ConfigPort` (`load`). Every account-touching method takes `accountId`.
- **Idempotency key contract:** `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))` — the `accountId` prefix prevents cross-account collisions in the single shared SQLite store.
- **DTOs (core/dto):** `MessageDTO` (`id`, `internetMessageId`, `subject`, `bodyPreview`, `senderEmail`, `senderName`, `receivedDateTime`, `existingLabels`, `source: "m365"|"gmail"`, `accountId`, `raw?`), plus `LabelSet`, `Taxonomy`, `LabelDef`, `ModelConfig`, `TokenSet`, `FetchOpts`, `Config`. `FetchOpts` carries `source`, `accountId`, `since?`, `batchSize?`, `folder?`.
- **Config contract (established here, implemented in Epic 11):** `Config` exposes `m365.accounts`, `gmail.accounts`, `taxonomyOverrides`, `tokenFallback.passphraseEnvVar`, and a validated `accountName` regex `/^[a-z0-9][a-z0-9_-]{0,31}$/`. Config is loaded once at startup, Zod-validated, frozen, and passed via DI.
- **DI wiring:** one adapter instantiated per enabled account (`MailPort`, `TokenPort`); shared singletons for `ModelPort`, `IdempotencyPort`, `SchedulerPort`, `LogPort`, `ConfigPort`.
- **Stack pins:** `@typesafe-ai/sdk` 0.6.0, `@microsoft/microsoft-graph-client` 3.0.7, `@microsoft/microsoft-graph-types` 2.43.1, `googleapis` 184.0.0, `better-sqlite3` 9.6.0 (held — 12.x/13.x require `node-gyp`), `zod` 4.6.5, `js-yaml` 5.4.3, `commander` 15.0.0, `pino` 10.4.0, `pino-roll` 4.0.0, `keytar` 7.9.0, `age-encryption` 0.3.1 for fallback.
- **Conventions:** `PascalCase` types/interfaces, `camelCase` functions/variables, `kebab-case` files/dirs, `UPPER_SNAKE` env vars. Ports end in `Port`, adapters in `Adapter`, DTOs in `DTO`. IDs are strings (`internetMessageId` RFC 5322); dates are ISO 8601 UTC. Errors use `{ code, message, context? }`. No global mutable state; state flows through DI. Auth tokens are never logged.
- **Source tree seed** (names only, authoritative for directory creation): `src/core/{ports,dto,skill}`, `src/adapters/{m365,gmail,model,token,idempotency,scheduler,logger,config}`, `src/cli/{commands,di}`, `src/orch/`, `tests/{core,adapters,orch}`, plus `tsconfig{,.core,.adapters,.cli}.json`. (The eslint config this line once promised was superseded by `.oxlintrc.json`, story 1.1's lint config — eslint cannot run on TypeScript 7 and no published `@typescript-eslint` accepts it. `config.yaml.example` is owned by Epic 11 story 11.1 and `taxonomy.yaml` by Epic 4 story 4.1; none are Epic 1 deliverables.)

## Cross-Story Dependencies

- Story 1.2 depends on Story 1.1 (directory structure and tsconfig project references must exist before ports are added, since port placement defines the enforced import boundaries).
- Story 1.3 depends on Story 1.1 and is closely coupled to Story 1.2 (DTOs reference `LabelDef`/`FetchOpts`/`Config` types used by the port signatures).
- All later epics (2–11) depend on this epic's ports, DTOs, dependency direction, and DI container; changing these interfaces after the fact ripples across every adapter and orchestration story.
