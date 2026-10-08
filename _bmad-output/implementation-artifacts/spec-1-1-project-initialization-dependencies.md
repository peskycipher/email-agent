---
title: 'Story 1.1: Project Initialization & Dependencies'
type: 'feature'
created: '2026-10-08'
status: 'done'
route: 'dispatch'
baseline_commit: '82083ae4f4d2326d18caa706a0cbb7c81cd54c35'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The project has no runnable scaffold — no `package.json`, TypeScript config, or hexagonal directory tree. Every later story (ports, DTOs, adapters, orchestration) needs a stable place to land, and without an enforced dependency rule `core/` will silently absorb adapter imports, making the pure-function invariant (AD-1) unenforceable and the `accountId` contracts costly to retrofit.

**Approach:** Initialize a Node.js 20 / TypeScript 5.5 ESM project with bun: install the planned dependency set, create the hexagonal directory tree (`src/core`, `src/adapters`, `src/cli`, `src/orch`, `tests/`), and encode `core ← adapters ← cli` in TypeScript project references. A `tsc -b` smoke build must pass over the otherwise-empty core.

**Decisions (human, 2026-10-07):**
- Package manager: **bun** (`bun install`, `bun.lock`).
- Module system: **ESM** (`"type": "module"`; tsconfig `module`/`moduleResolution` `nodenext` — TypeScript 5.5 has no `node20` module option).
- Node runtime: **engines only** — declare the Node 20 LTS line, install and build under this machine's Node 26.8.2. No version-pin file.
- **Split accepted:** the jest + ts-jest harness and the eslint boundary enforcement are deferred (see `deferred-work.md`); their dev dependencies stay declared here.

## Boundaries & Constraints

**Always:**
- Dependency direction is a hard rule, enforced by the project reference graph: `src/core` cannot resolve `src/adapters` or `src/cli`; `src/adapters` and `src/orch` may reach `core` only; `src/cli` may reach core + adapters.
- Stack pins: `@typesafe-ai/sdk` 0.6.0, `@microsoft/microsoft-graph-client` 3.0.7, `@microsoft/microsoft-graph-types` 2.43.x, `googleapis` 184.0.0, `better-sqlite3` 9.6.x, `zod` 3.23.x, `js-yaml` 4.1.x, `commander` 12.1.x, `pino` 9.2.x, `pino-roll` 1.11.x, `keytar` 7.9.x, `age-encryption`.
- Dev deps declared now, configured by the deferred specs: `typescript`, `@types/node`, `@types/better-sqlite3`, `@types/js-yaml`, `@types/keytar`, `jest`, `ts-jest`, `@types/jest`, `eslint` (8.x — the spine names legacy `.eslintrc.json`), `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`.
- ESM: relative imports carry explicit `.js` extensions once real imports land.
- Every directory named in the story AC must be tracked by git (empty dirs need a placeholder); the three barrel `index.ts` files are the `tsc -b` inputs that make the smoke build meaningful.
- Naming conventions from the spine: kebab-case files/dirs, `PascalCase` types, `*Port` / `*Adapter` / `*DTO` suffixes.

