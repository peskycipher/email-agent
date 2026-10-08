---
title: 'Story 4.1: Taxonomy Definition & User Overrides'
type: 'feature'
created: '2026-10-09'
status: 'done'
route: 'dispatch'
baseline_commit: '2d1a9a6551f4bc08068291b0314aa1e1079d806a'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The taxonomy exists only as types. `Taxonomy`/`LabelDef` (`src/core/dto/Taxonomy.ts`, `LabelDef.ts`) have no data behind them, no `taxonomy.yaml` exists in the repo, and nothing merges a user's edits or validates the name/bounds rules — so stories 4.2/4.3 and Epics 6/7 have no label universe to sync or classify against.

**Approach:** Ship the 11-label `taxonomy.yaml` at the repo root and add a Zod-validated loader in `adapters/config/taxonomy.ts` that reads it, applies the user's `taxonomyOverrides` (read from `config.yaml` by a temporary reader) with patch / add / drop semantics, enforces the bounds (1–50 labels, name pattern, unique names, color formats), and returns the frozen `Taxonomy` that the sync and classification stories consume.

## Boundaries & Constraints

**Always:**
- `taxonomy.yaml` ships the 11 defaults the AC lists (Action Needed … Real-estate), each with `name`, `description`, `m365Color` and `gmailColor`; its content is copied from `_bmad-output/specs/spec-email-classification-skill/taxonomy.yaml` (human-owned — copy it, never edit it).
- Merged result rules: 1–50 labels; every `name` matches `LABEL_NAME_PATTERN` `/^[A-Za-z0-9 /&'-]+$/`; no duplicate names (exact, case-sensitive) after merge; `m365Color` matches `/^preset(?:[0-9]|1[0-9]|2[0-4])$/`; `gmailColor` matches `/^#[0-9A-Fa-f]{6}$/`.
- **Override semantics (human decision, 2026-10-09):** `taxonomyOverrides[]` is keyed by `name`. A matched entry patches the fields it lists and keeps the rest of that default; a matched entry with no other field *drops* that default; an unmatched name *adds* a label and must supply all three other fields. A rename is therefore a drop plus an add, which is what "removed labels stay in the mailbox" already implies.
- **Override source (human decision, 2026-10-09):** `taxonomyOverrides` is read from `~/.config/email-classify/config.yaml` by a temporary single-file reader (path injectable; the Story 2.1/3.1 pattern, deleted by Epic 11).
- Load once, validate, then freeze: the returned array **and every entry in it** are `Object.freeze`d.
- `src/core/**` gains only the `LABEL_NAME_PATTERN` constant — no other core change and no `zod` in core (AD-10).
- Errors are typed at the loader boundary (`TaxonomyError` carrying a code) and rendered as one actionable line naming the offending label or field — never a raw YAML/Zod payload or a stack trace.
- Reading and merging are side-effect-free: no network, no keychain, no mailbox I/O, and nothing is ever deleted from a mailbox.
- ESM `nodenext` relative imports carry explicit `.js`; kebab-case files, `PascalCase` types.

**Never:**
- No CLI command, no startup wiring, no `MailPort.ensureCategories` call, no M365/Gmail adapter work, no `--sync-categories` — stories 4.2/4.3 own sync.
- No full `ConfigLoader`, no env-override layer, no DI container, no `Config` schema change, and no `taxonomy:` handling (custom path or inline list) — Epic 11 owns those; this story reads only the `taxonomyOverrides` key from `config.yaml`.
- No change to the `LabelDef` / `Taxonomy` / `LabelSet` shapes, no new dependency (`js-yaml` and `zod` are already installed), and no wiring into the classification engine (Epic 6).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DEFAULT | shipped `taxonomy.yaml`, no overrides | the 11 defaults, frozen, in file order | N/A |
| OVERRIDE_PATCH | an override naming a default with some fields | those fields replaced; omitted fields keep the default | N/A |
| OVERRIDE_ADD | an override naming a label absent from the defaults, supplying the other three fields | that label appended to the merged result | — typed error naming the missing field if any is absent |
| OVERRIDE_MALFORMED | an override entry that is not a mapping, or has no `name` | — | typed error naming the entry's index and the field |
| OVERRIDE_DROP | an override naming a default with no other fields | that default absent from the merged result | — typed error if the result would fall below the 1-label bound |
| DUPLICATE | two merged labels share a name | — | typed error naming the duplicated name |
| BAD_NAME | a label name outside the pattern (e.g. `Bills 💸`) | — | typed error naming the label |
| BAD_COLOR | `m365Color: preset25` or `gmailColor: red` | — | typed error naming the label and the field |
| BOUNDS | a merged result of 0 or 51 labels | — | typed error naming the bound that was crossed |
| SOURCE_BAD | `taxonomy.yaml` absent, unreadable, or unparseable YAML | — | typed error naming the expected path, never a parser trace |
| CONFIG_ABSENT | no `config.yaml`, or no `taxonomyOverrides` key | the defaults load unchanged | N/A |
| CONFIG_BAD | unparseable `config.yaml`, or `taxonomyOverrides` is not a list | — | typed error naming the file and the key |

