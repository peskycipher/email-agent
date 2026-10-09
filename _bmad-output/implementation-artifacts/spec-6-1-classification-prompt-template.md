---
title: 'Story 6.1 — Classification prompt template'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: 'ba0238d52dcff5f745d192e4039080d260c77e20'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The skill core has no prompt at all: `src/core/` holds only DTOs and ports, so nothing renders a model request and no later story can classify a message. Without a fixed, taxonomy-parameterised prompt the model is also free to invent label names the active taxonomy does not contain.

**Approach:** Add a pure prompt builder to the skill core that renders a system prompt (the active taxonomy's names and descriptions, 3–5 few-shot examples, the exact JSON output shape, and an instruction to return only valid JSON) and a user prompt (subject, `bodyPreview` truncated to 2000 chars, sender email and name, `receivedDateTime`, existing labels), parameterised by the merged frozen taxonomy so user edits take effect on the next load.

**Few-shot examples (human decision, 2026-10-09):** Synthesised from the taxonomy itself — each of the first 3–5 labels contributes a one-line synthetic email built from its name and description, so no example can ever name a label the user removed. OPTION_B (hand-written examples paired by position) and OPTION_C (authored in the taxonomy source) were rejected: the former breaks as soon as a user reorders or renames a label, the latter adds schema work in `adapters/config` beyond this story's placement.

## Boundaries & Constraints

**Always:** Core stays runtime-dependency-free — type-only imports, no `node:` builtins, no I/O, no logging, no clock, no randomness. The builder must not mutate the message or the taxonomy it is given. Every label name the prompt can teach, few-shot examples included, must come from the passed taxonomy. `src/core/index.ts` stays type-only, so `tests/core/scaffold.test.ts`'s zero-runtime-keys assertion keeps passing. Truncating `bodyPreview` is the builder's job — no adapter truncates it today.

**Never:** No Zod and no output validation (that is Story 6.2). No `ModelPort` call, no adapter import, no `loadTaxonomy` import (it lives in `adapters/config` and would break AD-10), no new dependency. Do not widen `ModelPort.complete`'s single-`prompt` signature — 6.3/6.4 own that. No eval or benchmark harness.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SYSTEM | any taxonomy of 1–50 labels | system text carries every label's name and description, the exact JSON shape, the instruction to return only valid JSON, and that an empty array is a valid answer | n/a |
| FEW-SHOT | a taxonomy of ≥5 labels | 3–5 example blocks; every label named in an example belongs to the taxonomy | n/a |
| TAXONOMY SMALLER THAN THE EXAMPLE COUNT | a taxonomy of 1–2 labels | as many examples as the taxonomy can support — never an example naming an absent label | n/a |
| USER FIELDS | a fully populated `MessageDTO` | user text carries subject, sender name and email, `receivedDateTime`, and existing labels | n/a |
| BODY AT THE BOUNDARY | `bodyPreview` of exactly 2000 chars | included whole, unmarked | n/a |
| BODY OVER THE BOUNDARY | `bodyPreview` longer than 2000 chars | exactly the first 2000 chars | n/a |
| EMPTY EXISTING LABELS | `existingLabels: []` | rendered as an explicit "none" marker, not a blank or omitted field | n/a |
| PURITY | any input | identical output across repeated calls; the passed `MessageDTO` and taxonomy are unmodified; nothing is written anywhere | n/a |

</frozen-after-approval>

## Code Map

- `src/core/dto/MessageDTO.ts:1-18` — `subject`, `bodyPreview`, `senderEmail`, `senderName`, `receivedDateTime` (ISO 8601 string), `existingLabels: string[]`; `accountId`, `internetMessageId` and `isRead` exist but the prompt does not need them. Reuse as-is; add no fields.
- `src/core/dto/LabelDef.ts` — `{ name, description, m365Color, gmailColor }`; the prompt uses name + description only. It also exports the runtime `LABEL_NAME_PATTERN`, which `src/core/index.ts` deliberately does **not** re-export — the precedent for a type-only barrel.
- `src/core/dto/Taxonomy.ts` — `Taxonomy = LabelDef[]`, the array `loadTaxonomy()` returns.
- `src/core/ports/ModelPort.ts:3-13` — `complete(prompt: string, schema, config)` takes one string, so combining the system and user parts is 6.3/6.4's concern, not this story's.
- `src/adapters/config/taxonomy.ts` — `loadTaxonomy()`: merges `taxonomy.yaml` with `taxonomyOverrides`, validates 1–50 labels, freezes labels and the array. It imports `js-yaml` and `zod`, so core must never import it — the taxonomy arrives as a parameter.
- `src/core/index.ts` + `tests/core/scaffold.test.ts` — the barrel is type-only; the test asserts `Object.keys(core)` is empty, so a runtime export would fail it.
- `tests/core/` — where the new test goes. Idiom: `import { test, expect } from "vitest"` plus `../../src/….js` with an explicit `.js` extension. No tsconfig covers `tests/`, so a type error in a test is not caught by `bun run typecheck`.
- `tsconfig.core.json` — `rootDir: src/core`, `include: ["src/core/**/*"]`, so a new module under `src/core/skill/` compiles with no config change. `.oxlintrc.json` bans `src/core/**` from importing `adapters/`, `cli/` or `orch/`, run by `bun run lint`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/skill/prompt.ts` (new) — export a pure builder taking `(message: MessageDTO, taxonomy: Taxonomy)` and returning the system and user prompt parts; render the taxonomy names + descriptions, the few-shot examples, the JSON contract and the field list; state that an empty array is valid and that precision beats recall; truncate `bodyPreview` to 2000 chars; render empty `existingLabels` explicitly. — One place defines the model request, so 6.2 and 6.4 compose it instead of re-deriving the format.
- [x] `tests/core/prompt.test.ts` (new) — one test per I/O matrix row: label names and descriptions present, every label named in an example belongs to the taxonomy, both sides of the 2000-char boundary, the empty-labels marker, and inputs unmutated across two identical calls. — The output is text, so only assertions on the rendered string catch a silently dropped field or an example naming a label the user deleted.
- [x] `src/core/index.ts` — leave type-only; if the builder's return type belongs in the barrel, re-export it as `export type` only. — Keeps `tests/core/scaffold.test.ts` green and follows the `LABEL_NAME_PATTERN` precedent.

**Acceptance Criteria:**
- Given a merged taxonomy, when the builder runs, then the system text presents every label's name and description, states that an empty array is valid, and no label outside the taxonomy is presented as valid.
- Given a `bodyPreview` longer than 2000 characters, when the builder runs, then the user text carries exactly its first 2000 characters.
- Given the same inputs, when the builder runs twice, then the output is identical and neither the message nor the taxonomy was modified.
- Given the mise-pinned Node 20, when `bun run test` and `bun run lint` run, then both exit 0.

## Implementation Notes

- 2026-10-09 (implementation): `src/core/skill/prompt.ts` (new, 92 lines) exports `buildPrompt(message, taxonomy): PromptParts`, plus the type-only `PromptParts`; `tests/core/prompt.test.ts` (new, 140 lines) adds 8 tests, one per I/O matrix row; `src/core/index.ts` gains one type-only re-export, so the barrel keeps zero runtime keys. Few-shot examples are synthesised from the first 3–5 taxonomy labels (name → example subject, description → example body, that label → answer), per the frozen human decision.
- Verified 2026-10-09 by the orchestrator against the diff: `bun run test` 24 files / 401 tests green plus `tsc --noEmit`; `bun run lint` exit 0; `bun run build` exit 0; AD-10 negative check — a temporary core→adapters `import type` makes `bun run lint` fail with the AD-10 message, and lint returns to exit 0 after the revert.

- 2026-10-09 (review loop): step-04 triage ran; the blind-hunter layer returned no findings, the edge case hunter filed two robustness notes (one refuted, one rejected as negligible), and the verification-gap layer filed one real gap. One patch applied: the FEW-SHOT test now asserts each example block's `Body:` line is its label's description (mutation-checked). No deferrals. `review_loop_iteration` remains 0 — no spec re-derivation was needed.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Route | Evidence |
|---|-----------------|---------|-------|----------|
| 1 | `buildSystem` has no guard for an empty `Taxonomy`, so the prompt would render zero labels and a dangling `Examples:` header (`src/core/skill/prompt.ts:44-50`) (edge case hunter) | `false` | — | Not reachable in this system: `loadTaxonomy` enforces `MIN_LABELS = 1` (`LABEL_COUNT_OUT_OF_BOUNDS`) and freezes the result, and the builder has no other caller — a repo-wide search finds `buildPrompt` only in `prompt.ts`, the barrel and the test. The function's specified domain is 1–50 labels, so a throw would guard a state the program cannot produce. |
| 2 | `bodyPreview.slice(0, 2000)` truncates by UTF-16 code unit, so an astral character straddling the boundary leaves a lone surrogate (`src/core/skill/prompt.ts:80`) (edge case hunter) | `low` | — | Real but negligible and rare: the trigger is a surrogate pair landing exactly on index 2000, and the harm is a single replacement character at the tail of an already-truncated preview. Not fixed because the correct behaviour is not unambiguous — the criterion says "2000 chars" without settling code units against code points — so pinning it belongs to whoever owns the prompt budget rather than to a silent one-line swap. |
| 3 | The few-shot example `Body:` line (the label's description) is never asserted, so deleting it keeps every test green (verification gap) | `medium` | patch | Pre-verified gap; confirmed by reading the test, whose FEW-SHOT case checked only block count, `Answer:` JSON and `Subject:` lines. Fixed by asserting that each example block carries its label's description — verified it fails when that `Body:` line is removed. |

Layers: edge case hunter and verification gap reported; **blind-hunter returned no findings** (recorded as a failed layer), so this review may be incomplete. No `intent_gap` or `bad_spec` entries — `review_loop_iteration` stays `0`.

## Design Notes

The system/user split is kept because the acceptance criteria name both parts separately; how they are combined into `ModelPort.complete`'s single `prompt` argument is Story 6.3/6.4's decision, and this builder must not pre-empt it by flattening them.

Few-shot examples are synthesised from the taxonomy (human decision, 2026-10-09) rather than hardcoded: a user who drops or renames a label in `taxonomy.yaml` would otherwise be taught, by the prompt's own examples, to emit a label that no longer exists — which this story's "every label must come from the active taxonomy" criterion forbids.

`tests/` is not type-checked by any tsconfig, so the new test's own types are verified only by it running green.

## Verification

**Commands:**
- `mise exec node@20 -- bun run test` — expected: `vitest run` green including the new prompt tests, then `tsc --noEmit` green.
- `mise exec node@20 -- bun run lint` — expected: exit 0.
- `mise exec node@20 -- bun run build` — expected: exit 0, the new core module compiles with no tsconfig change.
- AD-10 negative check: temporarily add `import type { LabelDef } from "../../adapters/index.js";` to the new core module; `bun run lint` must fail with the AD-10 message; revert.