**Never:**
- No `jest.config.js`, no test files, no `.eslintrc.json`, no `lint`/`test` scripts — deferred to the two follow-up specs; the scripts would fail without their configs.
- No `config.yaml.example` or `taxonomy.yaml` — owned by Epic 11 (story 11.1) and Epic 4 (story 4.1).
- No port interfaces, DTOs, classification logic, or adapter implementations — stories 1.2/1.3 and later epics own those.
- No prettier, bundler, monorepo, Docker, CI pipeline, commit hooks, or Node version-pin file (`.nvmrc`/`mise.toml`) — not in the story AC, and the runtime decision was engines-only.
- Do not modify or restructure existing planning artifacts, `.agents/`, or `_bmad/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Smoke build | `bun run build` on the empty scaffold | `tsc -b` exits 0; emits `dist/core`, `dist/adapters`, `dist/cli` | n/a |
| Core boundary violation | `src/core/index.ts` imports `../adapters/...` | Build fails: the core project's `rootDir`/reference graph cannot resolve the import | Failure is the intended signal — do not add adapters to core's references or widen its `rootDir` to make it pass |
| Dependency install | `bun install` | `bun.lock` + `node_modules/`; native `better-sqlite3` / `keytar` built or prebuilt | Non-zero exit on native build failure: report the exact package and error. Do not drop the dependency or switch package manager |

</frozen-after-approval>

## Code Map

- `_bmad-output/planning-artifacts/architecture/architecture-email-agent-2025-01-15/ARCHITECTURE-SPINE.md` — authoritative **Structural Seed** (all code under `src/`, tsconfig files at repo root, `dist/` output), the **Stack** table with exact pins, AD-10 (dependency direction), AD-1 (pure core), naming conventions. Source of truth for the tree.
- `_bmad-output/planning-artifacts/epics.md` — Story 1.1 AC holds the exact dependency/dev-dependency list, the project-reference requirement, and the `tests/{core,adapters,orch}` mirror. Its directory list omits the `src/` prefix (shorthand) — the spine's explicit tree wins.
- `_bmad-output/implementation-artifacts/epic-1-context.md` — compiled epic context: the port/DTO expectations later stories hold this scaffold to, plus the `accountId` threading contract.
- `_bmad-output/implementation-artifacts/deferred-work.md` — the two spec entries carved off here (jest harness, eslint enforcement); implementation must not create those configs.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — this story's key is `1-1-project-initialization-dependencies`.
- `graft/INDEX.md` — the only graft node; no source is indexed yet, so there is nothing to reuse. Nothing else exists to reuse either: no `package.json`, `tsconfig*`, `src/`, `tests/`, or `node_modules`. `.gitignore` exists (ignores `/graft/`, `/.pi/`) and gains build-output entries.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` — create with name, `private: true`, `"type": "module"`, `engines` for the Node 20 LTS line, the pinned runtime + declared dev dependency sets, and scripts `build` (`tsc -b`) and `clean` (`tsc -b --clean`) — single source of the toolchain. No `lint`/`test` scripts (their configs are deferred).
- [x] `tsconfig.base.json` — shared `compilerOptions` only (`module`/`moduleResolution` `nodenext`, `target` ES2022, `strict`, `declaration`, `composite`, `sourceMap`, `esModuleInterop`) — the three project configs extend this, never the root, so the root's `references` cannot leak into a child.
- [x] `tsconfig.json` — the solution file: `files: []` plus `references` to core/adapters/cli, and no `compilerOptions` of its own — root of the project-reference graph that `tsc -b` picks up.
- [x] `tsconfig.core.json` — `extends` the base; composite: `include: ["src/core/**/*"]`, `rootDir: "src/core"`, `outDir: "dist/core"`, no references — core depends on nothing.
- [x] `tsconfig.adapters.json` — `extends` the base; composite: `include: ["src/adapters/**/*", "src/orch/**/*"]`, `rootDir: "src"`, `outDir: "dist"`, `references` core — adapters depend on core ports only.
- [x] `tsconfig.cli.json` — `extends` the base; composite: `include: ["src/cli/**/*"]`, `rootDir: "src/cli"`, `outDir: "dist/cli"`, `references` core + adapters — cli wires everything.
- [x] `src/core/index.ts`, `src/adapters/index.ts`, `src/cli/index.ts` — empty barrels (`export {};`) so each composite project has at least one input and `tsc -b` succeeds on the empty core.
- [x] `src/core/{ports,dto,skill}/.gitkeep`, `src/adapters/{m365,gmail,model,token,idempotency,scheduler,logger,config}/.gitkeep`, `src/cli/{commands,di}/.gitkeep`, `src/orch/.gitkeep`, `tests/{core,adapters,orch}/.gitkeep` — track the empty directories that later stories fill.
- [x] `.gitignore` — add `node_modules/`, `dist/`, `coverage/` (keep existing `/graft/`, `/.pi/`) — keep build output untracked.