</frozen-after-approval>

## Code Map

- `src/core/dto/LabelDef.ts` — `LabelDef { name, description, m365Color, gmailColor }`; gains `LABEL_NAME_PATTERN`, mirroring `src/core/dto/accountName.ts` (rule in core, Zod schema in adapters).
- `src/core/dto/Taxonomy.ts` — `type Taxonomy = LabelDef[]`; the loader's return type, unchanged.
- `_bmad-output/specs/spec-email-classification-skill/taxonomy.yaml` — the human-authored 11-label source to copy verbatim into the new repo-root `taxonomy.yaml` (names, descriptions, `preset0`…`preset10`, hex colors). Do not edit it.
- `src/adapters/config/perAccountSettings.ts` and `src/adapters/m365/accountSettings.ts` — the house pattern for a temporary reader: `js-yaml` `load`, a Zod schema, `isEnoent`, one typed error class with codes, injectable `configDir`. Reuse the shape, not the code.
- `src/adapters/token/KeychainTokenStore.ts` — the `~/.config/email-classify` default and injectable-`configDir` convention to follow if overrides are read from `config.yaml`.
- `src/adapters/index.ts` — the adapter barrel; add the loader, its error/codes and its options.
- `prd-email-agent-2025-01-15/prd.md:116-151` — FR-3 and its bounds; `:336-378` — FR-21's `config.yaml` example showing `taxonomy:` and `taxonomyOverrides:`; `epics.md:336-353` — Story 4.1 AC; `ARCHITECTURE-SPINE.md:250` — `adapters/config/taxonomy.ts`; `:273` — taxonomy in scope v1.

## Tasks & Acceptance

**Execution:**
- [x] `taxonomy.yaml` — add the 11 default labels at the repo root, copied from the planning spec — the single source of truth the loader reads.
- [x] `src/core/dto/LabelDef.ts` — add `LABEL_NAME_PATTERN` — the name rule belongs with the DTO, and Epic 6 validates against the same rule.
- [x] `src/adapters/config/configFile.ts` — temporary `config.yaml` reader exposing only `taxonomyOverrides` (injectable `configDir`; absent file means no overrides) — the Story 2.1/3.1 pattern, deleted wholesale by Epic 11.
- [x] `src/adapters/config/taxonomy.ts` — Zod schemas, `loadTaxonomy(options)`, the patch/add/drop merge, bounds and freeze, typed `TaxonomyError` — the story's deliverable.
- [x] `src/adapters/index.ts` — export `loadTaxonomy`, `TaxonomyError`, its codes and options — one adapter barrel.
- [x] `tests/adapters/config/taxonomy.test.ts` — stdlib-only fixtures in a tmpdir covering every matrix row — the loader's only executable check.

**Acceptance Criteria:**
- Given `mise exec node@20 -- bun run build`, `bun run lint`, `bun run test`, when run, then all exit 0.
- Given the shipped `taxonomy.yaml` and no overrides, when loaded, then exactly the 11 AC labels come back in order, `Object.isFrozen` is true for the array and for every entry, and each entry carries name/description/preset/hex.
- Given overrides that patch one default, add one label and drop one default, when loaded, then the merged result has exactly those three effects and no others.
- Given overrides that would duplicate a name, break the name pattern, use a bad color, or cross the 1–50 bound, when loaded, then a typed `TaxonomyError` names the offending label or field and no taxonomy is returned.

### Review Findings

Code review of `2d1a9a6..8339833` (2026-10-09, 9 files, +1065/−3). Four layers ran — blind-hunter, edge-case-hunter, verification-gap and acceptance-auditor (spec present); none was skipped and none returned empty. The verification-gap layer found **no** verification gaps and confirmed every matrix row plus both prior patches are pinned; the acceptance auditor found no acceptance-criteria violation, only the coverage gap below.

