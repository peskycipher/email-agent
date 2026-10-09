---
title: 'Testable CLI entry point'
type: 'refactor'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: '32af2cc4100a3d499f6d1d89a8aecf43a16ff633'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-email-agent-2025-01-15/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `src/cli/index.ts` builds its commander program and calls `parseAsync(process.argv)` at module top level, so nothing can import it. Every flag→action handoff added since Story 5.1 is therefore manual-check only: a renamed flag, a dropped `.option`, a misrouted `command.kind`, or a wrong `--account` pass-through keeps `bun run build|lint|test` green while the command silently acts on the wrong accounts. Six deferred-work entries (Stories 5.1/5.2/5.3) and the epic-4/5 retros record this same gap.

**Approach:** Extract a side-effect-free program builder plus injectable command handlers into `src/cli/main.ts` (`createProgram`, `defaultHandlers`, `runCli`), leave `src/cli/index.ts` at its current path as the thin executable, and add `tests/cli/main.test.ts` pinning the flag definitions, every `CliCommand` → handler mapping (including the `--account` pass-through and the `--source` default) and the exit-code mapping. No user-visible behaviour changes.

## Boundaries & Constraints

**Always:** Keep `src/cli/index.ts` as the shipped executable — `dist/cli/index.js` must keep working. `resolveCliCommand` in `dispatch.ts` stays the only routing authority; the action body must not re-implement routing. Flag names, descriptions, examples, error messages and exit codes stay byte-identical. AD-10 unchanged (`cli/` imports core and adapters). Importing the builder must not parse argv, write output, run a command, or call `process.exit`.

