# Epic 6 Context: Classification Engine (Skill Core)

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Deliver the portable heart of the product: a pure, model-agnostic classification function that takes one canonical message plus the active (possibly user-edited) taxonomy and returns a validated multi-label set from a single model call. Every downstream stage — write-back, backfill, cron — only produces value if this engine reliably maps messages to taxonomy labels (primary success metric: ≥90% of 50 spot-checked messages have a correct label set by human judgment). Model access is the only I/O and enters through the model port, so the core stays pure, swappable by config alone, and cheap to test.

## Stories

- Story 6.1: Classification Prompt Template
- Story 6.2: Output Schema Validation (Zod)
- Story 6.3: Model Abstraction Layer (ModelPort)
- Story 6.4: Single-Call Classification Function

## Requirements & Constraints

- **Prompt contract.** The system prompt carries the active taxonomy (names + descriptions), 3–5 few-shot examples, and an instruction to return only valid JSON. The user prompt carries subject, `bodyPreview` truncated to 2000 chars, sender email/name, receivedDateTime, and existing labels. The prompt is parameterized by the merged taxonomy, so user edits take effect on the next load.
- **Output contract.** Strict JSON `{ "labels": [...] }`; every label must belong to the active taxonomy; an empty array is valid. Precision beats recall — one correct label beats three wrong ones, and maximizing labels per message is explicitly not a goal.
- **Bounded retries.** Invalid responses are rejected and retried at most twice; after that the message yields an empty label set and an error log carrying the raw response and rejection reason, and processing continues.
- **One call per message.** No chaining, no tool use. Per-message p95 under 3s on Jev System1 is a target, not an SLA; do not optimize below ~1s at the cost of classification quality.
- **Model config.** `{ provider: "jev" | "openai" | "anthropic" | "custom", model, apiKeyEnvVar, temperature, maxTokens, extraParams? }`; the adapter resolves the API key from the named env var at call time. Defaults: `jev` / `system1` / `TYPESAFE_API_KEY` / 0.1 / 500. Switching provider or model must require config only; `extraParams` covers custom providers (e.g. a local base URL).
- **Pure core.** The classification function has no I/O, no side effects, no external deps; it emits no logs itself. Multi-label output is the default; temperature defaults to 0.1 for determinism.
- **Observability.** Input/output token usage is reported per message so downstream metrics and cost tracking work; failures are logged structurally (message id, account, raw response, reason).

## Technical Decisions

- **AD-1 pure core (placement reconciled 2026-10-09, Story 6.4 decision 6, "Option A"):** the engine's logic lives in core (`core/skill/prompt.ts`'s `buildPrompt`, DTOs, ports — pure, zero deps); the composed unit lives in the application layer (`orch/classify.ts`), which composes `buildPrompt` with the adapter-layer `completeWithRetry`. Model access arrives as an injected `ModelPort`; logging as an injected `LogPort`; the spine's AD-1 trio is carried as the repo's options-object idiom (`ClassifyOptions`, Story 6.4 decision 7).
- **AD-3 model port (reconciled 2026-10-09, Story 6.3 decision 1 — "Option C"):** `complete(prompt: PromptParts, taxonomy: Taxonomy, config: ModelConfig): Promise<unknown>` — the classification seam, not a generic completion seam. The earlier `(prompt, schema: JsonSchema, config)` shape is superseded: no adapter consumed `JsonSchema`, and the Jev API cannot honor one (`@typesafe-ai/sdk` takes typed `noul`/`choice` questions only; extra request fields reject 400 — verified live). Adapters own provider auth and wire-format shaping: Jev → one `noul` question per taxonomy label thresholded at `config.labelThreshold ?? 0.5`, `temperature`/`maxTokens` not sent to Jev; OpenAI → `messages` from `PromptParts` + an internal strict JSON schema built from the taxonomy. Named adapters: `JevAdapter` (`@typesafe-ai/sdk`) and `OpenAIAdapter`; `custom` routes to the OpenAI adapter via `extraParams.baseURL`; `anthropic` throws a typed `UNSUPPORTED_PROVIDER` naming the remedy. A factory selects the adapter from `config.provider` at wiring time, validating the env var there (per-call re-check survives). Default model is `jev-latest` — the planning AC's `system1` is a model-class name the API rejects (only `jev-latest`/`jev-preview` exist).
- **AD-10 dependency direction:** `core/` imports nothing; model adapters live in `adapters/model/` and depend on core ports only; the CLI/DI layer wires one adapter per run.
- **Schema placement — resolved by 6.2:** runtime Zod validation lives in `adapters/model/labelSetValidation.ts` (core keeps no `zod`), and 6.3's decision 1 removes `JsonSchema` from core entirely — adapters build their own wire format from the taxonomy. Do not re-derive `JsonSchema` pins in `tests/core/ports.type-test.ts`.
- **DTOs already in core (from Epic 1):** `MessageDTO` (carries `accountId`, `internetMessageId`, existing labels), `Taxonomy` = `LabelDef[]`, `LabelSet = { labels: string[] }`, `ModelConfig`. Classification must not mutate the message or the frozen taxonomy.
- **Label identity:** label *names* are the canonical identifier the engine returns; mapping names to provider category/label IDs belongs to write-back, not here.
- **Suggested placement (from architecture seed):** `src/core/skill/{classify,prompt,schema,taxonomy}.ts`, model adapters under `src/adapters/model/` (`JevAdapter`, `OpenAIAdapter`, `ModelAdapterFactory`), tests under `tests/core/` and `tests/adapters/`. Follow kebab-case files, `PascalCase` types, `*Port`/`*Adapter`/`*DTO` suffixes.

## UX & Interaction Patterns

- No UX design contract exists; behaviour is CLI/log-derived (PRD-derived UX-DRs only).
- Failures degrade gracefully: an unclassifiable message costs an empty label set and an error log, never an aborted batch or a silent crash.
- Per-message log context includes `accountId` and message id; token usage is logged for cost visibility.
- The core emits nothing directly — logging flows through the log port from the adapter/orchestration side, and log level is a CLI concern.

## Cross-Story Dependencies

- **Upstream — Epic 1** supplies `MessageDTO`, `Taxonomy`/`LabelDef`, `ModelConfig`, `LabelSet`, `ModelPort`, and DI wiring. **Epic 4** supplies the merged, frozen taxonomy, which defines the label universe the classifier may return. **Epic 5** supplies `MessageDTO`s from fetch; the seam handing fetched messages to the classifier is an Epic 6/8 integration point.
- **Downstream — Epic 7** writes the returned label set back to the source account; **Epic 8** drives `classify` inside backfill and cron; **Epic 9** owns rate-limit backoff for provider 429s; **Epic 10** consumes latency and token-usage data for metrics and cost estimates.
- **In-epic:** 6.3's adapter is what 6.4 composes; 6.1's prompt and 6.2's validation are composed by 6.4. 6.1 and 6.2 can be built and tested against a stub model port before 6.3 lands.
- **Deferred:** an eval/benchmark framework is out of scope (manual spot-checking in v1); attachment parsing and conversation/threading awareness are v2; Jev pricing used for cost estimates is a placeholder until public.