**Acceptance Criteria:**
- Given a fresh clone, when `bun install` completes, then every runtime and dev dependency named in the story AC is present in `package.json` and `bun.lock`, and `node_modules/` is populated.
- Given the scaffold, when `bun run build` runs, then `tsc -b` exits 0 and emits `dist/core`, `dist/adapters`, and `dist/cli`.
- Given a file in `src/core` that imports an adapters path, when `bun run build` runs, then the build fails rather than resolving the import.
- Given `git ls-files src tests`, then every directory named in the story AC appears under `src/` and `tests/`.
- Given `package.json`, when inspected, then `engines.node` declares the Node 20 LTS line and `type` is `module`.
- Given the scaffold, when `bun run build` runs twice, then the second run is a no-op (incremental build is happy).

## Implementation Notes

- 2026-10-08 — `pino-roll` frozen pin `1.11.x` does not exist on npm (the published 1.x line ends at `1.3.0`; latest is `4.0.0`). Human decision: use `"pino-roll": "~2.2.0"` — the first pino-roll line built for `pino` 9's `sonic-boom` 4, so it aligns with the pinned `pino` 9.2.x.
- 2026-10-08 — `bun install` cannot finish the native build of pinned `better-sqlite3` 9.6.0 on this machine's Node 26.8.2: no matching prebuilt binary exists, and the C++ source fails to compile against Node 26's V8 headers (`v8::String::Utf8Value` and `v8::Object::Get` signature changes), exit 1. Per the I/O matrix the dependency stays declared and unchanged (not dropped, package manager unchanged); the failure is reported. `keytar` 7.9.0 built successfully, and `tsc -b` is unaffected by the missing native module.
- 2026-10-08 — AC 1 confirmed unmet at that point, not merely a noisy install: `build/Release/better_sqlite3.node` was never produced, `new Database(':memory:')` threw `Could not locate the bindings file` (tried `node-v147-linux-x64`), and a plain `bun install` re-run exited 0 *without* repairing it, so the failure did not self-heal on a fresh clone.
- 2026-10-08 — Human decision: pin the runtime with `mise.toml` (`[tools] node = "20"`, resolved 20.20.2). This supersedes the frozen Never item "no Node version-pin file (`.nvmrc`/`mise.toml`)"; the earlier engines-only decision is retained in `package.json` (`engines.node: ">=20 <21"`).
- 2026-10-08 — Re-verified under Node 20 after the pin, from scratch (`rm -rf node_modules` then `bun install`): exit 0, 473 packages, `better_sqlite3.node` present, `new Database(':memory:')` runs a real create/insert/select, `keytar` loads. `bun run build` exit 0 (emits `dist/core`, `dist/adapters`, `dist/cli`), second build is a no-op, the core→adapters negative check still fails correctly (`TS6059` + `TS6307`) and reverts clean.
- 2026-10-08 — Mass dependency update to latest stable versions by direct command, superseding many of the original Stack pins. Pins moved: `@microsoft/microsoft-graph-types` 2.43.0 → 2.43.1, `commander` 12 → 15.0.0, `js-yaml` 4.3.2 → 5.4.3, `pino` 9.2.0 → 10.4.0, `pino-roll` 2.2.0 → 4.0.0, `zod` 3.23.8 → 4.6.5; dev: `@types/better-sqlite3` 7.6.13 → 9.6.0, `@types/jest` 29.5.12 → 30.0.0, `@types/js-yaml` 4.0.9 → 4.0.9, `@types/keytar` 4.4.2 → 4.4.2, `@types/node` 20.0.0 → 20.19.43, `@typescript-eslint/*` 7.18.0 → 8.71.1, `eslint` 8.57.0 → 10.12.0, `jest` 29.7.0 → 30.5.2, `ts-jest` 29.2.0 → 29.4.14, `typescript` 5.5.4 → 7.0.2. `better-sqlite3` was held at 9.6.0 because 12.x/13.x require `node-gyp` (not on PATH in this environment) and fail install. `bun install` now exits 0, `bun run build` exits 0, `better-sqlite3` and `keytar` are functional under Node 20. Only remaining audit item is the dev-only `sprintf-js` advisory with no patched release. The frozen Stack pins now deviate on many lines — they need your edit if you want them to match the shipped tree.
- 2026-10-08 — Audit triage of the advisories surfaced during review, superseding the first attempt at a fix. `sprintf-js@1.0.3` (medium, GHSA-hp3w-g68c-fv3c) is dev-only — reached solely through `jest → @istanbuljs/load-nyc-config → js-yaml@3.15.2 → argparse@1.0.10` — and has **no patched release at all** (vulnerable `<= 1.1.3`, patched: None), so an `overrides` pin only moved 1.0.3 → 1.1.3 without clearing the advisory; it was reverted rather than left in place as false assurance. The real exposure was `js-yaml`, a **direct production** dependency: the pinned `~4.1.0` (resolved 4.1.1) carried one moderate and three high DoS advisories (GHSA-h67p-54hq-rp68, -52cp-r559-cp3m, -5p4m-2wfm-xmqj, -2883-xcg3-v3hh), all patched in 4.3.2, so the pin moved to `^4.3.2` within major 4. The nested `js-yaml@3.15.2` was already at its patched version and was left alone.