**Never:** No `package.json` `bin`/`files` fields and no e2e spawn test (Epic 11.3's story). No refactor of `commands/**` — their headers declare them replaced wholesale by Epic 11's DI container. No `tests/` tsconfig or `bun run typecheck` widening (a separate deferred item). No change to CLI behaviour, messages or exit codes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| AUTH | `--auth gmail --account work` | `runAuth({ provider: "gmail", account: "work" })`, exit 0 | n/a |
| SYNC default account | `--sync-categories` | `runSyncCategories({ account: "all" })`, exit 0 | n/a |
| BACKFILL default source | `--backfill --account all` | `runBackfill({ source: "m365", account: "all" })`, exit 0 | n/a |
| CRON account pass-through | `--cron --source gmail --account work` | `runCron({ source: "gmail", account: "work" })` — the Story 5.2 regression — exit 0 | n/a |
| NON-ZERO handler | any route, handler resolves `2` | exit code 2 | n/a |
| ROUTING ERROR | `--backfill --source all` | stderr line, exit 1, no handler called | handled, not thrown |
| CONFLICT | `--auth m365 --account work --sync-categories` | stderr line, exit 1, no handler called | handled, not thrown |
| IMPORT SIDE EFFECT | `import` of the builder module | no output, no command run, no `process.exit` | n/a |

</frozen-after-approval>

## Code Map

- `src/cli/index.ts` (74 lines) — the untestable entry. Builds `new Command()`, declares the 6 options + the `addHelpText` examples, routes inside `.action()` on `resolveCliCommand(options)` to the four `run*` functions, then `await program.parseAsync(process.argv)` at line 74. Builder moves out; the path stays.
- `src/cli/dispatch.ts:6-20,72` — `CliOptions`, the `CliCommand` union, `resolveCliCommand`: pure and already covered by `tests/cli/dispatch.test.ts`. Reuse as-is.
- `src/cli/commands/auth.ts:192` `runAuth(options, runtime = {})`, `commands/backfill.ts:77` `runBackfill`, `commands/cron.ts:89` `runCron`, `commands/sync-categories.ts:111` `runSyncCategories` — each returns `Promise<number>`; the entry supplies these as the default handlers.
- `tests/cli/dispatch.test.ts:1-2` — import idiom to copy: `import { expect, test } from "vitest"` plus `../../src/cli/….js`, explicit `.js` extension (ESM `nodenext`).
- `tests/cli/auth.test.ts:86,101-102` — the established way to pin process output: `vi.spyOn(process.stderr, "write").mockReturnValue(true)`, restored in `afterEach`. Reuse it for the error rows rather than inventing a harness.
- `tsconfig.cli.json` — `rootDir: src/cli`, `include: ["src/cli/**/*"]`; a new `src/cli/main.ts` needs no config change and `dist/cli/index.js` stays the emitted entry.
- `package.json` — no `bin`/`files` today; `lint` = `oxlint`, `test` = `vitest run && bun run typecheck`.

## Tasks & Acceptance

**Execution:**
- [x] `src/cli/main.ts` (new) — export `CliHandlers` (one member per `run*`), `createProgram(handlers)` returning the fully configured `Command` with the option/example block moved verbatim, `defaultHandlers` wiring the four real imports, and `runCli(argv, handlers)`. Keep the module import-side-effect-free; the action body keeps routing through `resolveCliCommand` and reports failures on stderr. — Gives the entry point an importable seam without moving the shipped path, and matches the `main.ts` the spine's structural seed and every command header already name.
- [x] `src/cli/index.ts` — reduce to the executable: call `runCli(process.argv, defaultHandlers)` and propagate its result to `process.exitCode` (the observable contract, unchanged from today). — Preserves `dist/cli/index.js` as the entry and leaves all routing in one tested place.
- [x] `tests/cli/main.test.ts` (new) — one test per I/O matrix row, asserting handler call arguments, the exit code, and that a routing error calls no handler; assert `defaultHandlers` members are identity-equal to the real imported `run*` functions; assert the builder module's import is silent. — This is the pin the deferred entries ask for; the identity assertions are what stop a future edit from rewiring the entry to the wrong function.

**Acceptance Criteria:**
- Given the new seam, when `bun run test` runs under the mise-pinned Node 20, then `tests/cli/main.test.ts` asserts every I/O matrix row and the whole suite passes, and `bun run typecheck` stays green.
- Given the action body is deliberately misrouted (e.g. the `cron` branch calling `runBackfill`), when `bun run test` runs, then the new suite fails — the mutation check proving the tests have teeth.
- Given `bun run build`, when `node dist/cli/index.js --help` runs, then its output is byte-identical to the pre-change capture.
- Given `bun run lint`, when it runs, then it exits 0 with no new rules or overrides.

## Implementation Notes

- 2026-10-09 (planning): human approved keeping the full spec at 2153 tokens (cl100k_base), above the 900–1600 guidance. One indivisible goal, so no split was available; the excess is implementer grounding, not padding. Approved with the risk accepted.
- 2026-10-09 (implementation): `src/cli/main.ts` (new, 91 lines) holds `CliHandlers`, `createProgram`, `defaultHandlers`, `runCli`; `src/cli/index.ts` is now the two-line executable at its original path. `tests/cli/main.test.ts` (new, 145 lines) adds 10 tests — one per I/O matrix row, plus flag/example pinning and `defaultHandlers` identity. `CliHandlers` deliberately omits the commands' optional `runtime` parameter: a handler is only ever called with its command options from the entry point.
- Behaviour note: `runCli` resets `process.exitCode` to `0` before parsing and returns it. The externally observable contract is unchanged (help is byte-identical, error paths still exit 1), but the reset makes the code deterministic for repeat callers — a test process, or a future in-process loop.
- Verified 2026-10-09 by the orchestrator against the diff: `bun run test` 23 files / 392 tests green plus `tsc --noEmit`; `bun run lint` exit 0; `bun run build` then `node dist/cli/index.js --help` byte-identical to the pre-change capture (`diff` clean, empty stderr); `node dist/cli/index.js --nope` exits 1; mutation check (cron branch rewired to `runBackfill`) fails 2 tests, then reverted and re-run green.
- 2026-10-09 (review): step-04 triage ran all three layers and applied three patches — deleted the redundant `as string[]` cast in `runCli`; documented on `runCli` that commander's `--help`/`--version`/unknown-option paths call `process.exit` inside `parseAsync` and therefore do not return a code; and strengthened the help-pin test to assert the program name/description, all six option descriptions and the complete twelve-line examples block (mutation-checked — a one-word description change fails it). All three re-verified. The single deferred finding — `src/cli/index.ts`'s own wiring is unreachable by any in-repo test — was appended to `_bmad-output/implementation-artifacts/deferred-work.md`.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Route | Evidence |
|---|-----------------|---------|-------|----------|
| 1 | `runCli` returns a process-global, so it "races under concurrent/re-entrant calls" (blind hunter) | `false` | — | The reset at entry makes sequential repeat callers deterministic, and the value is the process's own exit code, which `src/cli/index.ts:3` assigns regardless. No concurrent caller exists — `runCli` is referenced only by `index.ts` and the new test. |
| 2 | `runCli` clobbers `process.exitCode` and never restores it (blind hunter) | `false` | — | Same refutation: the value left behind is exactly the one `src/cli/index.ts:3` immediately assigns, the next call resets it to `0`, and every test restores it in `afterEach`. No caller can observe a stale value. |
| 3 | The `as string[]` cast on `argv` is unnecessary and discards the readonly guarantee (blind hunter) | `low` | patch | Verified: `node_modules/commander/typings/index.d.ts:840` declares `argv?: readonly string[]`, so the cast is redundant. Cast deleted. |
| 4 | The help-pinning test checks only `option.long` plus one of twelve example lines (blind hunter) | `medium` | patch | Verified by reading `tests/cli/main.test.ts` before the patch. Fixed: the test now asserts the program name/description, all six option descriptions and the complete twelve-line examples block; a one-word description change fails it (mutation-checked). |
| 5 | The seam does not pin the other `resolveCliCommand` error branches (blind hunter) | `false` | — | Every branch named is already pinned in `tests/cli/dispatch.test.ts` (`:86` `--source` alone, `:30`/`:37` missing flags, `:79`/`:142` unknown source, `:23`/`:93`/`:100`/`:149`/`:156`/`:163` conflicts), so the described "green while misrouting" regression cannot occur. The seam's stderr + exit 1 + no-handler shape is pinned once by the ROUTING ERROR row. |
| 6 | `--cron`'s `--source` default (`m365`) is never pinned at the seam (blind hunter) | `false` | — | Pinned at the resolver by `tests/cli/dispatch.test.ts:107` ("--cron without --source defaults to m365"); the seam passes `command.source` straight through, pinned with `gmail` by the CRON row. |
| 7 | The IMPORT SIDE EFFECT test re-evaluates transitive adapter modules (blind hunter) | `low` | — | Rejected. The extra assertion is not wrong — a transitive import that wrote at import time *would* be a defect worth failing on — and the proposed fix (mocking the command modules) adds complexity for a hypothetical future. |
| 8 | `--help`/unknown-option call `process.exit` inside `parseAsync`, so `runCli`'s return contract is unreachable on those paths (blind hunter) | `low` | patch | Verified in `node_modules/commander/lib/command.js` `_exit`: `process.exit(exitCode)` runs when `_exitCallback` is null. Fixed by documenting the contract on `runCli`; adding `exitOverride` would change shipped CLI behaviour and is out of bounds. |
| 9 | `CliHandlers` drops the commands' optional `runtime` parameter, so the seam is only half-testable (blind hunter) | `false` | — | Not a defect: the limitation is the spec's own recorded, human-approved bound (frozen Boundary "no e2e spawn test"; Design Notes residual). Nothing beyond it is claimed. |
| 10 | A non-number handler result is silently coerced to exit `0` (blind hunter) | `low` | — | Rejected. Unreachable today — `tsc` enforces `Promise<number>` and all four handlers return numbers — and the proposed fix adds a branch guarding a state never demonstrated. |
| 11 | The action body's final branch is an implicit `else` assuming `auth` (blind hunter) | `false` | — | TypeScript narrows the remaining variant to `{ kind: "auth" }`, so adding a `CliCommand` variant makes `command.provider` a compile error under `bun run build`, not a silent misroute. |
| 12 | No `exitOverride`, so commander's `process.exit()` terminates the host instead of returning a code (edge case hunter) | `low` | patch | Same root cause and same fix as row 8. |
| 13 | The `src/cli/index.ts` wiring (`process.argv` + `defaultHandlers` into `runCli`) is unpinned — `process.argv.slice(2)` keeps build/lint/test green (verification gap) | `medium` | defer | Pre-verified gap; demonstration confirmed — no test imports `index.ts`, and `grep "cli/index"` finds only docs and graft cards. Deferred: the frozen Boundaries exclude an e2e spawn test, and no in-repo test can import `index.ts` without triggering `parseAsync`. |
| 14 | Help descriptions and eleven of twelve example lines are only manually verified (verification gap) | `medium` | patch | Same root cause as row 4; folded into the row-4 fix. |

Layers: blind hunter, edge-case hunter and verification gap all ran; none skipped. No `intent_gap` or `bad_spec` entries — `review_loop_iteration` stays `0`.

## Design Notes

Seam shape (illustrative — the implementer owns the details):

```ts
export interface CliHandlers {
  runAuth: (o: { provider: string; account: string }) => Promise<number>;
  runSyncCategories: (o: { account: string }) => Promise<number>;
  // …runBackfill, runCron with { source: "m365" | "gmail"; account: string }
}
export function createProgram(handlers: CliHandlers): Command
export const defaultHandlers: CliHandlers
export async function runCli(argv: readonly string[], handlers: CliHandlers): Promise<number>
```

Handler injection over `vi.mock` of the command modules: this repo has no `vi.mock` usage, ESM + `nodenext` module mocking is fragile, and the four command modules are already proven importable by `tests/cli/{auth,cron}.test.ts`. Residual, accepted: the two-line call in `index.ts` is still not importable, so the final wiring rests on the `defaultHandlers` identity assertions plus the byte-identical `--help` check.

## Verification

**Commands:**
- `mise exec node@20 -- bun run test` — expected: `vitest run` green including `tests/cli/main.test.ts`, then `tsc --noEmit` green.
- `mise exec node@20 -- bun run build` then `mise exec node@20 -- node dist/cli/index.js --help` — expected: byte-identical to the capture taken before the first edit (save it before touching `src/cli/index.ts`).
- `mise exec node@20 -- bun run lint` — expected: exit 0.
- Mutation check: temporarily change the `cron` branch to call `runBackfill`; `bun run test` must fail; revert.

**Manual check:** `node dist/cli/index.js --nope` still exits 1 with commander's unknown-option error.
