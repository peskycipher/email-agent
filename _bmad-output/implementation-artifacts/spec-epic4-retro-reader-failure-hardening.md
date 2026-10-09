---
title: 'Epic-4 retro remediation — honest failure reporting in the temporary config reader and --sync-categories'
type: 'bugfix'
created: '2026-10-09'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
baseline_commit: '03e091a'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 4's retro left four remediation items against the temporary config/settings readers: a mistyped top-level `taxonomy*` key in `config.yaml` is silently stripped, so the whole override feature turns off with no diagnostic (item 1); the `--account all` path prints the no-accounts hint even when a provider's listing just failed — contradicting the named-account path's `failures === 0` gate — and a listing failure gets no counted summary line (item 2); the named-account listing-throw branch has no test (item 3); and two diagnostics say things the code underneath does not do — a scalar `config.yaml` is blamed on `taxonomyOverrides` (item 5a) and the no-accounts hint hardcodes the `~` display path even under an injected `configDir` (item 5b).

**Approach:** apply the four remediations in `src/adapters/config/configFile.ts` and `src/cli/commands/sync-categories.ts` with their tests — a targeted `taxonomy*`-key guard (not `.strict()`), the hint gate mirrored from the named path, one counted listing-failure line, the named-account throw test, and the two honest diagnostics. No schema change, no new keys accepted, Epic 11 still replaces both files wholesale.

</frozen-after-approval>

## Code Map

- `src/adapters/config/configFile.ts` — the schema strip is the silently-ignoring shape; the mistyped-key guard and the scalar diagnostic both land in `readTaxonomyOverrides`'s validation tail (`configFile.ts:62-69`).
- `src/cli/commands/sync-categories.ts` — the `--account all` branch's hint gate is at `sync-categories.ts:180-183` (mirror the named path's gate at `:215`); the listing-failure catch is at `:160-165`; `noAccountsHint` (`:91-98`) hardcodes the `~` display paths.
- `tests/adapters/config/taxonomy.test.ts` — the existing config-file rows to mirror (grep `readTaxonomyOverrides`).
- `tests/cli/sync-categories.test.ts` — the `--account all` hint row and the m365 listing-throw row to mirror for the named-account case.

## Implementation Notes

Implemented 2026-10-09 from baseline `03e091a`. `bun run build` / `bun run lint` / `bun run test` green — 22 files / **382 tests** (baseline 374; +8 rows net).

- **Files touched:** `src/adapters/config/configFile.ts` (the near-miss-key guard + the mapping-shape diagnostic), `src/cli/commands/sync-categories.ts` (the hint gates both ways, the counted listing-failure line on both paths, the per-provider setup pointer, the configDir-honest hint paths), `tests/adapters/config/taxonomy.test.ts` (+4 rows), `tests/cli/sync-categories.test.ts` (+3 rows, one updated to name the injected configDir).
- **The near-miss guard's contract (item 1):** it folds case and separators and matches any key that *reaches for* the overrides key (a case-miss, `taxonomy_overrides`, or the truncated `taxonomyOverride`), all keys diagnosed in one message; an interior typo (`taxonmy`) evades it — accepted, because a distance match is not worth its complexity on a reader Epic 11 replaces, and the guard's comment names that ceiling so it survives re-derivation.
- **The guard's reach is scoped to the override key, not the whole `taxonomy*` prefix:** `taxonomyFile` (a legitimate Epic-11-style key) passes, pinned by the `CONFIG_TOLERANT` row. The first draft rejected the whole prefix and would have broken legitimate future configs — the review caught it.
- **Failure reporting (items 2 and the review's asymmetry finding):** both the `--account all` and the named-account branches now print the counted listing-failure line; the hint prints only on a clean-but-empty listing, and a provider whose listing succeeded while its sibling's failed still gets a one-provider setup pointer (`providerHint`) — so the gate no longer suppresses useful directions and never contradicts a failure line.
- **Item 5b's rule:** `noAccountsHint` derives its paths from the injected `configDir` when one is set; the test that previously asserted the `~` display form under an injected dir now asserts the real paths.
- No sprint-status entry: retro remediation is outside the story keys.

## Review Triage Log

<!-- 2026-10-09 — one-shot review pass: Blind Hunter 11 findings → 6 patch (applied above), 2 false, 3 rejected. -->

- **BH1** `src/adapters/config/configFile.ts` — low — the guard comment's example (`"taxonmyOverrides"`) is a spelling the prefix guard cannot catch, contradicting the test's ceiling note; the rewritten comment states the real reach (case/separators/truncation) and names the interior-typo ceiling.
- **BH2** `src/adapters/config/configFile.ts` — medium — `TaxonomyOverrides:` / `taxonomy_overrides:` were still silently stripped; the guard now folds case and separators before the near-miss match, with rows pinning both spellings.
- **BH3** `src/adapters/config/configFile.ts` — low — one key diagnosed per rerun; the guard now collects every near-miss key and names them together, pinned by the two-keys row.
- **BH4** `src/adapters/config/configFile.ts` — medium — the guard rejected the whole `taxonomy*` prefix, so a legitimate `taxonomyFile` would hard-fail a config Epic 11 must accept; the reach is now scoped to keys that reach for the override key, and the `CONFIG_TOLERANT` row pins `taxonomyFile` passing.
- **BH5** this spec — low — the accepted interior-typo limitation lived only in a test comment and the Implementation Notes were never written; both recorded here now.
- **BH6** the new test tags — low, rejected — they trace to no spec matrix, but this is a retro remediation without a matrix and the tags are honest labels — nothing to reconcile.
- **BH7** `tests/cli/sync-categories.test.ts` — low — the named-account hint's injected-configDir behavior was unpinned; the existing named-hint row now asserts the real configDir paths.
- **BH8** `tests/cli/sync-categories.test.ts` — false — the claim cites a test that "pins only real-path hints and neither the counted line nor the hint suppression": the `HINT_GATE` row added in this change asserts exactly both, and no both-listings-throw test exists to mis-pin anything.
- **BH9** `src/cli/commands/sync-categories.ts` — medium — the all-or-nothing hint gate regressed the healthy-but-empty provider's setup pointer: a provider whose listing succeeded while its sibling's failed now gets a per-provider pointer (`providerHint`), and the shared hint prints only on a clean-but-empty listing.
- **BH10** `src/cli/commands/sync-categories.ts` — low, rejected — deriving the accounts subpaths from the settings modules would add an export on a temporary surface Epic 11 deletes; the `configDir === undefined` branch still reuses the display constants.
- **BH11** `src/cli/commands/sync-categories.ts` — low — the named path's listing throw printed only its provider line; it now prints the same counted line as the `--account all` branch, so reporting no longer depends on the selection mode.