## Spec Change Log

## Review Triage Log

Verdicts rendered on the diff at `/tmp/bmad-1-1-review-1791416927.diff` (baseline `82083ae`).

| Finding (location) | Verdict | Evidence and route |
|---|---|---|
| BH-1 + BH-2 + EC-1 — frozen block contradicts the shipped tree: `spec:24`/`:41` say "engines only … No version-pin file" while `mise.toml` exists; `spec:31` pins `pino-roll` 1.11.x while `package.json` carries `~2.2.0` | medium | Verified at all cited lines; both contradictions are real and a reader of the frozen `Intent` would not learn the Node-20 pin. **Rejected as a fix**: the only remedy edits the frozen block, which this step rejects and only the human can change. Both deviations are already recorded in Implementation Notes (`:86`, `:89`); the human may renegotiate the frozen block. |
| BH-3 — `## Spec Change Log` is empty | false | It is populated by step-04 only on a `bad_spec` loopback, and none has occurred; empty is the section's contract at this point, not a defect. |
| BH-4 — nonexistent `pino-roll` 1.11.x propagated to `epic-1-context.md:34` and the architecture spine `:149`, so story 10-1 would target an uninstallable version | medium | Verified: both files carry 1.11.x. Root cause is upstream in a planning artifact this story must not modify; the downstream copy is agent context. |
| BH-5 + BH-6 — `epic-1-context.md` stale against the approved decisions: omits bun, ESM/`nodenext`, the `.js`-extension rule, the mise pin and the `dist/` layout, while still listing `.eslintrc.json`, `config.yaml.example` and `taxonomy.yaml` as Epic-1 deliverables | low | Verified: the compiled context predates the three decisions and the split. Fix edits an agent-context file. |
| BH-7 — the two carved-off specs have no key or deferred marker in `sprint-status.yaml` | low | The deferred-work ledger is the split mechanism's mandated tracking surface; adding keys to generated status duplicates it. Rejected on the low rule — the fix is more than a direct correction. |
| BH-8 — deferred-work entries lack id/date/owner/status/target-spec metadata | false | The three-field `source_spec`/`summary`/`evidence` format is dictated by the workflow's split step; extra fields are not part of the contract. |
| VG-1 + BH-9 — no persistent automated guard for the core→adapters boundary, and nothing type-checks `tests/`; the only proof is a transient manual mutation check | medium | Verification-gap layer pre-verified by repo-wide search: no `*.test.*`/`*.spec.*`, no jest/vitest config, no CI workflow, no `lint`/`test` scripts, and no tsconfig includes `tests/`. Filed disposition `defer`. |
| BH-10 — no `packageManager` pin, so the toolchain is unreproducible while `bun.lock` is committed | low | Verified absent; installed bun is 1.4.2. Smallest fix is a direct correction with no new surface. |
| BH-11 — no README/setup note for the now-mandatory `mise install` → `bun install` → build chain | low | Verified no README. Rejected on the low rule: a mise-active shell already auto-selects Node 20 through the shim (verified: shim reports v20.20.2), so the everyday path works and a non-mise developer fails loudly rather than silently; a README is a new artifact, more than a direct correction. |
| BH-12 — the real `config.yaml` and `.env` are not gitignored although `config.yaml` will hold account names and `tokenFallback.passphraseEnvVar`, and `.env` likely API keys | medium | Verified absent from `.gitignore`. Trivial direct correction on a secrets path. |
| BH-13 — `tsconfig.base.json` leaves the strictness policy unset (`noUnusedLocals`, `noUncheckedIndexedAccess`, `isolatedModules`/`verbatimModuleSyntax`, `skipLibCheck`) | low | Rejected on the low rule: adding compiler flags imposes new constraints on all future code, so it is a policy change rather than a direct correction. |
| BH-14 — the 3-row I/O matrix does not cover 3 of the 6 ACs, nor the runtime mismatch that actually occurred | low | The matrix is a frozen, human-approved artifact and the runtime row was deliberately trimmed at the token gate; a matrix is not required to mirror every AC. Fix edits the frozen block. |
| BH-15 — recorded state and verification evidence "lag": `status` was `in-progress`, `## Verification` states only expected outcomes, no `updated` field | false | The `COMMAND — expected: SUCCESS_CRITERIA` shape is the template's own contract, and the observed exit codes and outputs are recorded in Implementation Notes (`:87`–`:92`); the `in-review` transition is this step's own action and has been applied; the template defines no `updated` field. |
| BH-16 — `graft build` was never run after the scaffold landed, though `AGENTS.md` requires it after big code changes | low | Verified: `graft/` holds only `INDEX.md` while `src/**`, the tsconfigs and `package.json` now exist. Direct action whose output is regenerable and gitignored. |

