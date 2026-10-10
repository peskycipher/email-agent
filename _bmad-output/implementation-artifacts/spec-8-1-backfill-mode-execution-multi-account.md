---
title: 'Story 8.1: Backfill Mode Execution (Multi-Account)'
type: 'feature'
created: '2026-10-10'
status: 'done'
route: 'dispatch'
baseline_commit: '6ecfa24c5d5a9af36106cbeab8dd529dda2fc518'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every stage of the product exists but nothing runs them together. `--backfill` currently fetches messages and throws them away — its own help text says "nothing is written back" — so the classifier (Epic 6) and both providers' `writeLabels` (Epic 7) have no production caller. A user cannot yet get their existing mail classified and labelled.

**Approach:** Turn `--backfill` into the product's first real run: for each selected account, in sequence, fetch its messages, classify each against the active taxonomy, and write the resulting labels back through `MailPort.writeLabels`. Stage the loop as a new pure orchestration module that composes the existing `orch/fetch` and `orch/classify` units rather than reimplementing them, and give the command the taxonomy, model and per-account progress reporting it needs to drive that loop.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | One enabled account, 3 fetched messages | Each message is classified and its labels written; per-account counts report 3 processed | N/A |
| EMPTY_ACCOUNT | Account lists cleanly, fetch returns nothing | Account reports 0 processed; no classification or write call; run still succeeds | N/A |
| EMPTY_LABEL_SET | Classifier returns `{ labels: [] }` | No `writeLabels` call for that message; counted as processed, not labeled | N/A |
| ONE_ACCOUNT_FAILS | Two accounts; the first's fetch throws | Failure logged naming that account; the second account is still fetched, classified and written | Isolated; run exits non-zero |
| MESSAGE_WRITE_FAILS | `writeLabels` throws for one message | Error logged naming the account and message; the account's remaining messages continue | Isolated; counted as an error |
| CLASSIFY_REJECTS | Transport rejection from the model | Error logged naming the account; remaining messages for that account continue | Isolated; counted as an error |
| NO_ACCOUNTS | Selection matches nothing | Existing "no enabled accounts" hint and exit code 1 | N/A |
| BOTH_STAGES_REPORT | Any run | A fetch failure is not double-counted as a classification failure | N/A |

## Decisions (human, 2026-10-10)

- **`--source all` is Story 8.3's, not 8.1's.** The epic's 8.1 AC lists `|all`, but the 2026-10-09 decision recorded at `src/cli/dispatch.ts:36` ("`all` is not a provider") stands: 8.1 keeps the two-provider guard, and the cross-provider loop lands once, in 8.3. The epic text is reconciled when 8.3 lands — not by widening 8.1.
- **The CLI owns the `ModelConfig` and passes it in.** `src/cli/commands/backfill.ts` resolves the model config and hands it to the orchestrator; no new config surface is added and `src/orch` stays free of `adapters/model` (AD-10). Until Epic 11 owns real model settings, the resolution falls back to the ratified `DEFAULT_MODEL_CONFIG` when none is configured.
- **"skipped" counts empty label sets.** A message the classifier gives no labels is processed-and-skipped; the four per-account counters partition as `processed = labeled + skipped`, plus `errors` counted separately.

</frozen-after-approval>

## Code Map

- `src/orch/fetch.ts:37` — `fetchAllMessages(options)`: the existing per-account, per-folder fetch loop with isolation; **reuse as-is**, do not fold classification into it.
- `src/orch/classify.ts:16` — `ClassifyOptions`; `classify(options)` is the one-message unit (`message`, `taxonomy`, `model`, `config`, `logPort`, `context`) — the loop calls this per message.
- `src/orch/sync.ts:4` — `CategorySyncTarget`: the minimal structural port seam idiom to copy for a `writeLabels` seam.
- `src/core/ports/MailPort.ts:1` — `MailPort`; the loop must need only `fetchMessages` + `writeLabels`, not the whole port.
- `src/adapters/config/taxonomy.ts:81` — `loadTaxonomy({ taxonomyPath?, configDir? })`: the CLI loads and freezes the taxonomy before the run (mirrors `sync-categories.ts:105`).
- `src/adapters/model/modelAdapterFactory.ts:36` — `ModelAdapterDeps`; `createModelAdapter(config, deps)` at `:99` and `defaultModelClientFactories` at `:130` are the wiring seam. **`orch`/`core` must not import this file** (AD-10).
- `src/cli/commands/backfill.ts:69` — `runBackfill`: currently lists → `fetchAllMessages` → prints counts. This is the file that changes most; `planFor`/`port` per provider are already there.
- `src/cli/commands/sync-categories.ts:53` — `createConsoleLogPort()`; the temporary `LogPort` the backfill already reuses (Epic 10 owns the real one).
- `src/cli/dispatch.ts:26` — `resolveBackfill`: the `--since`/`--batch-size` flags are parsed here (it already owns source/account validation); `:36` is the `--source all` guard under question.
- `src/cli/main.ts:34` — `createProgram(handlers)`: the option table lives here.
- `src/cli/index.ts:1` — the commander entry point; the help text at `src/cli/index.ts:13-40` is user-facing and promises "nothing is written back".
- `tests/adapters/gmail/gmail-label-write.test.ts:1`, `tests/orch/*` — the test idioms to mirror (scripted fetch, recording log port, temp config).
- **Out of bounds:** `src/core/**` (AD-10 — no new core types needed), the idempotency store and process lock (Story 8.2), the interval loop (Story 8.3), the real logger/metrics (Epic 10), and the DI container (Epic 11).

