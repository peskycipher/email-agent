---
title: 'Story 6.4: Single-Call Classification Function'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'f871ea1bef6402fa25aa8ab491f35f6003853758'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** the engine's three parts exist but nothing composes them: 6.1's `buildPrompt` (pure core), 6.2's `completeWithRetry` (validated conversation, adapter land), 6.3's adapters + factory (model I/O) — so 6.2 shipped against a stub port and no message has ever been classified end to end. Every later epic (7 write-back, 8 backfill/cron, 10 cost metrics) blocks on the composed unit.

**Approach:** one `classify` function per message: build the prompt from 6.1's template against the merged frozen taxonomy, drive the model through 6.3's adapter, validate and retry through 6.2's bounded conversation, return a validated `LabelSet` (or `{ labels: [] }` on exhaustion). The port and log are injected — `classify` itself stays free of provider and logging machinery.

**Decisions (human, 2026-10-09):**
6. **Placement — `src/orch/classify.ts` (Open Question A).** orch is the application-composition layer that already composes ports (`orch/sync.ts`, `orch/fetch.ts`); Epic 8's consumers live in the same layer. The spine's source-tree file-path cell for Classification is reconciled (reconcile-first, as in 6.3), while AD-1's intent — pure engine logic in core, all I/O via injected port/logger — survives untouched. The unit is **not** exported from the adapters barrel (orch units are imported directly, per the `tests/orch` idiom).
7. **Signature — options object (party amendment 1, human-confirmed 2026-10-09, and again on review when the field was renamed — the 6.2 precedent):** `classify(options: ClassifyOptions)` where `ClassifyOptions = { message: MessageDTO; taxonomy: Taxonomy; model: ModelPort; config: ModelConfig; logPort: LogPort; context?: LogContext }` (the logger field follows the orch layer's convention — `fetch.ts:28`, `sync.ts:14`; the `completeWithRetry` passthrough maps `logPort: log`) — the repo's established seams-object idiom (`CompleteWithRetryOptions`, `SyncCategoriesOptions`); the spine AD-1 trio (message, taxonomy, modelConfig) is the options object's story, with the port/logger plumbing alongside.

## Boundaries & Constraints

**Always:**
- One classification attempt = exactly one `ModelPort.complete` call; no chaining, no tool use, no second model (the epic's "single-call" invariant). The attempt budget stays 6.2's frozen ≤3.
- The message and the frozen taxonomy are never mutated; `buildPrompt` is reused unchanged (6.1: truncation to 2000 chars is the builder's job).
- Validation exhaustion yields `{ labels: [] }` — never a throw, never a partially-valid set (6.2's frozen semantics); transport failures re-throw unwrapped to the caller (PRD FR-1: the orchestrator re-queues; an outage must not read as a valid empty classification).
- The caller owns `LogPort` and any `LogContext` (accountId, message id) — the engine's exhaust-path error log flows through the injected logger; the core emits nothing directly.
- Every test is stdlib-only (stub `ModelPort`, stub/canned clients per 6.3's suites); no live network; `mise exec node@20 -- bun run test|lint|build` all exit 0.

**Never:**
- AD-10: whatever layer hosts `classify`, core imports nothing from adapters/orch/cli; no `zod` in core; no new runtime dependency.
- No retry/backoff policy of its own (Epic 9 owns provider backoff; 6.2's validation budget is the frozen exception).
- No idempotency, write-back, account iteration, or CLI wiring (Epic 7/8/11). No timing/latency instrumentation beyond what ships in 6.3 (the <3s p95 is a PRD target, not code here). No eval harness.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY multi-label | message + 3-label taxonomy; adapter answers Crypto 0.9, Business 0.6, Noise 0.01 | `{ labels: ["Crypto", "Business"] }` after one adapter call; usage logged | n/a |
| EMPTY CLASSIFIED | adapter answers all below threshold | `{ labels: [] }` — valid, no error log (6.2 owns verdict logging) | n/a |
| MALFORMED REPLY | adapter returns e.g. `{labels:"x"}` then valid | retried within the ≤3 budget; exhaustion → `{ labels: [] }` + one structured error (raw + reason + message context) | soft |
| TRANSPORT FAILURE | adapter's `complete` rejects | re-throw unwrapped; no `{ labels: [] }` fallback | caller re-queues (FR-1) |
| PER-MESSAGE FLOW | backfill-style loop over N messages, account b's model call fails on message 2 | messages 1..3 still classified (no batch abort — the epic's "failures degrade gracefully") | per-message error, batch continues |

</frozen-after-approval>

## Code Map

- `src/core/skill/prompt.ts:103` — `buildPrompt(message, taxonomy): PromptParts`; the 6.1 builder; reuse unchanged.
- `src/adapters/model/labelSetValidation.ts:97-115` — `completeWithRetry(options)` + `CompleteWithRetryOptions{model, prompt: PromptParts, config, taxonomy, log, context?}`; the conversation unit to compose; byte-stable per 6.2's frozen review.
- `src/adapters/model/modelAdapterFactory.ts` — `createModelAdapter(config, deps)`, `defaultModelClientFactories`, `requireEnvApiKey`, `DEFAULT_MODEL_CONFIG` — the wiring seams the caller composes; the unit tests inject a stub `ModelPort` directly (and, for the HAPPY row, the real `JevAdapter` over a stub `JevClient` à la the 6.3 suite); the factory composition itself is exercised only by the manual probe.
- `src/core/ports/ModelPort.ts:16` — `complete(prompt: PromptParts, taxonomy, config): Promise<unknown>`; the untrusted-reply boundary.
- `src/orch/sync.ts` / `src/orch/fetch.ts` — the layer idiom to follow (options objects, typed seams, no SDK imports; placement decided, A).
- `tests/orch/sync.test.ts`, `tests/adapters/model/label-set-validation.test.ts` (`scriptedModel`, `recordingLogPort`) — the two test idioms to reuse; `tests/adapters/model/jev-adapter.test.ts` (`stubJevClient`) — the stub-client idiom for the HAPPY row.
- Spine AD-1 (`:58-61`) + source-tree line (`:247`) — reconciled per the placement decision; `epic-6-context.md` regenerated with it (6.3's reconcile-first precedent, decision 5).

## Tasks & Acceptance

**Execution:**
- [x] Planning reconcile commit (FIRST in the series, Loki owns) — spine Classification source-tree line (`core/skill/classify.ts` → `orch/classify.ts`, decision 6) + `epic-6-context.md` updated.
- [x] `src/orch/classify.ts` (new) — `ClassifyOptions = { message; taxonomy; model: ModelPort; config: ModelConfig; log: LogPort; context?: LogContext }` and `classify(options): Promise<LabelSet>`: `buildPrompt(options.message, options.taxonomy)` → `completeWithRetry({model, prompt, config, taxonomy, log, context})`; nothing else (decision 7).
- [x] `tests/orch/classify.test.ts` (new) — one test per I/O-matrix row plus one multi-message no-abort test; stub `ModelPort` + recording `LogPort`; no SDK imports.

**Acceptance Criteria:**
- Given a message and a 3-label taxonomy with a stub adapter answering 0.9/0.6/0.01, when `classify` is called, then exactly one `complete` call happened and the result is `{ labels: ["Crypto", "Business"] }`.
- Given the stub's reply is all below the threshold, when `classify` is called, then `{ labels: [] }` resolves with no error log.
- Given a malformed reply followed by a valid one, when `classify` is called, then exactly two `complete` calls happen and the valid set is returned.
- Given exhaustion within the ≤3 budget, when `classify` is called, then `{ labels: [] }` resolves and exactly one structured error carries the raw reply, the reason and the caller's message context.
- Given a rejecting adapter, when `classify` is called, then the transport rejection propagates unwrapped — no empty-set fallback.
- Given a 3-message loop whose second message's adapter rejects, when the caller loops, then messages 1 and 3 classify and the batch continues (per-message, not batch, failure).
- Given the mise-pinned Node 20, when `bun run test`, `bun run lint`, and `bun run build` run, then all exit 0.

## Implementation Notes

_None yet — appended during implementation._

## Spec Change Log

_Empty until the first bad_spec loopback._

## Review Triage Log

**Loop iteration 0 (2026-10-09).** Three layers ran (blind-hunter, edge-case-hunter, verification-gap — the VG layer found none) over `f871ea1..HEAD`. Verdicts mine, re-verified against source. B = blind hunter, E = edge-case hunter.

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `epics.md`'s Story 6.4 AC (`:510-527`) still declares the 3-param positional `classify` + "pure: no I/O" — the reconcile skipped it (B) | medium | Verified: the reconcile commit touched the spine table row and the context doc, but `epics.md`'s own AC block still names a signature the code does not have. The reconcile task's fix — same precedent as 6.3's decision-5 reconcile of `epics.md`. | patch |
| 2 | Spine AD-1's rule line (`:64`), diagram (`:41`) and tree (`:186`) still render the positional/core placement (B) | medium | Same root as #1 — incomplete reconcile coverage within the series' own first commit; the spine is now internally inconsistent beyond the one cell that was fixed. | patch (grouped with #1) |
| 3 | `ClassifyOptions.log` vs every orch sibling's `logPort` naming — "introduces a third convention" (B) | low | The harm half is wrong (two conventions already existed: 6.2/6.3's frozen `log` vs 4.x orch's `logPort` — verified `fetch.ts:28`, `sync.ts:14`), but a *new orch unit* should follow its hosting layer's convention; field rename + destructure is direct. | patch |
| 4 | Code Map's barrel line is a dead conditional ("export the new unit if it lives in adapters") after decision 6 fixed the placement (B) | low | Verified: the conditional is unreachable text; agent-owned Code Map correction. | patch |
| 5 | Code Map claims tests "inject stub factories exactly as the 6.3 suites do"; the shipped test injects a stub `ModelPort` directly (B) | low | Verified: `tests/orch/classify.test.ts` never imports `createModelAdapter`; the factory claim describes the *manual probe*, not the unit tests. Code Map wording fix (agent-owned). | patch |
| 6 | Spec state stale in the diff: tasks `[ ]`, notes "None yet" (B) | false | Mid-flight ordering artifact: the ticks landed after the code commit and the triage log is written by this very pass; step-05 commits the current state. | reject (false) |
| 7 | Exhaustion test's per-message context is a shared constant, so per-message threading is "never actually supplied" (B) | false | `CONTEXT` carries the *message's own* `accountId`/`internetMessageId` and the test asserts both in the log entry — the passthrough is demonstrated; distinct-per-message threading is the Epic 8 caller's behavior, not this unit's. | reject (false) |
| 8 | "`4.4's SyncCategoriesOptions`" — no story 4.4 exists (B) | low | Verified: `orch/sync.ts` shipped in Story 4.1 (and 4.3); one-word citation fix in the source comment and the spec. | patch |
| 9 | Adapter-resolves-`undefined` edge untested (B) | low | Verified: a `ModelPort` completing `undefined` validates as malformed and exhausts to `{ labels: [] }`; the seed reason at `labelSetValidation.ts:98` is dead code (always overwritten by `verdict.reason` at `:106` — 6.2 triage row 5's harmless defensive default, as the child verified live); the logged reason is the Zod verdict. No test drives the edge — one test. | patch (test) |
| 10 | Spec file missing trailing newline (B) | low | Real diff artifact; siblings end with one. | patch |
| 11 | Empty taxonomy silently classifies everything `{labels:[]}` — guard in classify (E) | false | Unreachable: `loadTaxonomy` enforces 1–50 (`MIN_LABELS` throws, `src/adapters/config/taxonomy.ts:216-220`) and `buildPrompt`'s JSDoc pins the same contract; classify receives the frozen loader output — identical refutation to 6.3's triage. | reject (false) |
| 12 | Missing `bodyPreview`/`existingLabels` crashes deep in `buildUser` — boundary guard requested (E) | false | Unreachable from producers: both mappers degrade via `readString` to `""` (`m365/messageMapper.ts:4-8`, `gmail/messageMapper.ts` `snippet`) — `MessageDTO` fields are mapped, never missing; guarding `classify` against DTOs the mapper layer cannot produce double-guards a trust boundary that already exists. | reject (false) |
| 13 | `scriptedModel` with empty `responses` resolves undefined silently (E) | low | Test-local fixture helper; all six call sites pass ≥1; diverging the shared 6.2-idiom helper for a guard adds noise with no demonstrated failure. | reject (low) |
| 14 | AC 1's "stub adapter answering 0.9/0.6/0.01" — the test stubs post-threshold `{labels}` directly, so the probabilities path is never exercised by classify's suite (E, claim) | medium | Verified: true — the thresholding lives in `JevAdapter` (covered only with 2 labels in 6.3's suite). The AC is frozen, so the *test* comes to it: drive the real `JevAdapter` with a stub Jev client answering those probabilities through `classify`. | patch |

**Grouping (survivors → root causes):** #1+#2 (incomplete reconcile coverage); #4+#5 (stale/incorrect Code Map claims); #8+#10 (citation/newline doc hygiene); #3 (orch-layer naming); #9 (undefined-reply edge test); #14 (AC-1 probabilities wiring).

**Outcome:** eight patch entries (two medium roots), no `intent_gap`, no `bad_spec` — no loopback; `review_loop_iteration` stays 0. No defers.

## Design Notes

**The composition is deliberately two lines of logic.** `classify` owns no decisions of its own: the prompt rules are 6.1's, the conversation semantics are 6.2's, the wire formats are 6.3's. Its only job is handing the right pieces to the right parties — which is why the placement question (Open Question 1) matters more than the function body.

**Why the port and log are parameters, not imports:** AD-1's intent — "model access arrives as a `ModelPort` dependency, not an adapter import" — plus the epic's "the core emits nothing directly" keep the unit portable into any harness; the CLI/DI layer (Epic 11) constructs `createModelAdapter(config, { log, ...defaultModelClientFactories })` and hands it in.

**Latency and token observability** are Epic 10's: 6.3's adapter already logs usage per call; classify adds no timing of its own (the <3s p95 is a target recorded in the PRD, not an instrumented SLA).

## Verification

**Commands:**
- `mise exec node@20 -- bun run test` — expected: vitest green incl. the new classify suite, then `tsc --noEmit` green.
- `mise exec node@20 -- bun run lint` — expected: oxlint + core external-import guard exit 0 (AD-10 intact whatever layer hosts classify).
- `mise exec node@20 -- bun run build` — expected: `tsc -b` exit 0.

**Manual check (walkthrough):**
- One canned `MessageDTO` through the whole pipeline (`buildPrompt` → `createModelAdapter(config, { log, ...defaultModelClientFactories })` → `classify`), run as the 6.3-style `--input-type=module` probe against the real Jev API — expect one `systemOne` call, usage logged, and `{ labels: [...] }` in the validated shape. This exercises the *composed* pipeline, which no unit test does.
