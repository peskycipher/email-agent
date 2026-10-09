---
title: 'Story 6.2 — Output schema validation (Zod)'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: '5419c001ac1d7657a701a270e08a3a0d3e18cefc'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-6-1-classification-prompt-template.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 6.1 builds the model request, but nothing validates the model's reply: a malformed response or a label outside the active taxonomy can flow straight downstream (write-back, backfill, cron). Story 6.2 adds strict Zod validation of the `{ "labels": [...] }` output, bounded retries for invalid responses, and a safe empty-label fallback that logs the raw response and the rejection reason.

**Approach:** Validate the raw model response against a strict Zod schema whose label membership is drawn from the active (merged, frozen) taxonomy, retry an invalid response against the same configured model at most twice, and after the retries are exhausted return `{ labels: [] }` and emit one structured error. The retry re-issues the call through `ModelPort` carrying the run's `ModelConfig` unchanged.

## Decisions

- **Schema home (2026-10-09, human):** the Zod schema, the validation function, and the bounded-retry unit live in the **adapter layer** (`src/adapters/model/`), not core. Core stays runtime-dependency-free; AD-3's "adapters own retry" holds; `ModelPort` is untouched for 6.3/6.4.
- **Retry budget (2026-10-09, human):** **3 attempts total** — the initial call plus at most 2 retries.
- **Temperature (2026-10-09, human):** 6.2 passes `config.temperature` through unchanged and asserts it; the `0.1` default is owned by 6.3's default model config, not redefined here.

## Boundaries & Constraints

**Always:**
- The accepted shape is exactly `{ labels: string[] }`: every entry must be a string present in the active taxonomy; an empty array is valid; unknown top-level keys are rejected (strict — matches `adapters/config/taxonomy.ts`'s `.strict()` precedent).
- The retry reuses the same `ModelConfig` unchanged (no per-retry model/temperature mutation) and makes at most 3 calls (initial + 2 retries).
- After the attempts are exhausted the unit yields `{ labels: [] }` and logs exactly one structured error carrying the raw response and the rejection reason; it never throws out of the per-message path.
- The request is 6.1's `buildPrompt` output — no prompt changes, no re-derived format.
- The unit is provider-agnostic and testable against a stub `ModelPort` with no real SDK.

**Never:**
- Do not change `ModelPort.complete`'s signature or return type (6.3/6.4's decision; 6.1 deferred it).
- Do not import a real provider SDK; do not add a dependency.
- Do not break AD-10's dependency direction; do not import `adapters/` from `core/`.
- Do not build the Jev/OpenAI adapters or factory (6.3) or the full `classify` orchestration (6.4).
- Do not change `prompt.ts`, the DTOs, `ModelPort.ts`, or `loadTaxonomy`. No eval/benchmark harness.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY | raw `{ labels: ["Invoices"] }`, taxonomy contains `Invoices` | accepted → `["Invoices"]` | n/a |
| EMPTY VALID | raw `{ labels: [] }` | accepted → `[]`; no retry, no error log | n/a |
| MALFORMED | raw is a string / `null` / `{}` / `{ labels: "Invoices" }` / a non-string entry / an extra key | rejected with a reason; retried | exhausted → `{ labels: [] }` + one error log (raw, reason) |
| LABEL NOT IN TAXONOMY | raw `{ labels: ["Nope"] }` | rejected (membership) | as MALFORMED |
| LATE RECOVERY | attempt 1 invalid, attempt 2 valid | accepted on attempt 2; no error log | n/a |
| DETERMINISM | same raw + taxonomy, twice | identical verdict; no argument mutated | n/a |

</frozen-after-approval>

## Code Map

