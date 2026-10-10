# Review Layer: Edge Case Hunter

Run this in a **fresh session, ideally a different LLM**. Everything is inlined so the prompt
stands alone; the diff is at the bottom.

## Prompt

Read the review instructions below completely and follow them as your review instructions.

claims_file (leave unread until your instructions call for it): `_bmad-output/implementation-artifacts/spec-8-1-backfill-mode-execution-multi-account.md`

Review content: the unified diff inlined at the bottom of this file. Read it — it is the content under review.

Do not invoke any skill, and do not spawn subagents of your own — you are the reviewer. If the instruction file is unreadable, report that exact failure and stop. Return your findings as text in your final message; do not route them through any findings-reporting tool the host may offer.

---

## Review instructions

# Edge Case Hunter Review

**Goal:** You are a pure path tracer. Never comment on whether code is good or bad; only list missing handling.
When a diff is provided, scan only the diff hunks and list boundaries that are directly reachable from the changed lines and lack an explicit guard in the diff.
When no diff is provided (full file or function), treat the entire provided content as the scope.
Ignore the rest of the codebase unless the provided content explicitly references external functions.
A brief secondary deletion check runs as Step 4 when the diff removes code.
A claims check runs as Step 5.

**Inputs:**
- **content** — Content to review, or a path to read it from: diff, full file, or function
- **also_consider** (optional) — Areas to keep in mind during review alongside normal edge-case analysis
- **claims_file** — Path to the spec this change was built from. Do NOT read it before Step 5: the path tracing in Steps 2–3 must finish before the claims are seen.

**MANDATORY: Execute steps in the Execution section IN EXACT ORDER. DO NOT skip steps or change the sequence. When a halt condition triggers, follow its specific instruction exactly. Each action within a step is a REQUIRED action to complete that step.**

**Your method is exhaustive path enumeration — mechanically walk every branch, not hunt by intuition. Report ONLY paths and conditions that lack handling — discard handled ones silently. Do NOT editorialize or add filler. Do not assign severity labels, rankings, or priority levels.**


## EXECUTION

### Step 1: Receive Content

- Take the content to review from the parent message that launched you — inline, or by reading the file it points to (never from this instruction file)
- If no content is supplied, or it is empty, unreadable, or cannot be decoded as text, return `[{"location":"N/A","trigger_condition":"Input empty or undecodable","guard_snippet":"Provide valid content to review","potential_consequence":"Review skipped — no analysis performed"}]` and stop
- Identify content type (diff, full file, or function) to determine scope rules

### Step 2: Exhaustive Path Analysis

**Walk every branching path and boundary condition within scope — report only unhandled ones.**

- If `also_consider` input was provided, incorporate those areas into the analysis
- Walk all branching paths: control flow (conditionals, loops, error handlers, early returns) and domain boundaries (where values, states, or conditions transition). Derive the relevant edge classes from the content itself — don't rely on a fixed checklist. Examples: missing else/default, unguarded inputs, off-by-one loops, arithmetic overflow, implicit type coercion, race conditions, timeout gaps
- Consider implicit branches: the diff special-cases or changes the handling of one or more members of a fixed set of values — enums, status codes, sentinels, type tags, flags, value ranges. The rest of the set is implicit branches (e.g. the diff changes the `RED` and `YELLOW` cases of a `RED`/`YELLOW`/`GREEN` enum; `GREEN` is the implicit branch)
- Consider handle lifetime: when the changed code re-checks, re-fetches, or re-validates something it already held — a handle, index, id, pointer — the re-check exists because an intervening call can invalidate it. Identify that call, what it does to the thing held, and what the changed code silently skips when the re-check fails
- For each call site the diff adds or changes — in test files as well as production code — read the callee's declaration and check the call against it: argument count, order, types, and defaults. Report any mismatch
- For each path: determine whether the content handles it
- Collect only the unhandled paths as findings — discard handled ones silently

### Step 3: Validate Completeness

- Revisit every edge class from Step 2 — e.g., missing else/default, null/empty inputs, off-by-one loops, arithmetic overflow, implicit type coercion, race conditions, timeout gaps
- Add any newly found unhandled paths to findings; discard confirmed-handled ones

### Step 4: Deletion Check

If the diff removed or replaced meaningful code (ignore pure renames and whitespace): load `references/deletion-check.md` and follow it.

### Step 5: Claims Check

Load `references/claims-check.md` and follow it.

### Step 6: Present Findings

Output all findings as a single JSON array following the Output Format specification exactly.


## OUTPUT FORMAT

Return ONLY a valid JSON array of objects. Each edge-case finding contains exactly these four fields:

```json
[{
  "location": "file:start-end (or file:line when single line, or file:hunk when exact line unavailable)",
  "trigger_condition": "one-line description (max 15 words)",
  "guard_snippet": "minimal code sketch that closes the gap (single-line escaped string, no raw newlines or unescaped quotes)",
  "potential_consequence": "what could actually go wrong (max 15 words)"
}]
```

No extra text, no explanations, no markdown wrapping. An empty array `[]` is valid when nothing is found. Deletion findings from Step 4 and claim findings from Step 5, if any, go in the same array with the extra fields defined in `references/deletion-check.md` and `references/claims-check.md`.


## HALT CONDITIONS

- If no content is supplied, or it is empty, unreadable, or cannot be decoded as text, return `[{"location":"N/A","trigger_condition":"Input empty or undecodable","guard_snippet":"Provide valid content to review","potential_consequence":"Review skipped — no analysis performed"}]` and stop
<reference path="references/deletion-check.md">
# Deletion Check

Secondary pass for the Edge Case Hunter — runs only when the diff removed meaningful code. Subordinate to the edge-case pass; findings are usually few or none.

For each chunk of removed or replaced code (ignore pure renames and whitespace), ask: did it carry behavior or a contract that the change neither re-established nor intentionally retired? Add a finding for any resulting regression, orphaned reference, or newly-dead code. Skip anything already covered by your edge-case findings.

Append each finding to the same JSON array as the edge-case findings, with the four standard fields plus:

- `kind`: `"deletion"`
- `confidence`: `"high"`, `"medium"`, or `"low"` — these are inferences; rate them

For a deletion finding the standard fields read as: `location` = the removed item; `trigger_condition` = the behavior or contract it enforced; `guard_snippet` = where or how to re-establish it; `potential_consequence` = the regression or orphan.

Add nothing if nothing qualifies.
</reference>
<reference path="references/claims-check.md">
# Claims Check

Final pass for the Edge Case Hunter. Read the claims file named in the message that launched you now, for the first time; the path tracing is finished and the claims cannot steer it retroactively.

It is the spec the change was built from. Read only its `## Intent` and `## Tasks & Acceptance` sections — the claims live there; ignore the rest of the file. The spec is the change's own account of itself: testimony, not evidence — a claim repeated in a code comment is still the same claim, not confirmation. Extract each checkable claim — what the change does, what it preserves, ordering, arithmetic, and parity with existing code ("exactly as X does") — then try to falsify each one against the code you have already traced. Where your trace is not enough to decide, read the code that decides it: the compared-to function, the actual callee, the state the claim assumes.

Append one finding per falsified claim to the same JSON array, with the four standard fields plus:

- `kind`: `"claim"`
- `confidence`: `"high"`, `"medium"`, or `"low"`

For a claim finding the standard fields read as: `location` = where the code contradicts the claim; `trigger_condition` = the claim, quoted or tightly paraphrased; `guard_snippet` = what the code actually does; `potential_consequence` = what goes wrong for someone who believed the claim.

Verified claims produce nothing. Add nothing if nothing is falsified.
</reference>

## CONTENT SOURCE

"Review content:" in the message that launched you gives the content itself or a path to read it from. Read the file when it is a path; either way that is the content under review, and this instruction file never is.


---

## CONTENT — unified diff (`/tmp/spec-8-1-review.diff`)

