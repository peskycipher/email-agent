---
title: 'Story 6.3: Model Abstraction Layer (ModelPort)'
type: 'feature'
created: '2026-10-09'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '5764b91a4a2cf54642f3f73b1c9e05d57e7c740b'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `ModelPort` has no implementation, so no message can be classified: 6.4's `classify` and every later epic block on it. The port's shape is also wrong by its own planning trail — nothing consumes its `JsonSchema` field (6.2's validator ignores it), Jev's SDK cannot honor a JSON schema at all, and the AC's default model name `system1` does not exist on the live API (only `jev-latest` / `jev-preview`, verified 2026-10-09 with a live probe).

**Approach:** 6.1 deferred the port's signature to this story; this story decides it (human decision below) and ships the first two adapters plus the factory that selects them from `config.provider`, so swapping models requires only a config change.

**Decisions (human, 2026-10-09, "party mode" fork resolved):**
1. **Port shape — Option C, minimal.** `ModelPort.complete(prompt: PromptParts, taxonomy: Taxonomy, config: ModelConfig): Promise<unknown>`. The port is the *classification* seam, not a generic completion seam: Jev maps `PromptParts` to one joined `state` string and one `noul` question per taxonomy label (descriptions included as criteria); OpenAI maps it to `messages: [{role:"system"},{role:"user"}]` and builds its own strict JSON schema from the taxonomy internally. `JsonSchema`/`JsonSchemaType` are deleted from core (nothing else consumes them), and 6.2's `CompleteWithRetryOptions.schema` passthrough field is deleted with them.
2. **Default model `jev-latest`** — the AC's `system1` is a System-One *class* name, not a model id; the live API rejects it (400).
3. **Jev multi-label policy** — one `noul` question per taxonomy label per `systemOne` call; a label is *in* the set iff its probability is `>= threshold`, the threshold read from `config.labelThreshold` with default `0.5` (`ModelConfig.labelThreshold?: number` — a user-tunable product knob, party amendment 2; `extraParams` route to the SDK client constructor, so they cannot carry it). After thresholding, the adapter logs the full probability distribution at **debug** (`labelProbs`, per message) so the threshold can be re-judged from spot-check evidence (party amendment 3; SM-3/SM-C2). `temperature`/`maxTokens` are not sent to Jev (the API rejects unknown request fields — verified 2026-10-09, 400 "Invalid request"). Extra request fields are rejected, so `extraParams` go to the SDK **client** constructor (base URL/headers/timeout), not the request body.
4. **Provider routing** — `anthropic` throws a typed `UNSUPPORTED_PROVIDER` whose message names the remedy ("set `provider: "custom"` with `extraParams.baseURL` for OpenAI-compatible providers"); `custom` selects the OpenAI adapter (custom self-hosted providers universally speak the OpenAI protocol), with `extraParams.baseURL` pointing at the compatible endpoint.
5. **Sequencing (party amendment 1)** — the planning reconcile is the FIRST commit of the series: the spine's AD-3 line, `epics.md`'s 6.3 AC and a regenerated `epic-6-context.md` land before any code, so code never ships on ground the architecture doc contradicts. **Wiring-time validation** — `createModelAdapter(config)` validates the provider (routing table above) and that `config.apiKeyEnvVar` names a set env var at construction; the call-time re-check survives for an env that changes between construction and call.

## Boundaries & Constraints

**Always:**
- `src/core/**` untouched except `src/core/ports/ModelPort.ts` (the deciding edit) and the `JsonSchema` removal in `src/core/index.ts` + `tests/core/ports.type-test.ts` (AD-10 holds; relative `.js` imports).
- Adapters implement `ModelPort` exactly; `config.provider` selects the adapter through one factory; no provider branching anywhere else. Adapter deps are injected (`createJevClient` / `createOpenAIClient`-shaped seams) so tests never import a real SDK (oxlint-enforced for `tests/adapters/**`).
- `src/core/**` is touched in exactly two files: `src/core/ports/ModelPort.ts` (the deciding edit) and `src/core/dto/ModelConfig.ts` (one optional `labelThreshold?` field, decision 3), plus the `JsonSchema` removal in `src/core/index.ts` + `tests/core/ports.type-test.ts` (AD-10 holds; relative `.js` imports).
- The factory validates provider routing and API-key resolvability **at wiring time** (`createModelAdapter` throws before the run starts); the call-time re-check survives so an env that changes between construction and call still errors per call — never a silent empty label set.
- The port returns `Promise<unknown>`; the adapter's reply is untrusted and validated by 6.2's `completeWithRetry` — adapters never pre-validate or filter.
- Token usage is logged once per call through an injected `LogPort` at `info` (provider, model, `inputTokens`, `outputTokens`) — the port's `unknown` return is the only usage channel into the core, and per-message correlation waits for the `epic-6-context` "logging flows from the adapter side" rule. Provider rejections/`invalid_grant` propagate unwrapped to the orchestrator (PRD FR-1); only config/env faults get typed adapter codes.
- Both adapters pass `config.temperature` and `config.maxTokens` where the provider supports them (OpenAI); Jev ignores them by decision 3.

**Never:**
- No retry/backoff logic in adapters (Epic 9 owns rate-limit handling; the SDKs' built-in retry defaults stay).
- No change to `TokenPort`, `MailPort`, the DTOs, `prompt.ts`, or `loadTaxonomy`; no `zod` in `core`; no new runtime dep except `openai`.
- No live-network call in tests; no evaluation harness; no Anthropic adapter.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| JEV happy | 2-label taxonomy; stub client answers noul 0.98 / 0.01; `labelThreshold` unset | exactly one `systemOne` request: `state` = joined prompt, both questions present, `model: config.model`; resolves `{labels: [<name at >= threshold>]}`; one info log with usage; one debug log with `labelProbs` | n/a |
| JEV all-below-threshold | both noul probabilities < threshold (`labelThreshold: 0.7`, answers 0.6/0.01) | `{labels: []}` — a valid empty set; no error log (6.2 owns verdict logging); debug log carries the distribution | n/a |
| OPENAI happy | stub client returns a parsed `{labels: [...]}` | request carries `messages` from `PromptParts`, an internally built strict schema whose labels cover the taxonomy, `temperature` + `max_tokens` from config; parsed reply passes through | n/a |
| MISSING KEY | `config.apiKeyEnvVar` names an unset env var | typed `MISSING_API_KEY` naming the env var | wiring time: thrown before the run starts; call-time re-check survives for a changed env |
| UNSUPPORTED PROVIDER | `config.provider === "anthropic"` | typed `UNSUPPORTED_PROVIDER` at the factory, message names the `provider: "custom"` + `extraParams.baseURL` remedy | thrown at wiring time, before any transport call |
| CUSTOM ROUTING | `config.provider === "custom"`, `extraParams.baseURL` set | OpenAI adapter constructed with that base URL | n/a |
| TRANSPORT FAILURE | provider rejects (network/4xx/5xx) | the rejection propagates unwrapped | orchestrator retries and re-queues (PRD FR-1) |

</frozen-after-approval>

## Code Map

- `src/core/ports/ModelPort.ts:1-25` — today's `JsonSchema`/`JsonSchemaType` + `complete(prompt, schema, config)`; delete the schema types, reshape the method per decision 1.
- `src/core/dto/ModelConfig.ts:1-13` — add the optional `labelThreshold?: number` (default applied in the Jev adapter, not in the DTO; decision 3).
- `src/core/index.ts:2` — drop `JsonSchema` from the barrel; `ModelPort` stays; `PromptParts` is already exported (line 17).
- `src/core/skill/prompt.ts:15-18` — `PromptParts {system, user}`; the port takes it as-is. `buildPrompt` (line 103) unchanged.
- `src/core/dto/{Taxonomy,LabelDef}.ts` — the Jev adapter reads `.name`/`.description`; unchanged.
- `src/adapters/model/labelSetValidation.ts:65-107` — `CompleteWithRetryOptions.schema` field deleted; `prompt` becomes `PromptParts` passthrough; the retry budget, taxonomy validation, exhausted-path log and transport re-throw are frozen and survive untouched.
- `tests/adapters/model/label-set-validation.test.ts:22-27,46-60` — drop the `SCHEMA` const and the schema-passed-through assertions; stub calls record `(prompt, taxonomy, config)`.
- `tests/core/ports.type-test.ts` — remove the `JsonSchema` pins; pin the reshaped `ModelPort` (the deferral entries at `deferred-work.md:46,50` become superseded).
- `src/adapters/index.ts` — the adapter barrel to extend.
- `.oxlintrc.json` — already bans `@typesafe-ai/sdk`/`openai` in `tests/adapters/**`; nothing to change.
- `package.json` — add `openai`; install under the mise-pinned Node 20 (bare `node` fails `better-sqlite3`).
- Planning reconcile — **FIRST commit of the series, Loki owns** (decision 5): `ARCHITECTURE-SPINE.md:72-76` (AD-3), `epics.md:499-508` (Story 6.3 AC: model name + shape), `epic-6-context.md` regenerate, `deferred-work.md` supersession notes. Code lands only after this.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/ports/ModelPort.ts` — delete `JsonSchema`/`JsonSchemaType`; reshape `complete(prompt: PromptParts, taxonomy: Taxonomy, config: ModelConfig): Promise<unknown>` with a doc comment naming it the classification seam (decision 1).
- [x] `src/core/index.ts` + `tests/core/ports.type-test.ts` — drop `JsonSchema` from barrel and pins; pin the reshaped port.
- [x] Planning reconcile commit (Loki, FIRST in the series, decision 5) — spine AD-3, epics.md 6.3 AC, `epic-6-context.md` regen, deferred-work supersession notes.
- [x] `src/core/dto/ModelConfig.ts` — add the optional `labelThreshold?: number` field with a doc comment (decision 3); no new port method.
- [x] `src/adapters/model/JevAdapter.ts` (new) — per-call `TypeSafeClient` from `config.apiKeyEnvVar` + `extraParams`; `systemOne({state: joined prompt, questions: one noul per label}, model)`; threshold read from `config.labelThreshold ?? 0.5`; debug log of the full `labelProbs` distribution; `{labels}` out; usage info-logged.
- [x] `src/adapters/model/OpenAIAdapter.ts` (new) — per-call `OpenAI` client; `messages` from `PromptParts`; internal strict JSON schema from the taxonomy; `temperature`/`max_tokens` honored; parsed reply out; usage info-logged.
- [x] `src/adapters/model/modelAdapterFactory.ts` (new) — `createModelAdapter(config, deps): ModelPort`, `DEFAULT_MODEL_CONFIG` (`jev` / `jev-latest` / `TYPESAFE_API_KEY` / 0.1 / 500), `ModelAdapterError` (`MISSING_API_KEY`, `UNSUPPORTED_PROVIDER`); wiring-time validation of provider routing and env var resolvability (decision 5); `anthropic` throws with the remedy line, `custom` → OpenAI adapter.
- [x] `src/adapters/model/labelSetValidation.ts` — drop the `schema` field; `prompt: PromptParts`; everything else byte-stable.
- [x] `src/adapters/index.ts` — export both adapters, the factory, the error and the default config.
- [x] `package.json` + lockfile — add `openai` (installed via mise node@20).
- [x] `tests/adapters/model/` (new ×3 files) + `label-set-validation.test.ts` update — stdlib-only stub clients; one test per I/O-matrix row; threshold boundary; usage log; error paths.

**Acceptance Criteria:**
- Given provider `jev` and a 2-label taxonomy with a stub client answering noul 0.98/0.01 and `labelThreshold` unset (default 0.5), when `complete` runs, then exactly one `systemOne` request carries both questions and the joined prompt as `state`, the port resolves `{labels: [<label at >= 0.5>]}`, and the injected `LogPort` received one info entry with input/output token usage.
- Given provider `openai` and a stub client, when `complete` runs, then the request carries `messages` from `PromptParts`, an internally built strict schema covering the taxonomy, `temperature`/`max_tokens` from config, and the port resolves the parsed `{labels: [...]}`.
- Given `createModelAdapter` is constructed with `config.provider = "anthropic"` (or `"custom"`), when it runs, then `UNSUPPORTED_PROVIDER` (naming the remedy) is thrown — or, for `custom`, the OpenAI adapter is selected with `extraParams` as client options.
- Given `createModelAdapter` is constructed with `config.apiKeyEnvVar` naming an unset env var, when it runs, then `MISSING_API_KEY` is thrown at wiring time; given the same config constructed with the var set and the var later removed, when `complete` runs, then the call-time re-check throws before any transport call.
- Given provider `jev` with `labelThreshold: 0.7` and a stub client answering noul 0.6/0.01, when `complete` runs, then `{labels: []}` resolves and the debug log carries the full probability distribution.
- Given the mise-pinned Node 20, when `bun run test`, `bun run lint`, and `bun run build` run, then all exit 0.

## Implementation Notes

_None yet — appended during implementation._

- Added 2026-10-09 (implementation): `openai` is pinned at **6.49.0**, not the latest 7.x — 7.31.0 declares `engines.node >=22` while the repo pins node 20 (mise); openai ≤6.49.0 declares no engine floor, and the adapter only uses `chat.completions.create` + strict `json_schema` response format, unchanged across 6.x. Installed via `mise exec node@20 -- bun add openai@6.49.0`; exact pin added to `package.json` (repo style) and `bun.lock` updated.
- The client seams are structural types owned by each adapter (`JevClient`/`JevClientOptions` in `JevAdapter.ts`, `OpenAIChatClient`/`OpenAIClientOptions` in `OpenAIAdapter.ts`), so tests stub them without importing either SDK. The only SDK imports live in `modelAdapterFactory.ts`'s `defaultModelClientFactories` (per-call `TypeSafeClient` / `OpenAI` wrapped into the structural seams); production wiring (6.4 / Epic 11.3) spreads them into `createModelAdapter(config, { log, ...defaultModelClientFactories })`.
- Both adapters use the *per-call* `config` argument (the port's third parameter) rather than snapshotting config at construction, so the factory's wiring-time validation and the per-call re-check (decision 5) share one config path and no stale-config bug can appear.
- Jev joins the prompt halves with `"\n\n"` (system then user) into the single `state`; `labelProbs` in the debug log carries every taxonomy label, with `null` for an answer the provider omitted or returned non-numerically — such labels never join the set.
- The OpenAI adapter JSON-parses `choices[0].message.content`; `null` content passes through as `null` so 6.2's retry budget consumes it as an invalid reply, while undecodable string content propagates the `SyntaxError` unwrapped (a provider fault, not an orchestrator retry).
- `ModelAdapterError` + `resolveEnvApiKey` live in `modelAdapterFactory.ts` and the adapters import them from there while the factory imports the adapters — a benign ESM cycle: every use is function-scoped, evaluated only after both modules finish loading (verified by build + suites).
- The factory's `default` arm catches provider values outside the ratified union (e.g. an unvalidated YAML-parsed string) and throws `UNSUPPORTED_PROVIDER` rather than silently routing to the OpenAI adapter; `"anthropic"` still gets the dedicated remedy message.

## Spec Change Log

_Empty until the first bad_spec loopback._

## Review Triage Log

_Empty until the first review pass._

## Design Notes

**Why the port carries `Taxonomy` and not a schema:** the only schema consumer (OpenAI structured outputs) can build its schema from the taxonomy deterministically inside the adapter; Jev cannot honor any schema (its API is typed questions, extra request fields 400 — verified 2026-10-09). A schema parameter would be a Jev-only lie pinned by a runtime throw. With `Taxonomy` the Jev adapter also gets label *descriptions* as noul criteria for free — a quality win for the epic's spot-check metric (SM-3).

**Why `PromptParts` instead of `string`:** 6.1 deliberately kept the halves separate "because the system side carries the taxonomy and the output contract while the user side carries the message" — OpenAI's `messages` array is exactly that split; Jev joins it for its single `state`. The 6.1 join question resolves per-provider rather than being flattened in core.

**Threshold:** default `0.5`, carried as `ModelConfig.labelThreshold?` (party amendment 2) so it is user-tunable without a code change; the adapter applies `config.labelThreshold ?? 0.5` and logs every message's probability distribution at debug (party amendment 3) so SM-C2 (precision over recall) can be re-judged against spot-checked data.

**Usage logging lives in the adapter** because the port's frozen `unknown` return is the only channel into the core and 6.4's `classify` must stay pure (epic-6-context: "the core emits nothing directly"). Per-message correlation is Epic 10's concern.

## Verification

**Commands:**
- `mise exec node@20 -- bun run test` — expected: vitest green incl. the three new adapter suites, then `tsc --noEmit` green.
- `mise exec node@20 -- bun run lint` — expected: oxlint + `check-core-external-imports.mjs` exit 0 (AD-10 intact after the core edit).
- `mise exec node@20 -- bun run build` — expected: `tsc -b` exit 0.