- `src/core/skill/prompt.ts:103` — `buildPrompt(message, taxonomy): PromptParts`; 6.1's pure builder; the request this story validates the reply to. Reuse, do not change.
- `src/core/ports/ModelPort.ts:1-13` — `JsonSchema` and `complete(prompt, schema, config): Promise<unknown>`; the seam the retry re-issues through. Signature unchanged.
- `src/core/dto/ModelConfig.ts` — `{ provider, model, apiKeyEnvVar, temperature, maxTokens, extraParams? }`; already carries `temperature`, so no new default is added here.
- `src/core/dto/LabelSet.ts` / `src/core/dto/Taxonomy.ts:4` / `src/core/dto/LabelDef.ts` — `LabelSet`, `Taxonomy = LabelDef[]`, and `LabelDef.name`, the value membership is checked against.
- `src/core/ports/LogPort.ts` — `LogPort.error(message, context)`; the exhausted path logs through it with `accountId` and message id in `context`.
- `src/adapters/config/taxonomy.ts:1-90` — the repo's Zod idiom (`.strict()`, `z.infer`, typed error codes); `loadTaxonomy` returns the frozen taxonomy injected at wiring time. Do not change.
- `src/adapters/index.ts` — adapter barrel; the new module is exported here.
- `tests/core/prompt.test.ts` — test idiom (`vitest`, explicit `.js` extensions, fixture helpers); the new adapter test follows it. No tsconfig type-checks `tests/`.
- `tsconfig.adapters.json` / `.oxlintrc.json` — compile the new module; `.oxlintrc.json` bans core→adapters/cli/orch imports (AD-10).
- `_bmad-output/implementation-artifacts/spec-6-1-classification-prompt-template.md:114-116` — Design Notes defer the `ModelPort` system/user join and signature to 6.3/6.4; 6.2 must not pre-empt it.

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/model/labelSetValidation.ts` (new) — strict Zod schema parameterised by the active taxonomy (`labelSetSchema`), a pure `validateLabelSet(raw, taxonomy) → { ok; labels; reason? }`, and `completeWithRetry(options: CompleteWithRetryOptions)` implementing the ≤3-attempt loop, the `{ labels: [] }` fallback, and one `LogPort.error` carrying raw + reason — one module turns an untrusted `ModelPort` reply into a verdict plus the safe fallback. (The `options` object incl. `context` replaced the planning-shorthand 6-arg signature — repo idiom and the only way to carry `accountId`/message id into the exhausted-path log; confirmed with the human 2026-10-09.)
- [x] `tests/adapters/model/label-set-validation.test.ts` (new) — one test per I/O matrix row with a stub `ModelPort` returning scripted responses — the reply is untrusted input, so only verdict/retry/fallback assertions catch a regression.
- [x] `src/adapters/index.ts` — export the new module and its result types — the CLI/DI seam 6.3/6.4 wire.
- [x] Leave `src/core/skill/prompt.ts`, `src/core/ports/ModelPort.ts`, the DTOs, and `src/adapters/config/taxonomy.ts` untouched.

**Acceptance Criteria:**
- Given a raw reply whose `labels` is a string array of names all present in the active taxonomy, when validation runs, then the labels are accepted unchanged (empty array included).
- Given a raw reply that is malformed, non-string, or names a label outside the taxonomy, when validation runs, then it is rejected, retried to a total of at most 3 calls, and — if still invalid — yields `{ labels: [] }` with one error log carrying the raw response and reason.
- Given a configured `temperature`, when the retry issues its calls, then every call uses that configured value.
- Given the mise-pinned Node 20, when `bun run test`, `bun run lint`, and `bun run build` run, then all exit 0.

## Implementation Notes

- 2026-10-09 (implementation): new `src/adapters/model/labelSetValidation.ts` (110 lines) exports `labelSetSchema(taxonomy)` (strict, membership-bound), `validateLabelSet(raw, taxonomy)`, and `completeWithRetry(options)`; new `tests/adapters/model/label-set-validation.test.ts` (264 lines, 11 tests) covers every I/O-matrix row plus retry budget, temperature/prompt/schema passthrough, and log context against a stub `ModelPort`; `src/adapters/index.ts` exports the module and its types. `MAX_ATTEMPTS = 3`. Core untouched — no `zod` in `core/`, `ModelPort` unchanged.
- Signature deviation (human-confirmed 2026-10-09): the planning shorthand `completeWithRetry(model, prompt, schema, config, taxonomy, log)` became `completeWithRetry(options: CompleteWithRetryOptions)` to carry a `context: LogContext` (accountId, message id) into the exhausted-path log, matching the repo's options-object idiom.
- Verified 2026-10-09 by the orchestrator: `bun run test` 25 files / 414 tests green + `tsc --noEmit`; `bun run lint` exit 0; `bun run build` exit 0. (One full-suite run flaked on the unrelated `tests/adapters/token/token-store.test.ts` 5s timeout under 25-worker load; it passed alone and the suite re-ran green.) Mutation checks by the implementer: removing `.strict()` fails MALFORMED; removing the membership refine fails 3 tests; `MAX_ATTEMPTS = 2` fails 3 tests — all reverted byte-identical.
- 2026-10-09 (review loop): step-04 triage ran with all four layers (verification-gap found none). Four `low`/`medium` patches applied by re-engaging the implementation subagent: provider rejections are now caught inside `completeWithRetry` and treated as a failed attempt; duplicate labels are rejected by the schema; `labelSetSchema` returns the inferred strict type instead of `z.ZodType<LabelSet>`; and the third-attempt recovery, duplicate, and provider-error tests were added. Re-verified: `bun run test` 25 files / 417 tests green + `tsc --noEmit`; `bun run lint` exit 0; `bun run build` exit 0. `review_loop_iteration` remains 0 — no spec re-derivation.
## Spec Change Log

## Review Triage Log

Adversarial review of `5419c00`, 2026-10-09. All four layers reported (blind hunter, edge case hunter, verification gap, acceptance auditor): the verification-gap layer found no gaps; the others filed the rows below. No `intent_gap` or `bad_spec` entries — `review_loop_iteration` stays `0`.

| # | Finding (layer) | Verdict | Route | Evidence |
|---|-----------------|---------|-------|----------|
| 1 | A rejected `model.complete` escapes `completeWithRetry` (blind hunter + edge case hunter) | `medium` | patch | Verified at `src/adapters/model/labelSetValidation.ts:96`: the awaited call has no try/catch, so a provider/network rejection propagates out of the unit and violates the frozen "never throws out of the per-message path". Fixed by catching the throw, recording its message as the attempt's reason, and continuing; the exhausted path still logs and returns `{ labels: [] }`. |
| 2 | `model.complete` can hang; no timeout bounds the unit (edge case hunter) | `false` | — | The spec never asks this unit to bound wall-clock time; provider timeouts/backoff belong to the adapter (6.3) and Epic 9 (`epic-6-context.md`), and adding one here would pre-empt them. |
| 3 | Duplicate labels accepted and array length unbounded (blind hunter) | `low` | patch | Verified at `:33-40`: the schema checks membership only, so `{ labels: ["Invoices", "Invoices"] }` passes. A label *set* has no repeats, and rejecting duplicates bounds the array to the ≤50-label taxonomy. Smallest fix: one uniqueness check. |
| 4 | Rejection reason never names the offending value (blind hunter) | `false` | — | The raw response is logged in the same entry (`:104-108`), so the offending value is preserved; `reason` names the field path and cause, which is what the spec requires. |
| 5 | `reason` seed "the model returned no response" is unreachable (blind hunter) | `false` | — | Harmless defensive default: every failed attempt overwrites it with the attempt's reason. No misleading text can surface, so no bad outcome occurs. |
| 6 | `LabelSetValidation` is not a discriminated union (blind hunter) | `false` | — | Callers branch on `ok` and the runtime invariant holds; the claim is a type-shape preference with no named caller that diverges — not a severity grade. |
| 7 | Schema and membership `Set` rebuilt on every validation (blind hunter) | `low` | — | Real but negligible (a ≤50-entry map built ≤3× per exhausted message); rejected-low — unlikely to be met in everyday use and the fix adds memoization complexity. |
| 8 | Exhausted-path log omits attempt metadata (blind hunter) | `false` | — | The spec requires the raw response, the reason and per-message context; attempt count is not part of the contract and the budget is a constant. |
| 9 | `context` is optional though the Code Map says the log carries accountId + message id (blind hunter) | `false` | — | `context` is supplied and merged by the caller (`:107`) and asserted in the exhausted test; the type correctly allows a caller with no per-message context. |
| 10 | No test recovers on the third (final) attempt (blind hunter) | `low` | patch | Verified: LATE RECOVERY covers attempt 2 only, so a valid reply on the exact `MAX_ATTEMPTS` boundary is untested. Smallest fix: one test. |
| 11 | Code Map line spans stale (`prompt.ts:88-92`; `spec-6-1:63-68`) (blind hunter) | `low` | patch | Verified: `buildPrompt` is at `src/core/skill/prompt.ts:103`, and the deferral note at `spec-6-1-classification-prompt-template.md:114-116`. Agent-owned Code Map correction, not a requirements edit. |
| 12 | Spec `in-progress` while every task is `[x]` / sprint status (blind hunter) | `false` | — | Build lifecycle: step-03 keeps the spec `in-progress` through implementation and step-04 moves it to `in-review` (done before this review). |
| 13 | A partially valid reply discards its valid labels (blind hunter) | `false` | — | Strict all-or-nothing is the intended semantics of the strict output contract (precision over recall, membership in the active taxonomy); a set with one invalid entry is not a valid classification. |
| 14 | File-naming drift: `labelSetValidation.ts` is camelCase (blind hunter) | `false` | — | Matches the repo's existing pattern (camelCase source, kebab-case test): `messageMapper.ts`/`message-mapper.test.ts`, `accountSettings.ts`/`account-settings.test.ts`. |
| 15 | Exhausted test does not assert the log message text (blind hunter) | `false` | — | The log line's wording is not part of the contract; the spec pins that the entry carries raw + reason + context, which the test asserts. |
| 16 | `labelSetSchema` returns `z.ZodType<LabelSet>`, erasing the strict-object type (blind hunter) | `low` | patch | Verified at `:32`. The annotation widens the barrel's public surface to a `zod` type and hides strictness. Smallest fix: return the inferred schema type. |
| 17 | `prompt: string` cannot take `buildPrompt`'s `PromptParts` directly (edge case hunter) | `false` | — | 6.1 deliberately kept the system/user halves separate and deferred the join to 6.3/6.4 (`spec-6-1-…:116`); `ModelPort.complete` takes one string, so the unit correctly takes the joined prompt. |

## Design Notes

Reading B keeps retry where AD-3 puts it (adapters) and leaves `ModelPort` untouched for 6.3/6.4, as 6.1 deferred. Strictness mirrors the taxonomy-override schema: an unexpected key is a malformed reply, not a field to strip. Retry exhaustion is a deliberate soft failure — an empty label set is valid, so an unclassifiable message must not abort the batch (epic-6-context "Failures degrade gracefully"). Membership is checked against the *active* taxonomy, so a dropped label can never be re-emitted.

## Verification

**Commands:**
- `mise exec node@20 -- bun run test` — expected: `vitest run` green (including the new tests), then `tsc --noEmit` green.
- `mise exec node@20 -- bun run lint` — expected: exit 0 (AD-10 respected).
- `mise exec node@20 -- bun run build` — expected: exit 0.