## Tasks & Acceptance

**Execution:**
- [x] `src/orch/classification-run.ts` — new loop: per account, per folder fetch with the shared defaults, classify each message via `classify`, write via a minimal `LabelWriteTarget` seam, accumulate the counters, isolate per-account and per-message failures, and log per-account progress — the story's whole behaviour, kept out of the CLI so it is testable without booting one.
- [x] `src/cli/commands/backfill.ts` — load the taxonomy and model, build the model adapter, drive the new loop instead of `fetchAllMessages`, and thread `--since`/`--batch-size` into each account's plan — the wiring.
- [x] `src/cli/dispatch.ts` + `src/cli/main.ts` — accept and validate `--since <date>` and `--batch-size <n>` for `--backfill` — the flags the AC names.
- [x] `src/cli/main.ts` (the `addHelpText` block) — update the `--backfill` help text and examples, which promised "nothing is written back" — the promise it makes is now false.
- [x] `tests/orch/classification-run.test.ts` — pin every row of the I/O matrix, including two-account isolation and the empty-label-set no-write case — the ACs are only real if tested.
- [x] `tests/cli/backfill.test.ts` — the existing CLI suite now supplies a model double and scripted write responses, and asserts the new progress lines — the command's own path must stay covered.

**Acceptance Criteria:**
- Given a Gmail account with fetched messages and a working model, when `--backfill --source gmail --account <name>` runs, then each message is classified and its labels are written back through `MailPort.writeLabels` with that message's id.
- Given two accounts where the first fails to fetch, when the backfill runs, then the failure is logged naming the first account and the second account is still processed to completion.
- Given a classifier result of `{ labels: [] }`, when the message is processed, then no `writeLabels` call is made for it.
- Given `--batch-size` is passed, when fetching, then the value is applied per account and clamped to the provider's maximum.
- Given `--since <date>` is passed, when fetching, then only messages received after that date are fetched, per account.

## Implementation Notes

- **As-built shape.** `src/orch/classification-run.ts` owns the loop. It fetches each account's folders itself (with `fetch.ts`'s exported `DEFAULT_FOLDERS`/`DEFAULT_BATCH_SIZE`) rather than calling `fetchAllMessages`, because that unit counts messages but does not return them — the loop needs the array. Folder isolation is preserved (one folder's failure logs and the account's other folders still walk), and a folder failure marks the account failed so its partial fetch is never reported as clean.
- **AD-10 held.** The new module imports only `core` types plus sibling `orch` units. `createModelAdapter` and `DEFAULT_MODEL_CONFIG` are reached from `src/cli/commands/backfill.ts` only.
- **Decision 1 (`--source all`).** `dispatch.ts` keeps its guard unchanged; the epic text stays unreconciled until Story 8.3.
- **Decision 2 (model config).** `BackfillRuntime` gained `modelConfig` and `model`; the `modelConfig` default is `DEFAULT_MODEL_CONFIG` so a run works out of the box off `TYPESAFE_API_KEY`.
- **Decision 3 (skipped).** An empty `LabelSet` increments `skipped` and returns before any write; `processed = labeled + skipped` is pinned by the `COUNTERS` test.
- **Exit code.** `runBackfill` returns non-zero when any account failed **or** any message errored — a run that classified nothing because writes all failed must not read as success.
- **Write-back is unreachable without a prior sync.** The CLI tests revealed this: a Gmail `writeLabels` with no cached label map raises the frozen `WRITE_LABELS_FAILED` typed error (Story 7.2's `UNCACHED_ACCOUNT` row). Two Gmail CLI tests therefore assert `0 labeled, N error(s)` rather than a successful write. This is correct behaviour, not a defect — but it means **`--backfill` must be preceded by `--sync-categories`** for labels to actually land, which is worth stating in help text (Epic 11's command surface).
- **Pre-existing test expectations updated, nothing weakened.** `tests/cli/backfill.test.ts` and `tests/cli/main.test.ts` asserted the old per-account "Fetched N messages." line, the old help text, the old flag table and the old request counts. All were updated to the new behaviour; no assertion was loosened in a way that stops it failing on a regression. A `fetchRequests` helper was added so request-count assertions stay about fetching rather than write-back.
- **Verification (2026-10-10).** `bun run test` — 510 passed (34 files); `bun run lint` — exit 0; `bun run build` — exit 0.

