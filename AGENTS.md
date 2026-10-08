<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->

<!-- bmad:context -->
<!-- Verified 2026-10-08 against cc52ce2c32ac2244643a6d5c38f1033efb5a6191. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## email-classify

Multi-account email triage/classification CLI: fetches mail, classifies it via an LLM, writes labels back. TypeScript 7 on Node 20 (mise-pinned, bun, ESM `nodenext`), hexagonal — pure `core` ← `adapters`/`orch` ← `cli`. Driven by the bmad story workflow; planning and per-story specs live under `_bmad-output/`.

## Policy

- `_bmad-output/**`, `_bmad/**`, and `.agents/**` are human-owned — never edit them without explicit authorization. Story specs carry `<frozen-after-approval>` blocks: edit only when the human renegotiates.

## Where things are

- Code: `src/core` (ports/dto/skill — zero deps), `src/adapters` + `src/orch` (depend on core), `src/cli` (wires all); tests mirror in `tests/{core,adapters,orch}`.
- Architecture spine (authoritative tree + ADRs): `_bmad-output/planning-artifacts/architecture/*/ARCHITECTURE-SPINE.md`.
- Before a story: read its spec and the epic context it names under `_bmad-output/implementation-artifacts/`; check `deferred-work.md` for open items.
- Worked examples: `docs/`.

## Running and verifying

- Run under the mise-pinned Node 20 (e.g. `mise exec node@20 -- bun run …`): the bare `node` is 26.8.2, and `bun install` on it fails to build `better-sqlite3`.
- `bun run build` (`tsc -b`) and `bun run lint` (oxlint) both enforce the AD-10 dependency direction; `package.json` scripts cover the exact invocations.
- `tests/` is not type-checked by any tsconfig — vitest strips types without checking them.
- `vitest` declares a Node 22.12 floor but runs green on 20.20.2; don't "fix" the runtime pin over it.

## Conventions that differ from defaults

- ESM `nodenext`: relative imports carry explicit `.js` extensions.
- AD-10 direction: `core/` imports nothing; `adapters`/`orch` reach `core` only; `cli` wires all. Don't widen `core`'s `rootDir` or add project references to make a bad import compile.
- kebab-case files/dirs, `PascalCase` types, `*Port`/`*Adapter`/`*DTO` suffixes.

## Known pitfalls

- Per-adapter tests (`tests/adapters/**`) use stdlib-only mocks — never import a real adapter SDK (oxlint-enforced).
- `package.json` is the toolchain source of truth; the architecture spine's Stack table once drifted from it (corrected 2026-10-08).

<!-- /bmad:context -->