Loopback check: no `intent_gap` or `bad_spec` entry survived triage, so there is no loopback and `review_loop_iteration` stays at 0. Patches dispatched to the step-03 implementation subagent: BH-10, BH-12, BH-16. Deferred: BH-4, BH-5+BH-6, VG-1+BH-9.

## Design Notes

- **A `tsconfig.base.json` is why the children do not extend the root.** `extends` carries over everything except `files`/`include`/`exclude`, so a child extending the root would inherit its `references` — giving `core` a reference to `adapters` and making the graph circular (`tsc -b` rejects circular reference graphs). Shared compiler options live in the base; references are declared per child.
- **`src/` prefix is deliberate.** The architecture spine's Structural Seed is the authoritative tree: code under `src/`, `tsconfig.{core,adapters,cli}.json` at repo root, `dist/` output. `epics.md` lists the same directories without the prefix as shorthand. If the flat layout was actually intended, this is the one place the whole scaffold would need reshaping.
- **`src/orch` rides in the adapters project** (it depends on core ports, like adapters) instead of a fourth `tsconfig.orch.json`; the AC enumerates exactly three projects. Its `rootDir` stays `src` so output lands in `dist/adapters` and `dist/orch`. Split it out when orch gains its own dependency surface.
- **ESM under TypeScript 5.5 uses `nodenext`** — `node20` as a `module` value did not exist yet, so naming it here would produce an invalid config. Relative imports need explicit `.js` extensions as real files land.
- **Deferred configs are why there is no `lint` or `test` script.** Their dev dependencies are still installed so the follow-up specs touch only their own files, not `package.json`.
- **`age-encryption` is the real npm package** (the AC writes it as `age`), and the placeholder barrels are seed-listed files (`core/index.ts` = "barrels core exports"), not scaffolding invented for this story.

## Verification

**Commands:**
- `bun install` — expected: exit 0, `bun.lock` created
- `bun run build` — expected: exit 0, `dist/core`, `dist/adapters`, `dist/cli` populated
- `git ls-files src tests` — expected: the three barrels plus `.gitkeep` files across every AC directory

**Manual checks (if no CLI):**
- `ls -R src tests` matches the story AC tree exactly — no extra or missing directories.
- Temporary negative check: add `import '../adapters/index.js';` to `src/core/index.ts`, run `bun run build` — expect a build failure, then revert the line.
