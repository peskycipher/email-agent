---
title: 'Story 1.2: Port Interfaces Definition (per-account)'
type: 'feature'
created: '2026-10-08'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'e54d23bf719601faa988bd7fb333869cedc5c468'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The core exposes no contract surface. Every adapter (M365, Gmail, Model, Token, Idempotency, Scheduler, Logger, Config), the skill, and orchestration need frozen port interfaces to implement against; without them later epics invent their own shapes and per-account context gets dropped.

**Approach:** Define the seven port interfaces in `src/core/ports/` exactly as AD-3..AD-9 and Story 1.2's AC specify, threading `accountId` through every account-touching method and keeping the files type-only (interfaces plus `import type`) so core stays dependency-free.

**Decision (human, 2026-10-08):** the contract layer lands together — this story also creates the DTO type files the ports reference (`MessageDTO`, `LabelDef`, `TokenSet`, `ModelConfig`, `Config`) using Story 1.3's exact shapes so the ports compile; Story 1.3 then narrows to DTO validation (Zod schema, `accountName` regex, taxonomy-checked `LabelSet`).

## Boundaries & Constraints

**Always:**
- `src/core/**` stays dependency-free (AD-10): only `import type` from other `src/core` files, no runtime imports or SDKs. Guarded by `bun run build` and `bun run lint`.
- Port files are `PascalCase` (`MailPort.ts`) per the spine's Structural Seed, each exporting an `interface` of the same name; relative imports carry `.js` (ESM `nodenext`).
- Every account-touching method takes `accountId`: `TokenPort.get/set/delete`, `MailPort.writeLabels`, `MailPort.ensureCategories`, `FetchOpts`; `LogContext` carries an optional `accountId`.
- Signatures verbatim from AD-3..AD-9 and Story 1.2's AC — no narrowing, widening, or renaming.

**Never:**
- No adapter implementations, skill logic, DI wiring, or CLI commands — later epics own those.
- No runtime values in `core/ports/**` (no enums, consts, classes).
- No abstraction the AC does not name (no `Provider` union, no factory) — repeat the `"m365" | "gmail"` literal.
- Do not modify planning artifacts, `_bmad/**`, or `.agents/**`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ports compile | `bun run build` over `src/core/ports/**` | `tsc -b` exits 0; every port resolves its types | n/a |
| Missing accountId | caller does `TokenPort.get(provider)` | compile error — parameter required | intended; do not make it optional |

</frozen-after-approval>

## Code Map