## Spec Change Log

## Review Triage Log

- **patch — partial-folder fetch accounting** (blind-hunter 1, 2, 3; edge-case-hunter 2;
  verification-gap 3 + other) — a partial folder failure counted the account's messages in
  `fetched` while never classifying or writing them, so the CLI summary could read
  "Fetched 2 message(s) from 0 account(s)". Verified from the code path and the missing
  `PARTIAL_FOLDER` test. Fixed by not counting a partial-failed account's messages in `fetched`,
  and pinned with the new `PARTIAL_FOLDER` test.

- **patch — CLI flags accept without `--backfill`** (blind-hunter 4; edge-case-hunter 3) —
  `--since`/`--batch-size` were silently ignored on every command other than `--backfill`, and a
  stray `--since` could fall through to the "auth and account required" error. Verified by the
  resolver's routing and the empty dispatch-test coverage. Fixed by rejecting the two flags
  unless `--backfill` is set, plus dispatch tests for valid and invalid values.

- **patch — `--since` shape check** (blind-hunter 5) — `parseSince` advertised ISO-8601 but
  accepted any parseable date. Verified by the code and the new tests. Fixed by rejecting
  values that do not start with a `YYYY-MM-DD` shape.

- **patch — dispatch parse-test gap** (verification-gap 1) — `--since`/`--batch-size` validation
  had no tests. Verified by the empty test coverage. Pinned with the new dispatch tests.

- **patch — CLI fold + provider ceiling test gap** (verification-gap 2; blind-hunter 8) — the
  command-level fold of `--since`/`--batch-size` was never exercised, nor the `--batch-size`
  ceiling the AC names. Pinned with the new `CLI_FLAGS` test that drives one M365 fetch with
  both bounds and sees `$top=100`.

- **patch — model adapter error line** (edge-case-hunter 1) — a missing model API key or an
  unsupported provider escaped `createModelAdapter` as a stack trace. Verified from the code
  and the adapter's errors. Fixed with the same `errorLine` catch the command uses elsewhere.

- **patch — implicit `any` on the classifier seam** (blind-hunter 11) — `let taxonomy;` was
  implicitly `any`, erasing the type at the classifier seam. Verified by the code and the
  typecheck. Fixed with the explicit `Taxonomy` annotation.

- **patch — clamp comments** (blind-hunter 7) — the comments misattributed the batch-size
  clamp to the orchestrator. The adapters own the clamp, so they were corrected.

- **low — duplicate `errorLine` copies** (blind-hunter 13) — a cosmetic inconsistency; no
  user-visible path differs. Left as-is.

- **low/maybe-false — `PROGRESS_INTERVAL` duplicate** (blind-hunter 9, 10) — the interval
  boundary can duplicate the final progress line and the path is untested. The duplicate is
  noise, not a defect; no everyday account runs at exactly that boundary. Left as-is.

- **maybe-false — overlong `--batch-size`** (edge-case-hunter 4) — a digit string long enough
  for `Number(raw)` to overflow to Infinity is accepted, but the adapter still clamps
  Infinity down to its default. Verified against `clampBatchSize`. Left as-is.

- **maybe-false — Gmail CLI happy path** (blind-hunter 12) — the CLI test suite stops at the
  Gmail `UNCACHED_ACCOUNT` case, but the adapter-level test suite already proves the full
  add-only write path. Not a code defect. Left as-is.

## Spec Change Log

## Verification

### Review Findings

- [x] [Review][Patch] `processed` counter partition is broken when `writeLabels` throws — `src/orch/classification-run.ts:123` — move the increment into the success branches so `processed = labeled + skipped` stays true.
- [x] [Review][Patch] Empty-account progress line is suppressed — `src/orch/classification-run.ts:171` — emit the per-account zero line for a clean empty account.
- [x] [Review][Patch] `PARTIAL_FOLDER` test name mismatches the behavior it pins — `tests/orch/classification-run.test.ts:257` — rename it to match the actual partial-folder accounting.
- [x] [Review][Patch] `--since` help/doc wording and cross-reference drift — `src/cli/main.ts:52`, `src/cli/commands/backfill.ts:38` — make the wording and the story reference match this story.
- [x] [Review][Patch] `--since` accepts a non-ISO-ish date and a nonexistent calendar date — `src/cli/dispatch.ts:71` — tighten the parse to the advertised shape.

- `mise exec node@20 -- bun run test` — expected: vitest green and `typecheck` passing
- `mise exec node@20 -- bun run lint` — expected: oxlint and the core external-import guard pass
- `mise exec node@20 -- bun run build` — expected: `tsc -b` clean