```diff
diff --git c/_bmad-output/implementation-artifacts/epic-8-context.md w/_bmad-output/implementation-artifacts/epic-8-context.md
new file mode 100644
index 0000000..3d6fece
--- /dev/null
+++ w/_bmad-output/implementation-artifacts/epic-8-context.md
@@ -0,0 +1,41 @@
+# Epic 8 Context: Backfill & Cron Orchestration
+
+<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->
+
+## Goal
+
+A user can run a one-shot backfill or a recurring cron loop that exercises all accounts with isolation and resumability. Epic 8 is where the pieces built in Epics 4–7 stop being separate commands and become one product run: fetch messages, classify them against the active taxonomy, and write the resulting labels back to the source mailbox. It also introduces the state that makes a run safe to interrupt and restart — an idempotency store and a process lock — so a killed backfill resumes instead of redoing or double-labelling work.
+
+## Stories
+
+- Story 8.1: Backfill Mode Execution (Multi-Account)
+- Story 8.2: Idempotency & Resume (Multi-Account)
+- Story 8.3: Cron Mode Loop (Multi-Account)
+
+## Requirements & Constraints
+
+- **One run, three stages.** For each selected account: fetch (FR-6/FR-8) → classify (FR-12) → write labels (FR-13/FR-14). Accounts are processed sequentially and independently: one account's failure is logged and never aborts the others.
+- **Add-only write-back.** Labels are only ever added; user-applied labels are never removed. A message already carrying every predicted label costs no write call. Re-runs must be safe.
+- **`LabelSet` contract.** Write-back consumes the classifier's validated `{ labels: string[] }` naming taxonomy labels. An empty set is valid and means no write.
+- **Per-account isolation.** A fetch, classification, or write failure for one account is logged with the account name; other accounts continue. A failed account must never read as a successful one.
+- **Typed, actionable errors (AD-4).** Every failure surfaces as one actionable line naming the account — never a stack trace or a raw provider payload. Exit codes reflect whether any account failed.
+- **Progress reporting.** A backfill logs per-account progress (counts of processed, labeled, skipped and errored messages) rather than one line at the end.
+- **Fetch bounds.** A backfill accepts a lower time bound and a batch size; defaults are 50 with a provider ceiling of 100.
+- **The cron window is INBOX-only** for Gmail and the account's configured folders for M365.
+
+## Technical Decisions
+
+- **Hexagonal dependency direction (AD-10).** `src/core` imports nothing; `src/adapters` and `src/orch` reach `core` only; `src/cli` wires all. Orchestration therefore depends on narrow structural seams (e.g. an object with just the one port method it needs), not on concrete adapters.
+- **AD-8 MailPort seam.** `MailPort.writeLabels(accountId, messageId, labels)` is implemented by the per-provider adapters. Provider wire specifics stay inside the adapters; orchestration never sees them.
+- **Composed, not monolithic orchestration.** Each stage already has its own pure module (`orch/fetch`, `orch/incremental`, `orch/sync`, `orch/classify`). A run loop composes them; it does not reimplement them.
+- **Seams-object idiom.** Options interfaces carrying the work plus injected ports/loggers are the repo's established shape (`FetchAllMessagesOptions`, `SyncCategoriesOptions`, `ClassifyOptions`).
+- **Injected clock and filesystem roots.** Anything reading the wall clock, the home directory, or the network is injected so tests never touch real state (`now`, `configDir`, `fetchFn`).
+- **Idempotency store shape.** A single shared SQLite database at `~/.config/email-classify/idempotency.db`, partitioned by the `accountId` baked into each key — not per-account files. The key is `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))`.
+- **Process-level file lock.** A run acquires a lock covering the idempotency store and the per-account state files; a concurrent invocation exits 1 with a clear "another email-classify run is in progress" error.
+- **Per-account state** lives in a shared state file, carrying each account's last-run timestamp and (for Gmail) a history cursor.
+
+## Cross-Story Dependencies
+
+- **Upstream:** Epic 4 (taxonomy + per-account label/category sync), Epic 5 (fetch and incremental fetch), Epic 6 (the classification unit and `ModelPort`), Epic 7 (`MailPort.writeLabels` for both providers).
+- **Within the epic:** 8.1 establishes the run loop; 8.2 adds the idempotency store, resume and the process lock onto it; 8.3 wraps 8.1's stages in an interval loop and adds per-cycle state updates.
+- **Downstream:** Epic 9 (rate-limit backoff and graceful shutdown) and Epic 10 (structured logging, metrics and cost) attach to the loop this epic builds; Epic 11 replaces the temporary CLI wiring with a real configuration and DI container.
diff --git c/_bmad-output/implementation-artifacts/spec-8-1-backfill-mode-execution-multi-account.md w/_bmad-output/implementation-artifacts/spec-8-1-backfill-mode-execution-multi-account.md
new file mode 100644
index 0000000..8dc7ddb
--- /dev/null
+++ w/_bmad-output/implementation-artifacts/spec-8-1-backfill-mode-execution-multi-account.md
@@ -0,0 +1,96 @@
+---
+title: 'Story 8.1: Backfill Mode Execution (Multi-Account)'
+type: 'feature'
+created: '2026-10-10'
+status: 'in-review'
+route: 'dispatch'
+baseline_commit: '6ecfa24c5d5a9af36106cbeab8dd529dda2fc518'
+review_loop_iteration: 0
+context:
+  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
+---
+
+<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">
+
+## Intent
+
+**Problem:** Every stage of the product exists but nothing runs them together. `--backfill` currently fetches messages and throws them away — its own help text says "nothing is written back" — so the classifier (Epic 6) and both providers' `writeLabels` (Epic 7) have no production caller. A user cannot yet get their existing mail classified and labelled.
+
+**Approach:** Turn `--backfill` into the product's first real run: for each selected account, in sequence, fetch its messages, classify each against the active taxonomy, and write the resulting labels back through `MailPort.writeLabels`. Stage the loop as a new pure orchestration module that composes the existing `orch/fetch` and `orch/classify` units rather than reimplementing them, and give the command the taxonomy, model and per-account progress reporting it needs to drive that loop.
+
+## I/O & Edge-Case Matrix
+
+| Scenario | Input / State | Expected Output / Behavior | Error Handling |
+|----------|--------------|---------------------------|----------------|
+| HAPPY_PATH | One enabled account, 3 fetched messages | Each message is classified and its labels written; per-account counts report 3 processed | N/A |
+| EMPTY_ACCOUNT | Account lists cleanly, fetch returns nothing | Account reports 0 processed; no classification or write call; run still succeeds | N/A |
+| EMPTY_LABEL_SET | Classifier returns `{ labels: [] }` | No `writeLabels` call for that message; counted as processed, not labeled | N/A |
+| ONE_ACCOUNT_FAILS | Two accounts; the first's fetch throws | Failure logged naming that account; the second account is still fetched, classified and written | Isolated; run exits non-zero |
+| MESSAGE_WRITE_FAILS | `writeLabels` throws for one message | Error logged naming the account and message; the account's remaining messages continue | Isolated; counted as an error |
+| CLASSIFY_REJECTS | Transport rejection from the model | Error logged naming the account; remaining messages for that account continue | Isolated; counted as an error |
+| NO_ACCOUNTS | Selection matches nothing | Existing "no enabled accounts" hint and exit code 1 | N/A |
+| BOTH_STAGES_REPORT | Any run | A fetch failure is not double-counted as a classification failure | N/A |
+
+## Decisions (human, 2026-10-10)
+
+- **`--source all` is Story 8.3's, not 8.1's.** The epic's 8.1 AC lists `|all`, but the 2026-10-09 decision recorded at `src/cli/dispatch.ts:36` ("`all` is not a provider") stands: 8.1 keeps the two-provider guard, and the cross-provider loop lands once, in 8.3. The epic text is reconciled when 8.3 lands — not by widening 8.1.
+- **The CLI owns the `ModelConfig` and passes it in.** `src/cli/commands/backfill.ts` resolves the model config and hands it to the orchestrator; no new config surface is added and `src/orch` stays free of `adapters/model` (AD-10). Until Epic 11 owns real model settings, the resolution falls back to the ratified `DEFAULT_MODEL_CONFIG` when none is configured.
+- **"skipped" counts empty label sets.** A message the classifier gives no labels is processed-and-skipped; the four per-account counters partition as `processed = labeled + skipped`, plus `errors` counted separately.
+
+</frozen-after-approval>
+
+## Code Map
+
+- `src/orch/fetch.ts:37` — `fetchAllMessages(options)`: the existing per-account, per-folder fetch loop with isolation; **reuse as-is**, do not fold classification into it.
+- `src/orch/classify.ts:16` — `ClassifyOptions`; `classify(options)` is the one-message unit (`message`, `taxonomy`, `model`, `config`, `logPort`, `context`) — the loop calls this per message.
+- `src/orch/sync.ts:4` — `CategorySyncTarget`: the minimal structural port seam idiom to copy for a `writeLabels` seam.
+- `src/core/ports/MailPort.ts:1` — `MailPort`; the loop must need only `fetchMessages` + `writeLabels`, not the whole port.
+- `src/adapters/config/taxonomy.ts:81` — `loadTaxonomy({ taxonomyPath?, configDir? })`: the CLI loads and freezes the taxonomy before the run (mirrors `sync-categories.ts:105`).
+- `src/adapters/model/modelAdapterFactory.ts:36` — `ModelAdapterDeps`; `createModelAdapter(config, deps)` at `:99` and `defaultModelClientFactories` at `:130` are the wiring seam. **`orch`/`core` must not import this file** (AD-10).
+- `src/cli/commands/backfill.ts:69` — `runBackfill`: currently lists → `fetchAllMessages` → prints counts. This is the file that changes most; `planFor`/`port` per provider are already there.
+- `src/cli/commands/sync-categories.ts:53` — `createConsoleLogPort()`; the temporary `LogPort` the backfill already reuses (Epic 10 owns the real one).
+- `src/cli/dispatch.ts:26` — `resolveBackfill`: the `--since`/`--batch-size` flags are parsed here (it already owns source/account validation); `:36` is the `--source all` guard under question.
+- `src/cli/main.ts:34` — `createProgram(handlers)`: the option table lives here.
+- `src/cli/index.ts:1` — the commander entry point; the help text at `src/cli/index.ts:13-40` is user-facing and promises "nothing is written back".
+- `tests/adapters/gmail/gmail-label-write.test.ts:1`, `tests/orch/*` — the test idioms to mirror (scripted fetch, recording log port, temp config).
+- **Out of bounds:** `src/core/**` (AD-10 — no new core types needed), the idempotency store and process lock (Story 8.2), the interval loop (Story 8.3), the real logger/metrics (Epic 10), and the DI container (Epic 11).
+
+## Tasks & Acceptance
+
+**Execution:**
+- [x] `src/orch/classification-run.ts` — new loop: per account, per folder fetch with the shared defaults, classify each message via `classify`, write via a minimal `LabelWriteTarget` seam, accumulate the counters, isolate per-account and per-message failures, and log per-account progress — the story's whole behaviour, kept out of the CLI so it is testable without booting one.
+- [x] `src/cli/commands/backfill.ts` — load the taxonomy and model, build the model adapter, drive the new loop instead of `fetchAllMessages`, and thread `--since`/`--batch-size` into each account's plan — the wiring.
+- [x] `src/cli/dispatch.ts` + `src/cli/main.ts` — accept and validate `--since <date>` and `--batch-size <n>` for `--backfill` — the flags the AC names.
+- [x] `src/cli/main.ts` (the `addHelpText` block) — update the `--backfill` help text and examples, which promised "nothing is written back" — the promise it makes is now false.
+- [x] `tests/orch/classification-run.test.ts` — pin every row of the I/O matrix, including two-account isolation and the empty-label-set no-write case — the ACs are only real if tested.
+- [x] `tests/cli/backfill.test.ts` — the existing CLI suite now supplies a model double and scripted write responses, and asserts the new progress lines — the command's own path must stay covered.
+
+**Acceptance Criteria:**
+- Given a Gmail account with fetched messages and a working model, when `--backfill --source gmail --account <name>` runs, then each message is classified and its labels are written back through `MailPort.writeLabels` with that message's id.
+- Given two accounts where the first fails to fetch, when the backfill runs, then the failure is logged naming the first account and the second account is still processed to completion.
+- Given a classifier result of `{ labels: [] }`, when the message is processed, then no `writeLabels` call is made for it.
+- Given `--batch-size` is passed, when fetching, then the value is applied per account and clamped to the provider's maximum.
+- Given `--since <date>` is passed, when fetching, then only messages received after that date are fetched, per account.
+
+## Implementation Notes
+
+- **As-built shape.** `src/orch/classification-run.ts` owns the loop. It fetches each account's folders itself (with `fetch.ts`'s exported `DEFAULT_FOLDERS`/`DEFAULT_BATCH_SIZE`) rather than calling `fetchAllMessages`, because that unit counts messages but does not return them — the loop needs the array. Folder isolation is preserved (one folder's failure logs and the account's other folders still walk), and a folder failure marks the account failed so its partial fetch is never reported as clean.
+- **AD-10 held.** The new module imports only `core` types plus sibling `orch` units. `createModelAdapter` and `DEFAULT_MODEL_CONFIG` are reached from `src/cli/commands/backfill.ts` only.
+- **Decision 1 (`--source all`).** `dispatch.ts` keeps its guard unchanged; the epic text stays unreconciled until Story 8.3.
+- **Decision 2 (model config).** `BackfillRuntime` gained `modelConfig` and `model`; the `modelConfig` default is `DEFAULT_MODEL_CONFIG` so a run works out of the box off `TYPESAFE_API_KEY`.
+- **Decision 3 (skipped).** An empty `LabelSet` increments `skipped` and returns before any write; `processed = labeled + skipped` is pinned by the `COUNTERS` test.
+- **Exit code.** `runBackfill` returns non-zero when any account failed **or** any message errored — a run that classified nothing because writes all failed must not read as success.
+- **Write-back is unreachable without a prior sync.** The CLI tests revealed this: a Gmail `writeLabels` with no cached label map raises the frozen `WRITE_LABELS_FAILED` typed error (Story 7.2's `UNCACHED_ACCOUNT` row). Two Gmail CLI tests therefore assert `0 labeled, N error(s)` rather than a successful write. This is correct behaviour, not a defect — but it means **`--backfill` must be preceded by `--sync-categories`** for labels to actually land, which is worth stating in help text (Epic 11's command surface).
+- **Pre-existing test expectations updated, nothing weakened.** `tests/cli/backfill.test.ts` and `tests/cli/main.test.ts` asserted the old per-account "Fetched N messages." line, the old help text, the old flag table and the old request counts. All were updated to the new behaviour; no assertion was loosened in a way that stops it failing on a regression. A `fetchRequests` helper was added so request-count assertions stay about fetching rather than write-back.
+- **Verification (2026-10-10).** `bun run test` — 510 passed (34 files); `bun run lint` — exit 0; `bun run build` — exit 0.
+
+## Spec Change Log
+
+## Review Triage Log
+
+## Verification
+
+**Commands:**
+- `mise exec node@20 -- bun run test` — expected: vitest green and `typecheck` passing
+- `mise exec node@20 -- bun run lint` — expected: oxlint and the core external-import guard pass
+- `mise exec node@20 -- bun run build` — expected: `tsc -b` clean
diff --git c/_bmad-output/implementation-artifacts/sprint-status.yaml w/_bmad-output/implementation-artifacts/sprint-status.yaml
index 7670198..bbb3961 100644
--- c/_bmad-output/implementation-artifacts/sprint-status.yaml
+++ w/_bmad-output/implementation-artifacts/sprint-status.yaml
@@ -29,7 +29,7 @@
 # - Dev moves story to 'review', then runs code-review (fresh context, different LLM recommended)
 # - Retrospective appends its action items to action_items; the status view surfaces open ones
 generated: 10-08-2026 10:25
-last_updated: 10-10-2026 03:46
+last_updated: 10-10-2026 04:04
 project: email-agent
 project_key: NOKEY
 tracking_system: file-system
@@ -74,8 +74,8 @@ development_status:
   7-2-gmail-label-write-multi-account: done
   epic-7-retrospective: done
 
-  epic-8: backlog
-  8-1-backfill-mode-execution-multi-account: backlog
+  epic-8: in-progress
+  8-1-backfill-mode-execution-multi-account: in-progress
   8-2-idempotency-resume-multi-account: backlog
   8-3-cron-mode-loop-multi-account: backlog
   epic-8-retrospective: optional
diff --git c/src/cli/commands/backfill.ts w/src/cli/commands/backfill.ts
index 81051a4..1840c53 100644
--- c/src/cli/commands/backfill.ts
+++ w/src/cli/commands/backfill.ts
@@ -13,9 +13,18 @@ import {
 import { M365Adapter } from "../../adapters/m365/M365Adapter.js";
 import { M365AuthAdapter, type FetchLike } from "../../adapters/m365/M365AuthAdapter.js";
 import { KeychainTokenStore } from "../../adapters/token/KeychainTokenStore.js";
+import { loadTaxonomy } from "../../adapters/config/taxonomy.js";
+import { createModelAdapter, defaultModelClientFactories, DEFAULT_MODEL_CONFIG } from "../../adapters/model/modelAdapterFactory.js";
+import type { ModelConfig } from "../../core/dto/ModelConfig.js";
 import type { LogPort } from "../../core/ports/LogPort.js";
 import type { TokenPort } from "../../core/ports/TokenPort.js";
-import { fetchAllMessages, type FetchAccount, type MessageFetchTarget } from "../../orch/fetch.js";
+import {
+  runBackfillAccounts,
+  type BackfillAccount,
+  type BackfillResult,
+  type LabelWriteTarget,
+} from "../../orch/classification-run.js";
+import { type MessageFetchTarget } from "../../orch/fetch.js";
 import { createPassphrasePrompt, errorLine } from "./auth.js";
 import { createConsoleLogPort } from "./sync-categories.js";
 
@@ -24,6 +33,10 @@ export interface BackfillCommandOptions {
   source: "m365" | "gmail";
   /** A per-account settings name, or "all" for every enabled account of that provider. */
   account: string;