- `_bmad-output/planning-artifacts/architecture/architecture-email-agent-2025-01-15/ARCHITECTURE-SPINE.md` — authoritative Structural Seed (`:150-176`) naming every `core/ports/*.ts` / `core/dto/*.ts`; AD-3..AD-9 exact signatures; AD-10 dependency direction. The seed's tree wins over `epics.md` shorthand (Story 1.1's call).
- `_bmad-output/planning-artifacts/epics.md` — Story 1.2 AC (`:239-257`) signatures + `FetchOpts`; Story 1.3 AC (`:258-276`) DTO shapes.
- `_bmad-output/implementation-artifacts/epic-1-context.md` — port/DTO lists, idempotency-key format, `accountId` threading, "define DTOs and ports together".
- `_bmad-output/specs/spec-email-classification-skill/SPEC.md` — CAP-3..5, CAP-10. **Stale on scope:** still says "single-account per provider"; the 2026-10-08 decision made v1 multi-account — follow `epics.md`.
- `src/core/index.ts`, `src/core/{ports,dto}/.gitkeep` — empty scaffold from Story 1.1.
- `tsconfig.core.json` — `include: ["src/core/**/*"]`, `rootDir: src/core`, `outDir: dist/core`.
- `.oxlintrc.json` — AD-10 rule for `src/core/**`; a core→adapter import fails lint.
- `tests/core/scaffold.test.ts` — asserts `Object.keys(core)` empty; type-only exports keep it green.
- `deferred-work.md` entry 5 (tsc/tests type-checking) — **not** owned by this story.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/ports/MailPort.ts` — `interface MailPort { fetchMessages, writeLabels, ensureCategories }` verbatim; `import type` `MessageDTO`, `FetchOpts`, `LabelDef`.
- [x] `src/core/ports/ModelPort.ts` — `interface ModelPort { complete(...) }`; export the local `JsonSchema` structural type it consumes (core cannot import zod).
- [x] `src/core/ports/TokenPort.ts` — `interface TokenPort { get/set/delete }`, provider union and `accountId` inline; `import type` `TokenSet`.
- [x] `src/core/ports/IdempotencyPort.ts` — `interface IdempotencyPort { has, set }`.
- [x] `src/core/ports/SchedulerPort.ts` — `interface SchedulerPort { runOnce, runInterval }`; `runInterval` returns `Promise<AbortController>`.
- [x] `src/core/ports/LogPort.ts` — `interface LogPort` (sync `debug/info/warn/error`) plus exported `LogContext` with optional `accountId`.
- [x] `src/core/ports/ConfigPort.ts` — `interface ConfigPort { load(): Promise<Config> }`; `import type` `Config`.
- [x] `src/core/dto/FetchOpts.ts` — `interface FetchOpts` (`source`, `accountId`, `since?`, `batchSize?`, `folder?`) — here per the spine seed, not `core/ports/`.
- [x] `src/core/dto/{MessageDTO,LabelDef,TokenSet,ModelConfig,Config}.ts` — Story 1.3's exact shapes, type-only (`LabelSet`/`Taxonomy` stay in Story 1.3).
- [x] `src/core/index.ts` — `export type` re-exports for ports + DTOs (no runtime exports).
- [x] remove `src/core/{ports,dto}/.gitkeep` once real files land.
- [x] `tests/core/ports.type-test.ts` — durable `@ts-expect-error` type test covering the missing-`accountId` matrix row, so AC 3 is reproducible instead of a throwaway probe.

**Acceptance Criteria:**
- Given the seven port files exist, when `bun run build` runs, then `tsc -b` exits 0 and emits `dist/core`.
- Given each port file is inspected, then every method matches the AC verbatim and every account-touching method takes `accountId`.
- Given a caller omits `accountId` from `TokenPort.get`, when type-checked, then TypeScript reports a missing-argument error.
- Given `src/core/index.ts` re-exports the contracts, when `bun run test` runs, then the smoke test passes and `Object.keys(core)` is empty.
- Given `bun run lint` runs, then oxlint exits 0 on `src/core/**`.
- Given `git ls-files src/core`, then every AC-named port/DTO file is tracked and no `.gitkeep` remains in `src/core/{ports,dto}` (`src/core/skill/.gitkeep` stays — Epic 6 fills that directory).

## Implementation Notes

- 2026-10-08 — Implemented type-only, as the spec requires: every port/DTO file uses `import type`, and `dist/core/index.js` emits `export {}`. All seven ports + six DTOs (`FetchOpts`, `MessageDTO`, `LabelDef`, `TokenSet`, `ModelConfig`, `Config`) landed; `LabelSet`/`Taxonomy` correctly stayed in Story 1.3.
- 2026-10-08 — AC 3 needed a durable check: the matrix row "missing `accountId`" was first only a temporary probe. Added `tests/core/ports.type-test.ts` with an `@ts-expect-error` on `tokenPort.get("m365")`; verified with `tsc --noEmit --ignoreConfig` (exit 0) and confirmed the directive is load-bearing (removing it yields `TS2554: Expected 2 arguments, but got 1`). TypeScript 7 requires `--ignoreConfig` whenever files are passed on the CLI.
- 2026-10-08 — AC 6 clarified: `src/core/skill/.gitkeep` is retained because Story 1.2 creates no skill files (Epic 6 owns that directory); only `src/core/{ports,dto}/.gitkeep` were removed.
- 2026-10-08 — Judgment calls where the AC is silent (flagged for Story 1.3 / review): `ModelConfig.provider` is the inline union `"jev" | "openai" | "anthropic" | "custom"`; `MessageDTO.receivedDateTime: string` (ISO 8601) and `TokenSet.expiresAt: number` (epoch ms) follow the architecture diagrams, while `FetchOpts.since?: Date` is AC-verbatim `Date`; `Config.taxonomyOverrides?: Partial<LabelDef>[]` (the AC left the element shape open); `JsonSchema` is minimal (`type`/`properties`/`items`/`required`).
- 2026-10-08 — Review round 1 patches applied by the parent (the step-03 run was not resumable): (BH-1/VG-1/BH-6) the AC-3 type test was orphaned — vitest's default include missed `.type-test.ts` and no tsconfig includes `tests/` — so a `typecheck` script was added to `package.json` and folded into `test` (`vitest run && bun run typecheck`), and `ports.type-test.ts` now covers `TokenPort.get/set/delete`, `MailPort.writeLabels/ensureCategories` and `FetchOpts.accountId`; verified by a regression control (optional `accountId` → typecheck fails). (BH-2) `Config.taxonomyOverrides` element type tightened from `Partial<LabelDef>` to `Pick<LabelDef, "name"> & Partial<Omit<LabelDef, "name">>` so the merge key is required.
- 2026-10-08 — Independent `bmad-code-review` pass (4 layers) applied both patches: `ports.type-test.ts` now passes `undefined` where `accountId` is omitted (so each `@ts-expect-error` isolates that parameter) and imports every contract name from `core/index.js`; both regression controls fail the typecheck as intended.

## Spec Change Log

## Review Triage Log

Round 1 — diff `/tmp/bmad-1-2-review-1791439287.diff` (baseline `e54d23b`; 17 files, ~18 kB). Layers: Blind Hunter (7 findings), Edge Case Hunter (0 findings), Verification Gap (1 pre-verified finding). All three ran; none skipped.

| Finding (layer, location) | Verdict | Evidence and route |
|---|---|---|
| BH-1 — the new AC-3 type test is not wired into any automated check (`tests/core/ports.type-test.ts`) | medium | Verified: `bun run test` loaded only `tests/core/scaffold.test.ts` (vitest's default include does not match `.type-test.ts`), and `tsconfig.{core,adapters,cli}.json` include only `src/**`, so no tsconfig type-checks `tests/`. The guard runs only via the spec's one-off `tsc --noEmit` line — `accountId` could loosen with `build`/`test`/`lint` all still green. **patch** (grouped with VG-1, BH-6). |
| VG-1 — same root: the `@ts-expect-error` `accountId` guard never runs in the normal path | medium | Pre-verified by the layer; demonstrated that making `accountId` optional keeps `build`/`test`/`lint` green while the directive becomes unused. **patch** (same entry as BH-1). |
| BH-6 — AC-2 is verified only by inspection; the type test covers just `TokenPort.get` | low | Verified: only one `@ts-expect-error` case exists. **patch** (extend the test to the other account-touching members). |
| BH-2 — `Config.taxonomyOverrides?: Partial<LabelDef>[]` admits a nameless `{}` override that matches no label (`src/core/dto/Config.ts:5`) | low | Verified: `Partial` makes `name` optional. Harm is bounded (Story 1.3 adds Zod validation), but requiring the merge key is a one-line correction. **patch**. |
| BH-5 — time values spelled two ways: `MessageDTO.receivedDateTime: string` vs `FetchOpts.since?: Date` (`src/core/dto/MessageDTO.ts:8`, `src/core/dto/FetchOpts.ts:4`) | low | Verified against the diff; Story 1.2 AC pins `since?: Date`, while `receivedDateTime` is Story 1.3's to finalize. Real convention risk for later mappers. **defer** (Story 1.3 owns DTO finalization). |
| BH-7 — minimal `JsonSchema` has no follow-up anchor (`src/core/ports/ModelPort.ts:4`) | low | Verified: `JsonSchema` is intentionally minimal and no deferred item records tightening it. **defer**. |
| BH-3 — `MessageDTO` sender has three representations across AD-2 (`sender`), the diagrams (`Sender{}`), and Story 1.3 AC (`senderEmail`/`senderName`) | false | The implementation correctly follows Story 1.3's AC, the operative story contract; the divergence is a pre-existing planning-artifact inconsistency outside this story's edit bounds. The claimed code defect does not occur. **reject**. |
| BH-4 — the Implementation Note's "follow the architecture diagrams" is inaccurate for `TokenSet.expiresAt`/`scopes` | low | The code follows Story 1.3 AC (required `expiresAt`, `scopes`), not the diagrams; only the note's wording is imprecise. Its sole fix edits this build's spec documentation → **reject** per triage rule. |

Edge Case Hunter returned no findings.

Loopback check: no `intent_gap` or `bad_spec` entry survived triage, so there is no loopback and `review_loop_iteration` stays 0. Patches: BH-1/VG-1/BH-6 (wire the type test into the verification path and extend its coverage) and BH-2 (require the override key). Deferred: BH-5, BH-7.

## Design Notes

- **`PascalCase` port files** per the spine's Structural Seed (wins over the kebab-case convention, as in Story 1.1).
- **Type-only, local `JsonSchema`:** `core/` is dependency-free (AD-10), so ports declare no runtime values and `JsonSchema` is a minimal structural type exported from `ModelPort.ts` — not a zod/JSON-Schema import.
- **`FetchOpts` in `core/dto/`** despite the AC listing it among the port items — the spine's seed places it there.
- **Barrel stays green:** `export type` erases at runtime, so `Object.keys(core)` stays `[]`.

## Verification

**Commands:**
- `bun run build` — exit 0, `dist/core` emitted.
- `bun run lint` — exit 0 on `src/core/**`.
- `bun run test` — exit 0, smoke test passes.
- `git ls-files src/core` — seven `ports/*.ts`, referenced `dto/*.ts`, barrel; no `.gitkeep`.
- Negative: drop `accountId` from a port method and run `bun run build` — expect a failure, then revert.
- `bun run typecheck` (also run by `bun run test`) — exit 0; its `@ts-expect-error` cases prove every account-touching member rejects a missing `accountId`. Regression control: making `accountId` optional makes typecheck fail with `Unused '@ts-expect-error' directive`.

### Review Findings

Code review of `e54d23b..58c120a` (2026-10-08), layers: Blind Hunter, Edge Case Hunter, Verification Gap, Acceptance Auditor.

- [x] [Review][Patch] AC-3 type test overclaims its coverage — `set` / `writeLabels` / `ensureCategories` cases do not isolate `accountId` [tests/core/ports.type-test.ts:18,22,24] — verified: widening `writeLabels(accountId: string)` to `string | undefined` leaves `bun run typecheck` green, because those calls supply a valid `accountId` and fail on a different missing/mistyped argument. Fix: supply the remaining args and pass `undefined` as the omitted `accountId` (add a `declare const tokens: TokenSet` fixture) so the only error is `undefined` not assignable to `string`.
- [x] [Review][Patch] Barrel type re-exports are unverified [src/core/index.ts:1-14] — no test imports any contract name from `core/index.js`, so dropping a re-export (AC-4) ships with `build`/`lint`/`test` all green. Fix: import the contract names from `../../src/core/index.js` in `ports.type-test.ts` and `void`-use each.
- [x] [Review][Defer] `TokenSet.expiresAt` (epoch ms) is a third point-in-time representation the deferred item does not name [src/core/dto/TokenSet.ts:6] — deferred: documentation completeness; settle it with the existing `receivedDateTime`/`since` convention item.
- [x] [Review][Defer] `ModelConfig.provider` ships `"anthropic" | "custom"` beyond the providers AD-3/epics name, with no deferred anchor [src/core/dto/ModelConfig.ts:2] — deferred: ratify or narrow the union in Story 1.3 (the analogous `JsonSchema` judgment is already deferred).
- [x] [Review][Defer] AD-2's single `sender` field vs Story 1.3's `senderEmail`/`senderName` stays an untracked planning inconsistency [ARCHITECTURE-SPINE.md AD-2] — deferred: pre-existing planning-artifact drift; reconcile in a planning pass (the code correctly follows Story 1.3 AC).
- [x] [Review][Defer] Non-`accountId` contract shapes have no pin — a still-valid-TypeScript drift (e.g. `SchedulerPort.runInterval` returning `Promise<void>`) passes every check [src/core/ports/SchedulerPort.ts:3; src/core/ports/ModelPort.ts:11; src/core/ports/ConfigPort.ts:4] — deferred: no consumers exist yet; Story 1.3 / Epic 5 compilation will exercise these signatures.

#### Rejected

- `low` — spec frontmatter `status: 'done'` vs `sprint-status.yaml` `review` disagree [spec-1-2-…md:6] — the build workflow's step-05 prescribes exactly this pairing, and this review's final step reconciles it; not worth a change.
- `low` — `LogPort` renames the AC/AD-7 first parameter `info` to `message` [src/core/ports/LogPort.ts:6-9] — the rename is already recorded as an approved judgment call in this spec's Implementation Notes and is type-compatible; its only fix edits the spec under review.
- `low` — `typecheck` hardcodes flags that also live in `tsconfig.base.json` [package.json:15] — drift is speculative, and the fix is a new `tsconfig.test.json`, more surface than a direct correction.
