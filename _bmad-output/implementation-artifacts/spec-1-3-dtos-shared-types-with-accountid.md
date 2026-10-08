---
title: 'Story 1.3: DTOs & Shared Types (with accountId)'
type: 'feature'
created: '2026-10-08'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '9f82988c663cc787a4d21e452c5158822b0ffbed'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The core's type vocabulary is incomplete. Story 1.2 shipped six of Story 1.3's DTOs plus `FetchOpts`, but `LabelSet` and `Taxonomy` were never built, and three refinement items the earlier reviews assigned to this story are still open (`ModelConfig.provider` ratifying, a tighter `JsonSchema`, and pinning the non-`accountId` contract shapes). Story 4.1 (taxonomy), Epic 6 (skill) and Story 11.1 (config) all read these types.

**Approach:** Complete `src/core/dto/` with the two missing taxonomy types and the refinements, keeping `core/` dependency-free (AD-10).

**Decisions (human, 2026-10-08):** (1) **Scope** — complete the layer: add `LabelSet` + `Taxonomy` and resolve the three refinements prior reviews assigned to Story 1.3. (2) **Config validation** — type-only: `Config` stays an interface and `core/dto` exports a shared `ACCOUNT_NAME_PATTERN`; the zod schema stays in Story 11.1 / `adapters/config`. (3) **`Taxonomy` shape** — the bare `type Taxonomy = LabelDef[]` per Story 1.3's AC.

## Boundaries & Constraints

**Always:**
- `src/core/**` stays dependency-free (AD-10): only `import type` between `src/core` files — no external packages, no zod. Guarded by `bun run build` and `bun run lint`.
- DTO files are `PascalCase`, named after their export; relative imports carry `.js` (ESM `nodenext`).
- `Config` keeps the shipped field set (`m365.accounts`, `gmail.accounts`, `taxonomyOverrides?`, `tokenFallback.passphraseEnvVar`) from Story 1.3's AC.
- `LabelSet` and `Taxonomy` follow Story 1.3's AC (`epics.md:271-272`) for their declared shape.

**Never:**
- No adapter, skill, config-loader or validation logic — Stories 4.1 and 11.1 own taxonomy and config validation.
- No external import in `core/**` (a zod import fails AD-10 lint and `AGENTS.md`).
- No edits to planning artifacts (`_bmad-output/planning-artifacts/**`), `_bmad/**`, or `.agents/**`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DTOs compile | `bun run build` over `src/core/dto/**` | `tsc -b` exits 0 | n/a |
| Core imports zod | any `src/core` file imports `"zod"` | no check currently fails — AD-10's lint bans only adapters/cli/orch | not demonstrated in this story; do not add zod |

</frozen-after-approval>

## Code Map