**Decision needed:** _none — every surviving finding has an unambiguous fix._

**Patch:**
- [x] [Review][Patch] A typo'd override key is stripped by the non-strict schema and silently *drops* that default — `{ name: "Invoices", gmailColour: "#123456" }` parses to a name-only entry, which the merge reads as "drop" [src/adapters/config/taxonomy.ts:49-54]
- [x] [Review][Patch] AC 3's combined scenario is not pinned: patch, add and drop are each tested alone, never as one override set asserting exactly those three effects [tests/adapters/config/taxonomy.test.ts]
- [x] [Review][Patch] Override edge cases are untested: an unknown/extra key, a `null` entry, an empty-string `name`, and an empty `taxonomyOverrides: []` [tests/adapters/config/taxonomy.test.ts]
- [x] [Review][Patch] Error messages percent-encode a URL-typed `taxonomyPath` (`path.pathname` yields `my%20labels`); the string form is unaffected [src/adapters/config/taxonomy.ts:82-84]

**Deferred:** _none — nothing in this pass is deferred._

**Rejected:**
- `false` — "the non-strict `labelSchema` silently ignores extra keys": for labels the four required fields turn a stripped key into a missing-field error, so nothing is silently accepted; the override schema (first patch above) is the case that actually bites.
- `low` — "no length cap on `name`/`description` (Gmail caps at 225, M365 at 255)": the AC fixes the name rule as the character pattern only, and provider-side limits belong to the 4.2/4.3 sync stories, whose own AC makes per-account provider errors non-fatal.
- `low` — "`readDefaultLabels` reports a *missing* required field as `invalid`": the message already names the field, and distinguishing missing from invalid needs presence checks for a cosmetic gain.
- `low` (carried from build review pass 1) — "`CONFIG_UNREADABLE` is re-typed to `CONFIG_INVALID`": recorded in this spec's triage log #1 and Implementation Notes; the message stays actionable and a distinct code would widen the error surface. Re-flagged by the blind-hunter and verification-gap layers.
- `low` (carried) — "`LABEL_NAME_PATTERN` accepts whitespace/separator-only names": frozen intent — the AC's exact regex — so any tightening is yours to approve. Re-flagged by the blind-hunter and edge-case-hunter layers.
- `low` (carried) — "`isEnoent` and `DEFAULT_CONFIG_DIR` are duplicated into a third file": the deliberate self-contained-reader pattern that lets Epic 11 delete each one wholesale.
- `low` (carried) — "`taxonomy.yaml` has no trailing newline": deliberate, so the repo copy stays byte-identical to the human-owned planning source.

## Implementation Notes

**Implementation pass (2026-10-09).** All tasks complete. `build`, `lint` and `test` (101 tests) are green, and `taxonomy.yaml` is byte-identical to the human-owned planning source (`diff` clean).

- **`validateLabels` runs after the merge**, so the merged result is checked as a whole: count bounds, then duplicate names (exact match), then each label through one Zod `labelSchema`. Every failure is a `TaxonomyError` naming the offending label, field or index — never a Zod or YAML payload.
- **`validateLabel` dispatches on the failing Zod path** so a bad color names `m365Color` or `gmailColor` explicitly, with `INVALID_LABEL_FIELD` as the fallback (e.g. `description`).
- **Overrides match the original defaults only** — a name added by an earlier override cannot be patched by a later one; it collides instead. That keeps "keeps the rest of that default" true for every entry and is what the DUPLICATE row pins.
- **`configFile.ts` returns `unknown[]`**: it deliberately does not validate entries, so `loadTaxonomy` is the single place that decides what an override means; its `ConfigFileError` is re-typed as `TaxonomyError("CONFIG_INVALID", …)` at that boundary.
- **The shipped `taxonomy.yaml` keeps no trailing newline** so it stays a byte-identical copy of the planning source; the repo's only formatting gate is oxlint.
- **Added during the diff review: a shipped-file test.** Matrix row DEFAULT was otherwise covered only by a synthetic fixture, leaving the AC's first clause ("the shipped `taxonomy.yaml` … exactly the 11 AC labels") unchecked by any test; the new test loads the committed file through the module-relative default, and the spec's manual check was corrected to match.
- **Review pass 1 (2026-10-09) patches applied.** `mergeLabels` now forgets a dropped name, so a later override naming that default becomes an add (which must supply its three fields) instead of being silently filtered out — the medium finding. The dead `existing === undefined` arm is gone, and `configFile.ts` derives its error path from an injected `configDir` rather than hardcoding the `~` form. Tests added: the exact 11 shipped rows, the readers' non-ENOENT `readFile` branches (EISDIR / ENOTDIR), a non-list `taxonomy.yaml`, a non-mapping entry, an entry missing `name`, a patch that sets an invalid colour, and the drop-then-re-add pair. 109 tests green.

