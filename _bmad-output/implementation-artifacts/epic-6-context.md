# Epic 6 Context: Classification Engine (Skill Core)

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Deliver the portable heart of the product: a pure, model-agnostic classification function that takes one canonical message plus the active (possibly user-edited) taxonomy and returns a validated multi-label set from a single model call. Every downstream stage — write-back, backfill, cron — only produces value if this engine reliably maps messages to taxonomy labels (success target: ≥90% correct on a 50-message human spot check). Model calls are the only I/O, and they enter through the model port so the core stays pure, swappable by config alone, and cheap to test.

## Stories

- Story 6.1: Classification Prompt Template
- Story 6.2: Output Schema Validation (Zod)
- Story 6.3: Model Abstraction Layer (ModelPort)
- Story 6.4: Single-Call Classification Function

## Requirements & Constraints

- **Prompt contract.** The system prompt carries the active taxonomy (names + descriptions), 3–5 few-shot examples, and an instruction to return only valid JSON. The user prompt carries subject, `bodyPreview` truncated to 2000 chars, sender email/name, receivedDateTime, and existing labels. The prompt is parameterized by the merged taxonomy, so user edits take effect on the next load.
- **Output contract.** Strict JSON `{ "labels": [...] }`; every label must belong to the active taxonomy; an empty array is valid. Precision beats recall — one correct label is better than three wrong ones, and more labels per message is explicitly not a goal.
- **Bounded retries.** Invalid responses are rejected and retried at most twice; after that the message yields an empty label set and an error log carrying the raw response and rejection reason, and processing continues.
- **One call per message.** No chaining, no tool use. A per-message p95 under 3s on Jev System1 is a target, not an SLA; do not trade classification quality for latency or optimize below ~1s.
- **Model config.** `{ provider: "jev" | "openai" | "anthropic" | "custom", model, apiKeyEnvVar, temperature, maxTokens, extraParams? }`; the adapter resolves the API key from the named env var at call time. Defaults: `jev` / `system1` / `TYPESAFE_API_KEY` / 0.1 / 500. Switching provider or model must require config only. `extraParams` covers custom providers (e.g. a local base URL).
- **Pure core.** The classification function has no I/O, no side effects, no external deps; it emits no logs itself. Multi-label output is the default and temperature defaults to 0.1 for determinism.
- **Observability.** Input/output token usage is reported per message so downstream metrics and cost tracking work; failures are logged structurally (message id, account, raw response, reason).

## Technical Decisions

- **AD-1 pure core:** `classify(message, taxonomy, modelConfig)` returns a `LabelSet`; model access arrives as a `ModelPort` dependency, not an adapter import.
- **AD-3 model port:** `complete(prompt, schema, config)` — adapters own provider auth, request/response shaping, and their own retries. Named adapters: Jev (`@typesafe-ai/sdk`, `TYPESAFE_API_KEY`) and OpenAI; a factory selects the adapter from `config.provider`. `anthropic`/`custom` are deliberate config values, with `custom` served via `extraParams`.
- **AD-10 dependency direction:** `core/` imports nothing; model adapters live in `adapters/model/` and depend on core ports only; the CLI/DI layer wires one adapter per run. Core's minimal structural `JsonSchema` may be widened only as far as a provider actually needs.
- **Schema placement tension:** the architecture seed sketches a Zod schema at `core/skill/schema.ts`, while AD-10 forbids core dependencies and the established pattern keeps runtime Zod schemas in `adapters/config` (as taxonomy validation already does). Resolve where output-schema validation executes before writing 6.2; do not break core's zero-dependency rule implicitly.
- **DTOs already in core:** `MessageDTO` (carries `accountId`, `internetMessageId`, existing labels), `Taxonomy` = `LabelDef[]`, `LabelSet = { labels: string[] }`, `ModelConfig`. Classification must not mutate the message or the frozen taxonomy.
- **Label identity:** label *names* are the canonical identifier the engine returns; mapping names to provider category/label IDs belongs to write-back, not here.
- **Suggested placement:** `src/core/skill/{classify,prompt,schema}.ts`, model adapters under `src/adapters/model/`, tests under `tests/core/` and `tests/adapters/`. Follow kebab-case files, `PascalCase` types, `*Port`/`*Adapter`/`*DTO` suffixes.

## UX & Interaction Patterns

- No UX design contract exists; behaviour is CLI/log-derived.
- Failures degrade gracefully: an unclassifiable message costs an empty label set and an error log, never an aborted batch or a silent crash.
- Per-message log context includes `accountId` and message id; token usage is logged for cost visibility.
- The core emits nothing directly — logging flows through the log port from the adapter/orchestration side, and log level is a CLI concern.

## Cross-Story Dependencies

- **Upstream:** Epic 1 supplies `MessageDTO`, `Taxonomy`/`LabelDef`, `ModelConfig`, `LabelSet`, `ModelPort`, and DI wiring. Epic 4 supplies the merged frozen taxonomy, which defines the label universe the classifier may return. Epic 5 supplies `MessageDTO`s; note the orchestrator's fetch layer currently returns counts rather than DTOs, so the seam that hands fetched messages to the classifier is an Epic 6/8 integration point, not an existing contract.
- **Downstream:** Epic 7 writes the returned label set back to the source account; Epic 8 drives `classify` inside backfill and cron; Epic 9 owns rate-limit backoff for provider 429s; Epic 10 consumes latency and token-usage data for metrics and cost estimates.
- **In-epic:** 6.3's adapter is what 6.4 composes; 6.1's prompt and 6.2's validation are composed by 6.4. 6.1 and 6.2 can be built and tested against a stub model port before 6.3 lands.
- **Deferred:** an eval/benchmark framework is out of scope (manual spot-checking in v1); attachment parsing and conversation/threading awareness are v2; Jev pricing used for cost estimates is a placeholder until public.