+  /** Messages received after this instant are the only ones fetched; absent means all time (Story 8.2's AC default). */
+  since?: Date;
+  /** The per-account fetch batch; the orchestrator clamps it to the provider's ceiling (default 50, max 100). */
+  batchSize?: number;
 }
 
 /** Test seam mirroring `runSyncCategories`'s: mocked network, in-memory tokens, temp config, recording logger. */
@@ -32,7 +45,12 @@ export interface BackfillRuntime {
   tokenStore?: TokenPort;
   /** Root of `~/.config/email-classify`; injectable so tests never touch the real home. */
   configDir?: string;
+  taxonomyPath?: string | URL;
   logPort?: LogPort;
+  /** The model config a run classifies with; defaults to the ratified `DEFAULT_MODEL_CONFIG` (Epic 11 owns real settings). */
+  modelConfig?: ModelConfig;
+  /** Model adapter seam; injectable so a test never reaches a provider SDK or the network. */
+  model?: Parameters<typeof runBackfillAccounts>[0]["model"];
 }
 
 /** The part of a per-account listing this command reads; both providers return one. */
@@ -50,17 +68,17 @@ interface EnabledAccountsListing {
   errors: Array<{ accountName: string; message: string }>;
 }
 
-/** One provider's half of the command: its listing, its fetch port, and how its settings become a plan. */
-interface FetchProviderPlan {
+/** One provider's half of the command: its listing, its fetch+write port, and how its settings become a plan. */
+interface BackfillProviderPlan {
   provider: "m365" | "gmail";
   accountsDirDisplayPath(): string;
   listEnabledAccounts(): Promise<EnabledAccountsListing>;
-  planFor(entry: EnabledAccountSettings): FetchAccount;
-  port: MessageFetchTarget;
+  planFor(entry: EnabledAccountSettings): BackfillAccount;
+  port: MessageFetchTarget & LabelWriteTarget;
 }
 
 /** Provider-specific setup hint, for when the selection has no account to fetch. */
-function noAccountsHint(plan: FetchProviderPlan, account: string): string {
+function noAccountsHint(plan: BackfillProviderPlan, account: string): string {
   const file = account === "all" ? "<name>.yaml" : `${account}.yaml`;
   return account === "all"
     ? `No enabled ${plan.provider} accounts found — add ${plan.accountsDirDisplayPath()}/${file} with "enabled: true".`
@@ -68,21 +86,41 @@ function noAccountsHint(plan: FetchProviderPlan, account: string): string {
 }
 
 /**
- * Temporary `--backfill --source <m365|gmail> --account <name|all>` command (human scope
- * decision, 2026-10-09): lists the enabled accounts for the requested provider, fetches
- * them through the shared `fetchAllMessages` with per-account isolation, prints each
- * account's count and a counted failure line, and maps the failure count to the exit code.
- * Nothing is persisted. Replaced wholesale by Epic 11's DI container and `main.ts`.
+ * The one-shot backfill: `--backfill --source <m365|gmail> --account <name|all>`, optionally
+ * bounded by `--since` and `--batch-size`. Lists the enabled accounts for the requested
+ * provider, then for each account fetches its messages, classifies every one against the
+ * merged taxonomy and writes the resulting labels back through `MailPort.writeLabels`
+ * (Story 8.1). Accounts are processed sequentially and independently; the failure count maps
+ * to the exit code. Nothing is persisted yet — resume is Story 8.2's.
  */
 export async function runBackfill(
   options: BackfillCommandOptions,
   runtime: BackfillRuntime = {},
 ): Promise<number> {
   const configDir = runtime.configDir === undefined ? {} : { configDir: runtime.configDir };
+  const modelConfig = runtime.modelConfig ?? DEFAULT_MODEL_CONFIG;
+
+  let taxonomy;
+  try {
+    taxonomy = await loadTaxonomy({
+      ...(runtime.taxonomyPath === undefined ? {} : { taxonomyPath: runtime.taxonomyPath }),
+      ...configDir,
+    });
+  } catch (error) {
+    process.stderr.write(`${errorLine(error)}\n`);
+    return 1;
+  }
+
   const fetchFn = runtime.fetchFn ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
   const tokenStore =
     runtime.tokenStore ?? new KeychainTokenStore({ promptPassphrase: createPassphrasePrompt(), ...configDir });
   const logPort = runtime.logPort ?? createConsoleLogPort();
+  const model =
+    runtime.model ??
+    createModelAdapter(modelConfig, {
+      log: logPort,
+      ...defaultModelClientFactories,
+    });
   const m365Auth = new M365AuthAdapter({
     fetchFn,
     tokenStore,
@@ -93,7 +131,7 @@ export async function runBackfill(
     tokenStore,
     accountSettings: { read: (accountName) => readGmailAccountSettings(accountName, configDir) },
   });
-  const plans: Record<BackfillCommandOptions["source"], FetchProviderPlan> = {
+  const plans: Record<BackfillCommandOptions["source"], BackfillProviderPlan> = {
     m365: {
       provider: "m365",
       accountsDirDisplayPath: m365AccountsDirDisplayPath,
@@ -154,15 +192,36 @@ export async function runBackfill(
     return 1;
   }
 
-  const accounts = selected.map((entry) => plan.planFor(entry));
-  const { fetched, failures } = await fetchAllMessages({ accounts, mailPort: plan.port, logPort, source: plan.provider });
+  // The command-level flags are the same for every account: `--batch-size` is folded in first so
+  // an account's own settings file still wins, and `--since` bounds every account's walk.
+  const accounts = selected.map((entry) => {
+    const planned = plan.planFor(entry);
+    return {
+      ...planned,
+      ...(options.batchSize === undefined ? {} : { batchSize: planned.batchSize ?? options.batchSize }),
+      ...(options.since === undefined ? {} : { since: options.since }),
+    };
+  });
+  const result: BackfillResult = await runBackfillAccounts({
+    accounts,
+    mailPort: plan.port,
+    taxonomy,
+    model,
+    config: modelConfig,
+    logPort,
+    source: plan.provider,
+  });
+
   const total = selected.length + relevantErrors.length;
-  const totalFailures = failures + relevantErrors.length;
+  const totalFailures = result.failures + relevantErrors.length;
   if (totalFailures > 0) {
     process.stderr.write(`${totalFailures} of ${total} ${plan.provider} account(s) failed.\n`);
   }
   // The count of accounts that actually produced messages, not the number selected: a failed account
   // is already reported on stderr, and claiming it here would read as if it had fetched something.
-  process.stdout.write(`Fetched ${fetched} message(s) from ${selected.length - failures} account(s).\n`);
-  return totalFailures > 0 ? 1 : 0;
+  process.stdout.write(
+    `Fetched ${result.fetched} message(s) from ${selected.length - result.failures} account(s): ` +
+      `${result.labeled} labeled, ${result.skipped} skipped, ${result.errors} error(s).\n`,
+  );
+  return totalFailures > 0 || result.errors > 0 ? 1 : 0;
 }
diff --git c/src/cli/dispatch.ts w/src/cli/dispatch.ts
index 9e0b66a..5935a63 100644
--- c/src/cli/dispatch.ts
+++ w/src/cli/dispatch.ts
@@ -6,6 +6,10 @@ export interface CliOptions {
   backfill?: boolean;
   cron?: boolean;
   source?: string;
+  /** `--backfill` lower time bound (Story 8.1); parsed to a `Date` in the resolver. */
+  since?: string;
+  /** `--backfill` per-account fetch batch; validated to an integer here, clamped by the orchestrator. */
+  batchSize?: string;
 }
 
 /**
@@ -16,7 +20,7 @@ export interface CliOptions {
 export type CliCommand =
   | { kind: "auth"; provider: string; account: string }
   | { kind: "sync"; account: string }
-  | { kind: "backfill"; source: "m365" | "gmail"; account: string }
+  | { kind: "backfill"; source: "m365" | "gmail"; account: string; since?: Date; batchSize?: number }
   | { kind: "cron"; source: "m365" | "gmail"; account: string }
   | { kind: "error"; message: string };
 
@@ -42,7 +46,37 @@ function resolveBackfill(options: CliOptions): CliCommand {
     return { kind: "error", message: `Unknown --source "${source}" — supported sources are "m365" and "gmail".` };
   }
   // `--account` defaults to "all": backfill is meant to run for every enabled account.
-  return { kind: "backfill", source, account: options.account ?? "all" };
+  // The two optional bounds are validated here so a malformed one fails before any account is listed.
+  const since = parseSince(options.since);
+  if (since === null) {
+    return { kind: "error", message: `--since "${options.since}" is not a valid date — use an ISO-8601 date (e.g. 2026-01-01).` };
+  }
+  const batchSize = parseBatchSize(options.batchSize);
+  if (batchSize === null) {
+    return { kind: "error", message: `--batch-size "${options.batchSize}" is not a positive integer.` };
+  }
+  return {
+    kind: "backfill",
+    source,
+    account: options.account ?? "all",
+    ...(since === undefined ? {} : { since }),
+    ...(batchSize === undefined ? {} : { batchSize }),
+  };
+}
+
+/** `undefined` when unset; `null` when set but unparseable, so the caller can name the bad value. */
+function parseSince(raw: string | undefined): Date | undefined | null {
+  if (raw === undefined) return undefined;
+  const date = new Date(raw);
+  return Number.isNaN(date.getTime()) ? null : date;
+}
+
+/** `undefined` when unset; `null` when set but not a positive integer. The ceiling stays the adapter's. */
+function parseBatchSize(raw: string | undefined): number | undefined | null {
+  if (raw === undefined) return undefined;
+  if (!/^\d+$/.test(raw.trim())) return null;
+  const value = Number(raw);
+  return value >= 1 ? value : null;
 }
 
 /**
diff --git c/src/cli/main.ts w/src/cli/main.ts
index 0b089a9..9ff3675 100644
--- c/src/cli/main.ts
+++ w/src/cli/main.ts
@@ -14,7 +14,7 @@ import { resolveCliCommand, type CliOptions } from "./dispatch.js";
 export interface CliHandlers {
   runAuth: (options: { provider: string; account: string }) => Promise<number>;
   runSyncCategories: (options: { account: string }) => Promise<number>;
-  runBackfill: (options: { source: "m365" | "gmail"; account: string }) => Promise<number>;
+  runBackfill: (options: { source: "m365" | "gmail"; account: string; since?: Date; batchSize?: number }) => Promise<number>;
   runCron: (options: { source: "m365" | "gmail"; account: string }) => Promise<number>;
 }
 
@@ -43,15 +43,17 @@ export function createProgram(handlers: CliHandlers): Command {
       "account to act on (a per-account settings name, or 'all' for every enabled account; defaults to 'all' for --sync-categories, --backfill and --cron)",
     )
     .option("--sync-categories", "ensure the taxonomy's labels exist as M365 master categories and Gmail labels")
-    .option("--backfill", "fetch every selected account's messages (m365 or gmail backfill; nothing is written back)")
+    .option("--backfill", "fetch, classify and label every selected account's messages (m365 or gmail backfill; labels are written back)")
     .option("--cron", "fetch only what is new per selected account (m365 or gmail incremental; the gmail window is the account's INBOX only; nothing is written back)")
     .option(
       "--source <provider>",
       'message source for --backfill/--cron; "m365" or "gmail" (defaults to "m365"; "all" is not a provider)',
     )
+    .option("--since <date>", "--backfill only: fetch messages received after this date (default: all time)")
+    .option("--batch-size <n>", "--backfill only: per-account fetch batch, clamped to the provider's maximum (default: 50)")
     .addHelpText(
       "after",
-      "\nExamples:\n  $ email-classify --auth m365 --account work\n  $ email-classify --auth m365 --account all\n  $ email-classify --auth gmail --account personal\n  $ email-classify --auth gmail --account all\n  $ email-classify --sync-categories --account all\n  $ email-classify --backfill --source m365 --account work\n  $ email-classify --backfill --source m365 --account all\n  $ email-classify --backfill --source gmail --account all\n  $ email-classify --cron --source m365 --account work\n  $ email-classify --cron --source m365 --account all\n  $ email-classify --cron --source gmail --account work\n  $ email-classify --cron --source gmail --account all\n",
+      "\nExamples:\n  $ email-classify --auth m365 --account work\n  $ email-classify --auth m365 --account all\n  $ email-classify --auth gmail --account personal\n  $ email-classify --auth gmail --account all\n  $ email-classify --sync-categories --account all\n  $ email-classify --backfill --source m365 --account work\n  $ email-classify --backfill --source m365 --account all\n  $ email-classify --backfill --source gmail --account all\n  $ email-classify --backfill --source gmail --account all --since 2026-01-01 --batch-size 100\n  $ email-classify --cron --source m365 --account work\n  $ email-classify --cron --source m365 --account all\n  $ email-classify --cron --source gmail --account work\n  $ email-classify --cron --source gmail --account all\n",
     )
     .action(async (options: CliOptions) => {
       const command = resolveCliCommand(options);
@@ -65,7 +67,12 @@ export function createProgram(handlers: CliHandlers): Command {
         return;
       }
       if (command.kind === "backfill") {
-        process.exitCode = await handlers.runBackfill({ source: command.source, account: command.account });
+        process.exitCode = await handlers.runBackfill({
+          source: command.source,
+          account: command.account,
+          ...(command.since === undefined ? {} : { since: command.since }),
+          ...(command.batchSize === undefined ? {} : { batchSize: command.batchSize }),
+        });
         return;
       }
       if (command.kind === "cron") {
diff --git c/src/orch/classification-run.ts w/src/orch/classification-run.ts
new file mode 100644
index 0000000..d62ddf6
--- /dev/null
+++ w/src/orch/classification-run.ts
@@ -0,0 +1,175 @@
+import type { LabelSet } from "../core/dto/LabelSet.js";
+import type { MessageDTO } from "../core/dto/MessageDTO.js";
+import type { ModelConfig } from "../core/dto/ModelConfig.js";
+import type { Taxonomy } from "../core/dto/Taxonomy.js";
+import type { LogPort } from "../core/ports/LogPort.js";
+import type { ModelPort } from "../core/ports/ModelPort.js";
+import { classify } from "./classify.js";
+import { DEFAULT_BATCH_SIZE, DEFAULT_FOLDERS, type FetchAccount, type MessageFetchTarget } from "./fetch.js";
+
+/** How often an account's progress line is written, in processed messages (Story 8.1's AC). */
+export const PROGRESS_INTERVAL = 100;
+
+/** The one `MailPort` method this loop needs beyond `fetchMessages`; both adapters implement it (AD-8, AD-10). */
+export interface LabelWriteTarget {
+  writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void>;
+}
+
+/** One account's backfill plan: the same fetch bounds the fetch loop takes, plus nothing new. */
+export type BackfillAccount = FetchAccount;
+
+/** The per-account counters the AC names; `processed = labeled + skipped`, with `errors` counted apart. */
+export interface AccountProgress {
+  processed: number;
+  labeled: number;
+  skipped: number;
+  errors: number;
+}
+
+export interface BackfillOptions {
+  accounts: BackfillAccount[];
+  /** The fetch + write seam: one object carrying the two `MailPort` methods this loop needs. */
+  mailPort: MessageFetchTarget & LabelWriteTarget;
+  /** The active (merged, frozen) taxonomy every message is classified against. */
+  taxonomy: Taxonomy;
+  /** The configured model adapter; one `complete` call per attempt, owned by `classify`. */
+  model: ModelPort;
+  /** The run's model config, carried unchanged into `classify`. */
+  config: ModelConfig;
+  logPort: LogPort;
+  /** The provider id stamped on every fetch; defaults to M365's (a Gmail run passes "gmail"). */
+  source?: "m365" | "gmail";
+}
+
+export interface BackfillResult {
+  /** Messages fetched across every account that fetched cleanly. */
+  fetched: number;
+  /** Messages classified and labelled, across every account. */
+  labeled: number;
+  /** Messages the classifier emptied — processed without a write (the "skipped" counter). */
+  skipped: number;
+  /** Messages whose classification or write failed; each was logged and did not stop the run. */
+  errors: number;
+  /** Accounts whose fetch failed outright; they are reported on stderr by the caller. */
+  failures: number;
+}
+
+/** Renders one actionable line — never a stack trace or a raw payload (AD-4). */
+function errorLine(error: unknown): string {
+  return error instanceof Error ? error.message : String(error);
+}
+
+function logProgress(progress: AccountProgress, accountId: string, logPort: LogPort): void {
+  logPort.info(
+    `Processed ${progress.processed} message(s): ${progress.labeled} labeled, ${progress.skipped} skipped, ${progress.errors} error(s).`,
+    { accountId },
+  );
+}
+
+/**
+ * One account's fetch, then per-message classify → write. The fetch walks the account's
+ * folders with the same `DEFAULT_FOLDERS`/`DEFAULT_BATCH_SIZE` defaults the fetch loop uses,
+ * and — like that loop — one folder's failure does not stop the account's other folders. Every
+ * fetched message is then classified and written individually: a single message's
+ * classification rejection or write failure is logged with that message's id and never stops
+ * the account's remaining messages.
+ */
+async function runAccount(
+  account: BackfillAccount,
+  options: BackfillOptions,
+  logPort: LogPort,
+): Promise<{ progress: AccountProgress; fetched: number; failed: boolean }> {
+  const { mailPort, taxonomy, model, config, source = "m365" } = options;
+  const accountId = account.accountId;
+  const progress: AccountProgress = { processed: 0, labeled: 0, skipped: 0, errors: 0 };
+  // An empty list is not "walk nothing" — it is a plan that never set folders, so it takes the default.
+  const folders = account.folders === undefined || account.folders.length === 0 ? DEFAULT_FOLDERS : account.folders;
+  const batchSize = account.batchSize ?? DEFAULT_BATCH_SIZE;
+
+  const messages: MessageDTO[] = [];
+  let accountFailed = false;
+  // A settings file can list the same folder twice; walking the de-duplicated list keeps both the
+  // work and the count honest.
+  for (const folder of new Set(folders)) {
+    try {
+      messages.push(
+        ...(await mailPort.fetchMessages({
+          source,
+          accountId,
+          folder,
+          batchSize,
+          ...(account.since === undefined ? {} : { since: account.since }),
+        })),
+      );
+    } catch (error) {
+      accountFailed = true;
+      logPort.error(errorLine(error), { accountId, folder });
+    }
+  }
+  // A failure in one folder does not abandon the account's other folders, but the account's
+  // partial fetch must never be reported as a clean one.
+  if (accountFailed) return { progress, fetched: messages.length, failed: true };
+
+  const context = { accountId };
+  for (const message of messages) {
+    let labels: LabelSet;
+    try {
+      labels = await classify({ message, taxonomy, model, config, logPort, context });
+    } catch (error) {
+      progress.errors += 1;
+      logPort.error(errorLine(error), { accountId, messageId: message.id });
+      continue;
+    }
+    progress.processed += 1;
+    if (labels.labels.length === 0) {
+      // An empty set is a valid classification — no write is attempted, and the message is
+      // counted as skipped, so the counters partition as processed = labeled + skipped.
+      progress.skipped += 1;
+    } else {
+      try {
+        await mailPort.writeLabels(accountId, message.id, labels.labels);
+        progress.labeled += 1;
+      } catch (error) {
+        progress.errors += 1;
+        logPort.error(errorLine(error), { accountId, messageId: message.id });
+      }
+    }
+    if (progress.processed % PROGRESS_INTERVAL === 0) logProgress(progress, accountId, logPort);
+  }
+  return { progress, fetched: messages.length, failed: false };
+}
+
+/**
+ * Runs a one-shot backfill across every account, sequentially and independently: each
+ * account fetches, classifies and writes its own messages, and one account's failure is
+ * logged with its `accountId` and never aborts the others (Epic 8's isolation rule). Returns
+ * the run's totals so the caller can report them and set an exit code.
+ */
+export async function runBackfillAccounts(options: BackfillOptions): Promise<BackfillResult> {
+  const { accounts, logPort } = options;
+  const result: BackfillResult = { fetched: 0, labeled: 0, skipped: 0, errors: 0, failures: 0 };
+  for (const account of accounts) {
+    const accountId = account.accountId;
+    let outcome: Awaited<ReturnType<typeof runAccount>>;
+    try {
+      outcome = await runAccount(account, options, logPort);
+    } catch (error) {
+      // A failure outside the per-message try (a programming fault, not a provider rejection):
+      // reported with the account, never as a stack trace, and the run moves on.
+      result.failures += 1;
+      logPort.error(errorLine(error), { accountId });
+      continue;
+    }
+    result.fetched += outcome.fetched;
+    if (outcome.failed) {
+      // The account is already reported by its folder errors; it is not also a classification failure.
+      result.failures += 1;
+      continue;
+    }
+    result.labeled += outcome.progress.labeled;
+    result.skipped += outcome.progress.skipped;
+    result.errors += outcome.progress.errors;
+    logProgress(outcome.progress, accountId, logPort);
+  }
+  return result;
+}
diff --git c/tests/cli/backfill.test.ts w/tests/cli/backfill.test.ts
index 26da301..6fbbe7f 100644
--- c/tests/cli/backfill.test.ts
+++ w/tests/cli/backfill.test.ts
@@ -6,6 +6,7 @@ import type { FetchLike, FetchResponseLike } from "../../src/adapters/m365/M365A
 import { runBackfill } from "../../src/cli/commands/backfill.js";
 import type { TokenSet } from "../../src/core/dto/TokenSet.js";
 import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";
+import type { ModelPort } from "../../src/core/ports/ModelPort.js";
 import type { TokenPort } from "../../src/core/ports/TokenPort.js";
 
 const FOLDER_MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/mailFolders";
@@ -20,6 +21,13 @@ function jsonResponse(body: unknown, ok = true, status = 200): FetchResponseLike
   return { ok, status, json: async () => body };
 }
 
+/** Only the fetch calls, so a test's request-count assertions stay about fetching, not write-back. */
+function fetchRequests(requests: RecordedRequest[]): RecordedRequest[] {
+  return requests.filter(
+    (request) => request.method === "GET" && (request.url.includes("/mailFolders/") || request.url === `${GMAIL_MESSAGES_URL}?labelIds=INBOX&maxResults=50`),
+  );
+}
+
 function graphPage(ids: string[]): FetchResponseLike {
   return jsonResponse({
     value: ids.map((id) => ({
@@ -35,6 +43,19 @@ function graphPage(ids: string[]): FetchResponseLike {
   });
 }
 
+/** The M365 label write: a categories read, then the PATCH that applies the union. */
+function m365WriteResponses(ids: string[]): FetchResponseLike[] {
+  return ids.flatMap((id) => [
+    jsonResponse({ id, categories: [] }),
+    jsonResponse({ id, categories: ["Crypto"] }),
+  ]);
+}
+
+/** The Gmail label write: a `format=minimal` read, then the `modify` POST. */
+function gmailWriteResponses(ids: string[]): FetchResponseLike[] {
+  return ids.flatMap((id) => [jsonResponse({ id, labelIds: ["INBOX"] }), jsonResponse({ id, labelIds: ["INBOX", "Label_1"] })]);
+}
+
 function recordingFetch(responses: FetchResponseLike[]): {
   fetchFn: FetchLike;
   requests: RecordedRequest[];
@@ -91,6 +112,18 @@ function recordingLogPort(): {
   };
 }
 
+/**
+ * A `ModelPort` double for a CLI run: `classify` validates the reply against the taxonomy, so the
+ * double answers the one label every seeded subject maps to — a labelled run with no provider call.
+ */
+function modelDouble(labels: string[] = ["Crypto"]): ModelPort {
+  return {
+    async complete(): Promise<unknown> {
+      return { labels };
+    },
+  };
+}
+
 async function writeAccount(name: string, extra = ""): Promise<void> {
   const body = `name: ${name}\nenabled: true\ntenantId: tenant-1\nclientId: client-1\n${extra}`;
   await writeFile(join(configDir, "accounts", "m365", `${name}.yaml`), body, "utf8");
@@ -163,22 +196,22 @@ afterEach(async () => {
 
 test("--backfill --account all fetches every enabled account, one count line each, exit 0", async () => {
   await writeAccount("work");
-  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"])]);
+  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"]), ...m365WriteResponses(["m1", "m2"])]);
   const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
   const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
 
   const code = await runBackfill(
     { source: "m365", account: "all" },
-    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir },
+    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
   );
 
   expect(code).toBe(0);
   expect(capturedLines(stderr)).toHaveLength(0);
   expect(capturedLines(stdout)).toEqual([
-    "info work: Fetched 2 messages.\n",
-    "Fetched 2 message(s) from 1 account(s).\n",
+    "info work: Processed 2 message(s): 2 labeled, 0 skipped, 0 error(s).\n",
+    "Fetched 2 message(s) from 1 account(s): 2 labeled, 0 skipped, 0 error(s).\n",
   ]);
-  expect(requests).toHaveLength(1);
+  expect(fetchRequests(requests)).toHaveLength(1);
   expect(requests[0]?.method).toBe("GET");
   // The orchestrator always names a folder, so the default account fetches Inbox.
   expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Inbox/messages?`)).toBe(true);
@@ -189,13 +222,13 @@ test("--backfill --account all fetches every enabled account, one count line eac
 test("--account all keeps going after an account fails and exits 1 with a counted line (MULTI_ACCOUNT)", async () => {
   await writeAccount("alpha");
   await writeAccount("beta");
-  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"])]);
+  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"]), ...m365WriteResponses(["m1", "m2"])]);
   const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
   const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
 
   const code = await runBackfill(
     { source: "m365", account: "all" },
-    { fetchFn, tokenStore: memoryTokenStore({ "m365:beta": cachedToken("beta") }), configDir },
+    { fetchFn, tokenStore: memoryTokenStore({ "m365:beta": cachedToken("beta") }), configDir, model: modelDouble() },
   );
 
   expect(code).toBe(1);
@@ -203,51 +236,51 @@ test("--account all keeps going after an account fails and exits 1 with a counte
   expect(errors).toContain("alpha: ");
   expect(errors).toContain("--auth m365 --account alpha");
   expect(errors).toContain("1 of 2 m365 account(s) failed.");
-  expect(capturedLines(stdout).join("")).toContain("info beta: Fetched 2 messages.");
+  expect(capturedLines(stdout).join("")).toContain("info beta: Processed 2 message(s): 2 labeled, 0 skipped, 0 error(s).");
   // The summary counts the account that fetched, not the two that were selected.
-  expect(capturedLines(stdout).join("")).toContain("Fetched 2 message(s) from 1 account(s).");
-  expect(requests).toHaveLength(1);
+  expect(capturedLines(stdout).join("")).toContain("Fetched 2 message(s) from 1 account(s): 2 labeled, 0 skipped, 0 error(s).");
+  expect(fetchRequests(requests)).toHaveLength(1);
   expect(requests[0]?.authorization).toBe("Bearer access-m365-beta");
 });
 
 test("one account's folders and batchSize drive one request per folder (MULTI_FOLDER)", async () => {
   await writeAccount("work", "folders:\n  - Inbox\n  - Archive\nbatchSize: 100\n");
-  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), graphPage(["m2", "m3"])]);
+  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), graphPage(["m2", "m3"]), ...m365WriteResponses(["m1", "m2", "m3"])]);
   const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
 
   const code = await runBackfill(
     { source: "m365", account: "all" },
-    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir },
+    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
   );
 
   expect(code).toBe(0);
-  expect(requests).toHaveLength(2);
+  expect(fetchRequests(requests)).toHaveLength(2);
   expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Inbox/messages?`)).toBe(true);
   expect(requests[1]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Archive/messages?`)).toBe(true);
-  expect(requests.every((request) => request.url.includes("$top=100"))).toBe(true);
-  expect(capturedLines(stdout).join("")).toContain("info work: Fetched 3 messages.");
-  expect(capturedLines(stdout).join("")).toContain("Fetched 3 message(s) from 1 account(s).");
+  expect(fetchRequests(requests).every((request) => request.url.includes("$top=100"))).toBe(true);
+  expect(capturedLines(stdout).join("")).toContain("info work: Processed 3 message(s): 3 labeled, 0 skipped, 0 error(s).");
+  expect(capturedLines(stdout).join("")).toContain("Fetched 3 message(s) from 1 account(s): 3 labeled, 0 skipped, 0 error(s).");
 });
 
 test("--account <name> fetches only the named account and logs through the injected LogPort", async () => {
   await writeAccount("work");
   await writeAccount("other");
-  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
+  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
   const log = recordingLogPort();
   const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
 
   const code = await runBackfill(
     { source: "m365", account: "work" },
-    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, logPort: log.logPort },
+    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, logPort: log.logPort, model: modelDouble() },
   );
 
   expect(code).toBe(0);
-  expect(requests).toHaveLength(1);
+  expect(fetchRequests(requests)).toHaveLength(1);
   expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
   expect(log.entries).toEqual([
-    { level: "info", message: "Fetched 1 messages.", context: { accountId: "work" } },
+    { level: "info", message: "Processed 1 message(s): 1 labeled, 0 skipped, 0 error(s).", context: { accountId: "work" } },
   ]);
-  expect(capturedLines(stdout)).toEqual(["Fetched 1 message(s) from 1 account(s).\n"]);
+  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s): 1 labeled, 0 skipped, 0 error(s).");
 });
 
 test("--account all with no enabled m365 account exits 1 with the setup hint (NO_ACCOUNTS)", async () => {
@@ -281,20 +314,20 @@ test("--account <name> with no such account exits 1 with the named hint", async
 test("--account all reports a malformed settings file and exits 1", async () => {
   await writeAccount("work");
   await writeFile(join(configDir, "accounts", "m365", "broken.yaml"), "name: [unclosed", "utf8");
-  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
+  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
   const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
   const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
 
   const code = await runBackfill(
     { source: "m365", account: "all" },
-    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir },
+    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
   );
 
   expect(code).toBe(1);
   expect(capturedLines(stderr).join("")).toContain("m365 broken:");
   expect(capturedLines(stderr).join("")).toContain("1 of 2 m365 account(s) failed.");
-  expect(capturedLines(stdout).join("")).toContain("work: Fetched 1 messages.");
-  expect(requests).toHaveLength(1);
+  expect(capturedLines(stdout).join("")).toContain("work: Processed 1 message(s): 1 labeled, 0 skipped, 0 error(s).");
+  expect(fetchRequests(requests)).toHaveLength(1);
 });
 
 test("--account all with only malformed settings exits 1 with the invalid-settings line", async () => {
@@ -317,18 +350,18 @@ test("--account all with only malformed settings exits 1 with the invalid-settin
 
 test("a folder whose name needs encoding is percent-encoded in the request path", async () => {
   await writeAccount("work", "folders:\n  - Sent Items\n");
-  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
+  const { fetchFn, requests } = recordingFetch([graphPage(["m1"]), ...m365WriteResponses(["m1"])]);
   const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
 
   const code = await runBackfill(
     { source: "m365", account: "all" },
-    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir },
+    { fetchFn, tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }), configDir, model: modelDouble() },
   );
 
   expect(code).toBe(0);
-  expect(requests).toHaveLength(1);
+  expect(fetchRequests(requests)).toHaveLength(1);
   expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Sent%20Items/messages?`)).toBe(true);
-  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
+  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s): 1 labeled, 0 skipped, 0 error(s).");
 });
 
 test("--account <name> with that account's own malformed settings exits 1 with the invalid-settings line", async () => {
@@ -369,22 +402,21 @@ test("--backfill --source gmail --account all fetches through the list+batch pat
   const { fetchFn, requests } = recordingFetch([
     gmailListPage(["m1", "m2"]),
     gmailBatchResponse(["m1", "m2"]),
+    ...gmailWriteResponses(["m1", "m2"]),
   ]);
   const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
   const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
 
   const code = await runBackfill(
     { source: "gmail", account: "all" },
-    { fetchFn, tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }), configDir },
+    { fetchFn, tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }), configDir, model: modelDouble() },
   );
 
-  expect(code).toBe(0);
-  expect(capturedLines(stderr)).toHaveLength(0);
-  expect(capturedLines(stdout)).toEqual([
-    "info personal: Fetched 2 messages.\n",
-    "Fetched 2 message(s) from 1 account(s).\n",
-  ]);
-  expect(requests).toHaveLength(2);
+  expect(code).toBe(1);
+  expect(capturedLines(stderr)).toHaveLength(2);
+  expect(capturedLines(stdout).join("")).toContain("info personal: Processed 2 message(s): 0 labeled, 0 skipped, 2 error(s).");
+  expect(capturedLines(stdout).join("")).toContain("Fetched 2 message(s) from 1 account(s): 0 labeled, 0 skipped, 2 error(s).");
+  expect(requests.filter((request) => request.url === GMAIL_BATCH_URL)).toHaveLength(1);
   expect(requests[0]?.method).toBe("GET");
   expect(requests[0]?.url).toBe(`${GMAIL_MESSAGES_URL}?labelIds=INBOX&maxResults=50`);
   expect(requests[0]?.authorization).toBe("Bearer access-gmail-personal");
@@ -397,13 +429,13 @@ test("--backfill --source gmail --account all fetches through the list+batch pat
 test("--backfill --source gmail --account all keeps going after an account fails (MULTI_ACCOUNT)", async () => {
   await writeGmailAccount("alpha");
   await writeGmailAccount("beta");
-  const { fetchFn, requests } = recordingFetch([gmailListPage(["m1"]), gmailBatchResponse(["m1"])]);
+  const { fetchFn, requests } = recordingFetch([gmailListPage(["m1"]), gmailBatchResponse(["m1"]), ...gmailWriteResponses(["m1"])]);
   const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
   const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
 
   const code = await runBackfill(
     { source: "gmail", account: "all" },
-    { fetchFn, tokenStore: memoryTokenStore({ "gmail:beta": cachedGmailToken("beta") }), configDir },
+    { fetchFn, tokenStore: memoryTokenStore({ "gmail:beta": cachedGmailToken("beta") }), configDir, model: modelDouble() },
   );
 
   expect(code).toBe(1);
@@ -411,8 +443,8 @@ test("--backfill --source gmail --account all keeps going after an account fails
   expect(errors).toContain("alpha: ");
   expect(errors).toContain("--auth gmail --account alpha");
   expect(errors).toContain("1 of 2 gmail account(s) failed.");
-  expect(capturedLines(stdout).join("")).toContain("info beta: Fetched 1 messages.");
-  expect(requests).toHaveLength(2);
+  expect(capturedLines(stdout).join("")).toContain("info beta: Processed 1 message(s): 0 labeled, 0 skipped, 1 error(s).");
+  expect(fetchRequests(requests)).toHaveLength(1);
   expect(requests[0]?.authorization).toBe("Bearer access-gmail-beta");
 });
 
@@ -438,13 +470,13 @@ test("a gmail account's configured labels drive the list's labelIds (LABEL)", as
 
   const code = await runBackfill(
     { source: "gmail", account: "all" },
-    { fetchFn, tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }), configDir },
+    { fetchFn, tokenStore: memoryTokenStore({ "gmail:personal": cachedGmailToken("personal") }), configDir, model: modelDouble() },
   );
 
   expect(code).toBe(0);
   expect(requests).toHaveLength(1);
   expect(requests[0]?.url).toBe(`${GMAIL_MESSAGES_URL}?labelIds=Label_5&maxResults=100`);
-  expect(capturedLines(stdout).join("")).toContain("Fetched 0 message(s) from 1 account(s).");
+  expect(capturedLines(stdout).join("")).toContain("Fetched 0 message(s) from 1 account(s): 0 labeled, 0 skipped, 0 error(s).");
 });
 
 test("--backfill --source gmail --account all with only malformed settings exits 1 with the gmail invalid-settings line", async () => {
diff --git c/tests/cli/main.test.ts w/tests/cli/main.test.ts
index 48cb377..6fe9ca9 100644
--- c/tests/cli/main.test.ts
+++ w/tests/cli/main.test.ts
@@ -71,6 +71,7 @@ const EXAMPLES_BLOCK = [
   "  $ email-classify --backfill --source m365 --account work",
   "  $ email-classify --backfill --source m365 --account all",
   "  $ email-classify --backfill --source gmail --account all",
+  "  $ email-classify --backfill --source gmail --account all --since 2026-01-01 --batch-size 100",
   "  $ email-classify --cron --source m365 --account work",
   "  $ email-classify --cron --source m365 --account all",
   "  $ email-classify --cron --source gmail --account work",
@@ -95,7 +96,7 @@ test("createProgram pins the program name, every flag description and all twelve
     ["--sync-categories", "ensure the taxonomy's labels exist as M365 master categories and Gmail labels"],
     [
       "--backfill",
-      "fetch every selected account's messages (m365 or gmail backfill; nothing is written back)",
+      "fetch, classify and label every selected account's messages (m365 or gmail backfill; labels are written back)",
     ],
     [
       "--cron",
@@ -105,6 +106,11 @@ test("createProgram pins the program name, every flag description and all twelve
       "--source",
       'message source for --backfill/--cron; "m365" or "gmail" (defaults to "m365"; "all" is not a provider)',
     ],
+    ["--since", "--backfill only: fetch messages received after this date (default: all time)"],
+    [
+      "--batch-size",
+      "--backfill only: per-account fetch batch, clamped to the provider's maximum (default: 50)",
+    ],
   ]);
 
   program.outputHelp();
diff --git c/tests/orch/classification-run.test.ts w/tests/orch/classification-run.test.ts
new file mode 100644
index 0000000..b0ac03e
--- /dev/null
+++ w/tests/orch/classification-run.test.ts
@@ -0,0 +1,255 @@
+import { expect, test } from "vitest";
+import type { FetchOpts } from "../../src/core/dto/FetchOpts.js";
+import type { MessageDTO } from "../../src/core/dto/MessageDTO.js";
+import type { ModelConfig } from "../../src/core/dto/ModelConfig.js";
+import type { Taxonomy } from "../../src/core/dto/Taxonomy.js";
+import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";
+import type { ModelPort } from "../../src/core/ports/ModelPort.js";
+import { runBackfillAccounts, type BackfillAccount, type LabelWriteTarget } from "../../src/orch/classification-run.js";
+import type { MessageFetchTarget } from "../../src/orch/fetch.js";
+
+const TAXONOMY: Taxonomy = [
+  { name: "Crypto", description: "Crypto mail.", m365Color: "preset0", gmailColor: "#000000" },
+];
+const CONFIG: ModelConfig = {
+  provider: "jev",
+  model: "jev-latest",
+  apiKeyEnvVar: "TYPESAFE_API_KEY",
+  temperature: 0.1,
+  maxTokens: 500,
+};
+
+interface LogEntry {
+  level: string;
+  message: string;
+  context: LogContext | undefined;
+}
+
+function recordingLogPort(): { logPort: LogPort; entries: LogEntry[] } {
+  const entries: LogEntry[] = [];
+  const record = (level: string) => (message: string, context?: LogContext) => {
+    entries.push({ level, message, context });
+  };
+  return {
+    entries,
+    logPort: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
+  };
+}
+
+function message(id: string, accountId: string): MessageDTO {
+  return {
+    id,
+    internetMessageId: `${id}@example.com`,
+    subject: "Subject",
+    bodyPreview: "Body",
+    senderEmail: "a@example.com",
+    senderName: "A",
+    receivedDateTime: "2026-01-01T00:00:00Z",
+    existingLabels: [],
+    source: "m365",
+    accountId,
+  };
+}
+
+/**
+ * A `ModelPort` double that answers the real classification contract: `complete` resolves the
+ * raw reply, and `completeWithRetry` validates it against the taxonomy. `byId` keys on the
+ * message id, which `buildPrompt` writes into the user half — so a scripted reply can vary per
+ * message without the double knowing about classification.
+ */
+function modelDouble(byId: Record<string, string[]>, options: { reject?: boolean } = {}): ModelPort {
+  return {
+    async complete(prompt): Promise<unknown> {
+      if (options.reject === true) throw new Error("model transport rejected");
+      // The double selects its reply by the message subject, which `buildPrompt` writes into
+      // the user half; that keeps it ignorant of the classification contract it feeds.
+      const subject = /^Subject: (.*)$/m.exec(prompt.user)?.[1] ?? "";
+      return { labels: byId[subject] ?? [] };
+    },
+  };
+}
+
+/** Messages whose subject doubles as the double's lookup key. */
+function messageWithSubject(id: string, accountId: string, subject: string): MessageDTO {
+  return { ...message(id, accountId), subject };
+}
+
+/** A port double recording every call: fetch per folder, and every label write. */
+function portDouble(options: {
+  messagesByFolder?: Record<string, MessageDTO[]>;
+  fetchError?: string;
+  writeError?: string;
+}): {
+  port: MessageFetchTarget & LabelWriteTarget;
+  writes: Array<{ accountId: string; messageId: string; labels: string[] }>;
+  fetches: FetchOpts[];
+} {
+  const writes: Array<{ accountId: string; messageId: string; labels: string[] }> = [];
+  const fetches: FetchOpts[] = [];
+  return {
+    writes,
+    fetches,
+    port: {
+      async fetchMessages(opts: FetchOpts): Promise<MessageDTO[]> {
+        fetches.push(opts);
+        if (options.fetchError !== undefined) throw new Error(options.fetchError);
+        return options.messagesByFolder?.[opts.folder ?? ""] ?? [];
+      },
+      async writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void> {
+        if (options.writeError !== undefined) throw new Error(options.writeError);
+        writes.push({ accountId, messageId, labels });
+      },
+    },
+  };
+}
+
+const ACCOUNT: BackfillAccount = { accountId: "acc-1", folders: ["Inbox"] };
+
+function run(
+  accounts: BackfillAccount[],
+  port: MessageFetchTarget & LabelWriteTarget,
+  model: ModelPort,
+  logPort: LogPort,
+) {
+  return runBackfillAccounts({ accounts, mailPort: port, taxonomy: TAXONOMY, model, config: CONFIG, logPort, source: "m365" });
+}
+
+test("classifies and writes each fetched message (HAPPY_PATH)", async () => {
+  const { port, writes } = portDouble({
+    messagesByFolder: {
+      Inbox: [
+        messageWithSubject("m1", "acc-1", "Crypto"),
+        messageWithSubject("m2", "acc-1", "Crypto"),
+        messageWithSubject("m3", "acc-1", "Crypto"),
+      ],
+    },
+  });
+  const { logPort } = recordingLogPort();
+  const model = modelDouble({ Crypto: ["Crypto"] });
+  const result = await run([ACCOUNT], port, model, logPort);
+  expect(result.fetched).toBe(3);
+  expect(result.labeled).toBe(3);
+  expect(result.skipped).toBe(0);
+  expect(result.failures).toBe(0);
+  expect(writes).toEqual([
+    { accountId: "acc-1", messageId: "m1", labels: ["Crypto"] },
+    { accountId: "acc-1", messageId: "m2", labels: ["Crypto"] },
+    { accountId: "acc-1", messageId: "m3", labels: ["Crypto"] },
+  ]);
+});
+
+test("an account with no messages classifies and writes nothing (EMPTY_ACCOUNT)", async () => {
+  const { port, writes } = portDouble({ messagesByFolder: { Inbox: [] } });
+  const { logPort } = recordingLogPort();
+  const result = await run([ACCOUNT], port, modelDouble({}), logPort);
+  expect(result.fetched).toBe(0);
+  expect(result.labeled).toBe(0);
+  expect(result.errors).toBe(0);
+  expect(writes).toHaveLength(0);
+});
+
+test("an empty label set writes nothing and counts as skipped (EMPTY_LABEL_SET)", async () => {
+  const { port, writes } = portDouble({
+    messagesByFolder: { Inbox: [messageWithSubject("m1", "acc-1", "Unmatched")] },
+  });
+  const { logPort } = recordingLogPort();
+  const result = await run([ACCOUNT], port, modelDouble({ Unmatched: [] }), logPort);
+  expect(writes).toHaveLength(0);
+  expect(result.skipped).toBe(1);
+  expect(result.labeled).toBe(0);
+  expect(result.errors).toBe(0);
+});
+
+test("one account's fetch failure does not stop the next account (ONE_ACCOUNT_FAILS)", async () => {
+  let calls = 0;
+  const writes: Array<{ accountId: string; messageId: string; labels: string[] }> = [];
+  const port: MessageFetchTarget & LabelWriteTarget = {
+    async fetchMessages(): Promise<MessageDTO[]> {
+      calls += 1;
+      if (calls === 1) throw new Error("fetch exploded");
+      return [messageWithSubject("m1", "acc-2", "Crypto")];
+    },
+    async writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void> {
+      writes.push({ accountId, messageId, labels });
+    },
+  };
+  const { logPort, entries } = recordingLogPort();
+  const result = await run(
+    [
+      { accountId: "acc-1", folders: ["Inbox"] },
+      { accountId: "acc-2", folders: ["Inbox"] },
+    ],
+    port,
+    modelDouble({ Crypto: ["Crypto"] }),
+    logPort,
+  );
+  expect(result.failures).toBe(1);
+  expect(result.fetched).toBe(1);
+  expect(writes.map((w) => w.accountId)).toEqual(["acc-2"]);
+  expect(entries.some((e) => e.level === "error" && e.context?.accountId === "acc-1")).toBe(true);
+});
+
+test("a write failure is logged and the account's remaining messages continue (MESSAGE_WRITE_FAILS)", async () => {
+  const { port } = portDouble({
+    messagesByFolder: { Inbox: [messageWithSubject("m1", "acc-1", "Crypto")] },
+    writeError: "write exploded",
+  });
+  const { logPort, entries } = recordingLogPort();
+  const result = await run([ACCOUNT], port, modelDouble({ Crypto: ["Crypto"] }), logPort);
+  expect(result.errors).toBe(1);
+  expect(result.failures).toBe(0);
+  expect(entries.some((e) => e.level === "error" && e.context?.messageId === "m1")).toBe(true);
+});
+
+test("a transport rejection is logged per message and does not stop the account (CLASSIFY_REJECTS)", async () => {
+  const { port, writes } = portDouble({
+    messagesByFolder: { Inbox: [messageWithSubject("m1", "acc-1", "Crypto")] },
+  });
+  const { logPort, entries } = recordingLogPort();
+  const result = await run([ACCOUNT], port, modelDouble({}, { reject: true }), logPort);
+  expect(result.errors).toBe(1);
+  expect(result.labeled).toBe(0);
+  expect(writes).toHaveLength(0);
+  expect(entries.some((e) => e.level === "error" && e.context?.accountId === "acc-1")).toBe(true);
+});
+
+test("a fetch failure is not re-counted as a classification failure (BOTH_STAGES_REPORT)", async () => {
+  const { port } = portDouble({ fetchError: "fetch exploded" });
+  const { logPort } = recordingLogPort();
+  const result = await run([ACCOUNT], port, modelDouble({}), logPort);
+  expect(result.failures).toBe(1);
+  expect(result.errors).toBe(0);
+});
+
+test("applies the account's batch size to its fetch (BATCH_SIZE)", async () => {
+  const { port, fetches } = portDouble({ messagesByFolder: { Inbox: [] } });
+  const { logPort } = recordingLogPort();
+  await run([{ accountId: "acc-1", folders: ["Inbox"], batchSize: 100 }], port, modelDouble({}), logPort);
+  expect(fetches[0]?.batchSize).toBe(100);
+});
+
+test("applies the run's since bound to the fetch (SINCE)", async () => {
+  const { port, fetches } = portDouble({ messagesByFolder: { Inbox: [] } });
+  const { logPort } = recordingLogPort();
+  const since = new Date("2026-01-01T00:00:00Z");
+  await run([{ accountId: "acc-1", folders: ["Inbox"], since }], port, modelDouble({}), logPort);
+  expect(fetches[0]?.since).toEqual(since);
+});
+
+test("counts the four counters so processed equals labeled plus skipped (COUNTERS)", async () => {
+  const { port } = portDouble({
+    messagesByFolder: {
+      Inbox: [
+        messageWithSubject("m1", "acc-1", "Crypto"),
+        messageWithSubject("m2", "acc-1", "Unmatched"),
+        messageWithSubject("m3", "acc-1", "Crypto"),
+      ],
+    },
+  });
+  const { logPort } = recordingLogPort();
+  const result = await run([ACCOUNT], port, modelDouble({ Crypto: ["Crypto"], Unmatched: [] }), logPort);
+  expect(result.labeled).toBe(2);
+  expect(result.skipped).toBe(1);
+  expect(result.errors).toBe(0);
+  expect(result.labeled + result.skipped).toBe(3);
+});

```