## Spec Change Log

## Review Triage Log

**Loop iteration 0 (2026-10-09).** Three layers ran (blind-hunter, edge-case-hunter, verification-gap) over the diff since `2d1a9a65`; no layer was skipped and none returned empty. Verdicts are mine, re-verified against the source.

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `CONFIG_UNREADABLE` is thrown but re-typed to `CONFIG_INVALID`, so code and message disagree; unreadable and invalid are indistinguishable (BH, VG-other) | low | Real: `configFile.ts` throws `CONFIG_UNREADABLE` for a non-ENOENT read failure and `readOverrides` re-types every `ConfigFileError` as `CONFIG_INVALID`. The message still says "could not be read" and names the file, so it stays actionable, and the re-typing is recorded in this spec's Design and Implementation Notes. A distinct code would widen the public error surface. | reject (low) |
| 2 | Config error messages hardcode `~/.config/email-classify/config.yaml`, ignoring an injected `configDir` (BH) | low | Real: `CONFIG_FILE_DISPLAY_PATH` is used in all three messages while `path` is built from `options.configDir`. Production always uses the default dir, so only injected dirs (tests, a future XDG override) see the wrong location. Direct correction: derive the display path from the resolved path, as `taxonomy.ts` already does via `sourceDisplayPath`. | patch |
| 3 | The shipped-file test checks name order, freeze and colour *formats* but never the exact presets, hexes or descriptions (BH, VG) | medium | Real: the 11 labels' colours flow into M365/Gmail APIs and the descriptions into the classifier prompt, yet a wrong-but-format-valid preset or an altered description still passes. Only a human `diff` against the planning source currently catches that. Direct correction: pin the exact 11 rows in the test. | patch (test) |
| 4 | `LABEL_NAME_PATTERN` also matches whitespace/separator-only names, so `" "` is a valid label (BH) | low | Real but perverse: it needs a hand-authored name of only spaces or separators. The pattern is frozen intent (the AC's `/^[A-Za-z0-9 /&'-]+$/`), so tightening it is a spec change only the human can make. | reject (low) |
| 5 | `existing === undefined ? undefined : applyPatch(...)` can never take its first arm — dead code (BH, VG-other) | low | Real: `noUncheckedIndexedAccess` is off, so `labels[defaultIndex]` is typed `LabelDef` and the comparison is always false. The fix is a direct deletion (`applyPatch(labels[defaultIndex], override)`), which the reject rule exempts. | patch |
| 6 | `isEnoent` is duplicated verbatim in the two new readers (BH) | low | Real but the house pattern: the per-account reader already carries its own copy, and each temporary reader is deliberately self-contained so it can be deleted wholesale. A shared helper is a new module for a three-line predicate. | reject (low) |
| 7 | `OVERRIDE_MALFORMED` reports a *missing* `name` as "field \"name\" is invalid" (BH) | low | Real: the message names the index and the field, as the matrix promises, but "missing" would read better than "invalid". Distinguishing the two needs a branch on Zod's issue kind, which is more than a direct correction for a cosmetic gain. | reject (low) |
| 8 | The readers' remaining error branches are untested — non-ENOENT `readFile` failures (matrix SOURCE_BAD says "unreadable"), a non-list `taxonomy.yaml`, a non-mapping entry, and an entry missing `name` (BH, VG) | low | Real: every test supplies a readable path or an ENOENT path, so the "could not be read" branches and `readDefaultLabels`' three structural checks are unverified. Direct correction: drive EISDIR with a directory path for both readers and add the three source-shape cases. | patch (test) |
| 9 | The patch path is never exercised with an invalid value — all BAD_NAME/BAD_COLOR tests go through the ADD path (BH) | low | Real, though the patched label flows through the same `validateLabel`. Direct correction: one case patching a default's `gmailColor` to a non-hex value. | patch (test) |
| 10 | `taxonomy.yaml` has no trailing newline (BH) | low | Real but deliberate: the absent newline is what makes the repo copy byte-identical to the human-owned planning source, which this spec's Verification section relies on. Adding it would break that property for a cosmetic gain. | reject (low) |
| 11 | The module-relative default path points at the checkout root, which `tsc -b` does not copy into `dist/`, so a packaged build without the checkout-root YAML could not load defaults (BH) | low | Real but unreachable today: the package is private with no `files` field and is run from the checkout, and the spine seeds `taxonomy.yaml` at the repo root. Packaging is a release or Epic 11 decision (a config-supplied `taxonomy:` path is explicitly Epic 11's). | reject (low) |
| 12 | A drop followed by another override naming the same default silently discards the later entry (EH) | medium | Real: `defaultIndexByName` keeps the dropped name, so the later entry still resolves to the default; it patches `labels[defaultIndex]`, but the final `dropped.has(...)` filter removes it anyway — a drop-then-patch or drop-then-re-add vanishes with no error. Direct correction: delete the name from the map when it is dropped, so a later same-name entry is treated as an add (and must supply the three fields, or errors). | patch |
| 13 | Untested "unreadable file" (non-ENOENT) branches in both readers (VG) | low | Pre-verified by the verification-gap layer; same root cause as #8. | patch (test) — grouped with #8 |
| 14 | Untested `SOURCE_INVALID` structural branches in `readDefaultLabels` (VG) | low | Pre-verified; defensive branches beyond the agreed matrix, same root cause as #8. | patch (test) — grouped with #8 |
| 15 | Shipped `taxonomy.yaml` exact colours and descriptions are pinned by no executable test (VG) | medium | Pre-verified; same root cause as #3. | patch (test) — grouped with #3 |

**Grouping:** #3+#15 (the shipped file's exact content) and #8+#13+#14 (the readers' unverified error branches) are one root cause each. #1 folds VG's second "other" finding, #5 folds its first.

**Outcome:** Rejected #1, #4, #6, #7, #10, #11 (low). No `defer`. Patched #2, #3+#15, #5, #8+#13+#14, #9 (tests), #12 (medium). No `intent_gap` and no `bad_spec` entries — #12 is a logic defect inside new code whose fix the spec fully settles — so no loopback was triggered and `review_loop_iteration` stays 0. Patches applied and re-verified on 2026-10-09: `mise exec node@20 -- bun run build`, `bun run lint` and `bun run test` (109 tests) are green on two consecutive runs.

## Design Notes

- **Temporary config surface (decision 2).** `src/adapters/config/configFile.ts` reads only the `taxonomyOverrides` key from `~/.config/email-classify/config.yaml` — not `taxonomy:`, model, accounts or anything else — so Epic 11 can delete that file and hand the same list to `loadTaxonomy` with one import change.

- **Placement.** The spine names both `core/skill/taxonomy.ts  # loads taxonomy.yaml` and `adapters/config/taxonomy.ts`; core has zero dependencies (AD-10), so the I/O + Zod loader lives in `adapters/config` (the capability map's choice) and only the name rule stays in core.
- **Default path.** `taxonomyPath` defaults to the shipped file resolved from the module URL (`new URL("../../../taxonomy.yaml", import.meta.url)`), which reaches the repo root from both `src/adapters/config/` and `dist/adapters/config/`, and is injectable so tests never read the real file. A config-supplied `taxonomy:` path is Epic 11's.
- **Override entry shape.** An override is a *partial* patch — `name` required, `description`/`m365Color`/`gmailColor` optional — so it cannot be a `LabelDef`, which requires all four. An entry that matches no default must supply all three of the others to become a label.
- **Color validation is deliberately strict** (`preset0`–`preset24` and 6-digit hex): both values go straight to mail APIs that reject anything else, so a bad color is a load-time error rather than a per-account sync failure later.
- **"Passed to the classification engine" (the AC's last clause)** is satisfied here by returning the frozen taxonomy; the DI wiring into `classify()` belongs to Epic 6 / Epic 11.

## Verification

**Commands:**
- `mise exec node@20 -- bun run build` — expected: exit 0.
- `mise exec node@20 -- bun run lint` — expected: exit 0 (the AD-10 direction stays enforced).
- `mise exec node@20 -- bun run test` — expected: exit 0, including the new taxonomy suite.

**Manual checks:**
- The repo-root `taxonomy.yaml` matches the planning spec's 11 entries on names, descriptions and colors.
- The shipped-file test loads the committed `taxonomy.yaml` through the module-relative default; no test reads a real `~/.config/email-classify/config.yaml`.