- `_bmad-output/planning-artifacts/epics.md` — Story 1.3 AC (`:258-275`, the DTO shapes and the "validated schema" clause); Story 4.1 AC (`:336-352`, taxonomy defaults/override rules); Story 11.1 AC (`:699-714`, merged-taxonomy Zod validation, `accountName` regex before lookup, Config freeze).
- `_bmad-output/implementation-artifacts/epic-1-context.md` — Epic 1 goal, DTO list, AD-1..AD-10 constraints.
- `_bmad-output/planning-artifacts/architecture/.../ARCHITECTURE-SPINE.md` — AD-10 "core ← zero deps" (`:114-127`); Structural Seed lists `core/dto/{LabelSet,Taxonomy}.ts` (`:176-182`) and a separate `core/skill/schema.ts` "Zod schema for LabelSet output" (`:188`); config is Zod-validated in `main.ts` (`:112`) via `adapters/config/ConfigLoader.ts`.
- `_bmad-output/specs/spec-email-classification-skill/architecture-diagrams.md` (`:130-150`) and `glossary.md` (`:9-15`) — the `Taxonomy`/`LabelSet` class shapes and the `labels ⊆ Taxonomy.names` relation.
- `src/core/dto/{MessageDTO,LabelDef,TokenSet,ModelConfig,Config,FetchOpts}.ts` — shipped by Story 1.2; `Config.ts` is the file the AC's validation clause targets.
- `src/core/ports/ModelPort.ts:4-10` — the minimal `JsonSchema` to tighten; `src/core/dto/ModelConfig.ts:2` — the `provider` union to ratify.
- `tests/core/ports.type-test.ts` + `package.json` (`typecheck`, folded into `test`) — the guard to extend when pinning shapes.
- `_bmad-output/implementation-artifacts/deferred-work.md` — the three refinements assigned to Story 1.3 (provider union, `JsonSchema`, non-`accountId` shape drift).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/dto/LabelSet.ts` — `interface LabelSet { labels: string[] }` (Story 1.3 AC `:271`) — the classifier's multi-label output.
- [x] `src/core/dto/Taxonomy.ts` — `type Taxonomy = LabelDef[]` (decision 3) — the frozen label set.
- [x] `src/core/dto/accountName.ts` — `export const ACCOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/` with a doc comment (decision 2) — the one shared source of the name rule, no zod.
- [x] `src/core/index.ts` — `export type` re-exports for `LabelSet` and `Taxonomy` only (`ACCOUNT_NAME_PATTERN` is a runtime value and stays importable from `./dto/accountName.js`, so the 1.1 empty-barrel smoke test stays green).
- [x] `src/core/ports/ModelPort.ts` — add `additionalProperties?: boolean` and `enum?: unknown[]` to `JsonSchema` — resolves the deferred item.
- [x] `src/core/dto/ModelConfig.ts` — ratify the existing `provider` union with a doc comment (no shape change) — resolves the deferred item.
- [x] `tests/core/ports.type-test.ts` — extend the barrel/shape assertions to `LabelSet` and `Taxonomy` — pins the contract.
- [x] `tests/core/account-name.test.ts` — vitest cases for `ACCOUNT_NAME_PATTERN` (accepts `personal`, `a-b_1`; rejects `Personal`, `-bad`, and a 33-character name) — covers the regex AC row.

**Acceptance Criteria:**
- Given the new DTOs exist, when `bun run build` runs, then `tsc -b` exits 0.
- Given `LabelSet` is inspected, then it declares `labels: string[]` exactly.
- Given `Taxonomy` is inspected, then it is the bare `LabelDef[]` type.
- Given `ACCOUNT_NAME_PATTERN` is imported from `core/dto/accountName.js`, when tested, then it accepts `personal` and rejects `Personal`, `-bad`, and a 33-character name.
- Given the barrel re-exports the new type names, when `bun run test` runs, then the scaffold smoke test still passes and `Object.keys(core)` is empty.
- Given `bun run typecheck` runs, then `LabelSet` and `Taxonomy` resolve from `core/index.js`.

## Implementation Notes

- 2026-10-08 — Implemented per spec: `LabelSet`, `Taxonomy` (bare `LabelDef[]`), and `ACCOUNT_NAME_PATTERN`; `JsonSchema` gained `additionalProperties?`/`enum?`; `ModelConfig.provider` ratified by comment. The zod negative probe confirmed neither `build` nor `lint` catches an external import in `core/**` (deferred).
- 2026-10-08 — Review round 1 patch applied: `tests/core/account-name.test.ts` gained 1-char/32-char acceptance and a leading-`_` rejection; verified by a `{0,30}` regression control.

## Spec Change Log

## Review Triage Log

Round 1 — diff `/tmp/bmad-1-3-review-1791447635.diff` (baseline `9f82988`; 10 files). Layers: Blind Hunter (7 findings), Edge Case Hunter (0 findings), Verification Gap (1 pre-verified finding).

| Finding (layer, location) | Verdict | Evidence and route |
|---|---|---|
| BH-4 + VG-1 — the 1–32 length contract is only half-pinned; no test asserts a 32-char name is accepted | low | Verified: tightening the quantifier to `{0,30}` passed every test before the fix and now fails the new boundary case. **patch** (applied). |
| BH-1 — the spec says core's zero-dependency rule is "guarded by `bun run build` and `bun run lint`", but no check bans external-package imports in `core/**` | low | Verified: `.oxlintrc.json` bans only `**/adapters/**`, `**/cli/**`, `**/orch/**`; the zod probe passed both checks. The enforcement gap is pre-existing (AD-10's external-package rule was never implemented). **defer**. |
| BH-2 — `JsonSchema` refinement is 2/3: `type: string` stays un-narrowed | low | Verified: only `additionalProperties?`/`enum?` were added; the prior deferred item named a narrowed `type` keyword as a third piece. **defer**. |
| BH-3 — `src/core/dto/accountName.ts` is camelCase, against the kebab-case file convention | low | Verified cosmetic; the approved spec's task list names that exact path, and the DTO directory already mixes PascalCase DTO files with this helper. **reject**. |
| BH-5 — the Verification "Negative" row is self-contradictory (asks to record what the I/O matrix already states) | low | Verified; its only fix edits the spec under review. **reject**. |
| BH-6 — `ACCOUNT_NAME_PATTERN` is not re-exported from the core barrel, so consumers use a deep import path | low | Verified, and deliberate — documented in the task to keep the 1.1 empty-barrel smoke test green; the fix changes that contract. **reject**. |
| BH-7 — sprint status `in-progress` vs the spec's `in-review` | low | Verified; the build workflow's step-05 reconciles them, so it is transient, not a defect. **reject**. |

Edge Case Hunter returned no findings.

Loopback check: no `intent_gap` or `bad_spec` entry survived triage, so there is no loopback and `review_loop_iteration` stays 0. Patch applied (boundary test). Deferred: BH-1, BH-2.

## Design Notes

- **`Config` stays an interface, not a schema** (decision 2): zod is an external package and `core/` is explicitly zero-dependency; the runtime schema lives in `adapters/config/` and Story 11.1.
- **The taxonomy types are consumed by the classifier and the two sync adapters**, so their shape is a public contract the moment it lands.

## Verification

**Commands:**
- `bun run build` — exit 0.
- `bun run lint` — exit 0 on `src/core/**`.
- `bun run test` — exit 0 (smoke + typecheck).
- `bun run typecheck` — exit 0; the new DTO names resolve from `core/index.js`.
- Negative: temporarily import `"zod"` in a `src/core/dto` file and run `bun run lint` — record whether AD-10 catches it; revert.
