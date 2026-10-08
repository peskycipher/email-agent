# Epic 4 Context: Taxonomy & Per-Account Category Sync

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Give the user a single editable label taxonomy that actually shows up in their mail clients. The default taxonomy ships as `taxonomy.yaml`, the user can override, add, or remove labels via `config.yaml`, and the CLI loads the merged result once at startup. It then ensures every label exists as an M365 master category and a Gmail label for every enabled account, so classified labels can be written back natively (Outlook/Web/Gmail UI) rather than living in a side dashboard. Sync is idempotent, per-account, and must never delete labels the user removed from the taxonomy.

## Stories

- Story 4.1: Taxonomy Definition & User Overrides
- Story 4.2: M365 Master Category Sync (Multi-Account)
- Story 4.3: Gmail Label Sync (Multi-Account)

## Requirements & Constraints

- **Default taxonomy:** 11 labels — Action Needed, Waiting/Follow-up, Important, Invoices, Crypto, Business, Family/Friends, Newsletters, Promos, Notifications, Real-estate. Each entry carries `name`, `description`, `m365Color` (preset0–preset24), `gmailColor` (hex).
- **Merged taxonomy:** `config.yaml` `taxonomyOverrides[]` may change any label field, add labels, or drop defaults (a dropped default is simply absent from the merge). Merged result must hold **1–50 labels**; names must match `/^[A-Za-z0-9 /&'-]+$/`; no duplicate names after merge. Invalid taxonomy is rejected at load.
- **Load once, freeze:** the merged taxonomy is Zod-validated, frozen after load, and passed via DI to all components. Classification reads the active merged taxonomy.
- **M365 sync (per account):** list master categories, then create any missing ones with the taxonomy `displayName` and `m365Color` preset. Idempotent — match by `displayName`, never create duplicates. Taxonomy edits create newly-added labels and leave removed labels untouched in the mailbox.
- **Gmail sync (per account):** list labels, then create any missing ones with the taxonomy `name` and `gmailColor` hex. Idempotent — match by `name`. Build and cache a label-name → label-ID mapping per account; downstream Gmail write-back depends on it.
- **Isolation:** a sync error on one account is logged but must not block other accounts or abort startup. Sync runs at startup regardless of mode.
- **Account safety:** `accountName` is validated against `/^[a-z0-9][a-z0-9_-]{0,31}$/` before any keychain or filesystem lookup, so a name cannot escape its per-account directory.
- **Colors:** M365 uses named presets; Gmail uses hex. A created category/label uses the taxonomy color; existing color differences are not force-overwritten.

## Technical Decisions

- **Hexagonal direction (AD-10):** `core/` has zero deps; adapters depend on `core/ports`; `cli/` wires all. Taxonomy types live in core — do not pull adapter SDKs into core.
- **Pure core (AD-1):** taxonomy loading/merge is config-side; classification stays a pure function receiving the frozen taxonomy.
- **MailPort contract (AD-8):** category/label creation is exposed as `ensureCategories(accountId: string, labels: LabelDef[]): Promise<void>`. Each provider adapter handles its own list/create call, pagination, rate limits, and is instantiated once per enabled account by the DI container.
- **Config (AD-9):** taxonomy comes from `taxonomy.yaml` merged with `config.yaml` `taxonomyOverrides` at startup; config is Zod-validated and frozen. Missing/invalid config exits with a clear error naming the offending field.
- **DTOs:** `Taxonomy` is an array of `LabelDef`; `LabelDef = { name, description, m365Color, gmailColor }`. `LabelSet.labels` is validated against the active taxonomy.
- **Suggested placement:** taxonomy load/merge in `src/adapters/config/taxonomy.ts`, sync flow in `src/orch/sync.ts`, per-provider calls in `src/adapters/m365/M365Adapter.ts` and `src/adapters/gmail/GmailAdapter.ts`, `--sync-categories` command in `src/cli/commands/sync-categories.ts`. Follow kebab-case files, `PascalCase` types, `*Port`/`*Adapter`/`*DTO` suffixes.
- **Stack:** `googleapis` for Gmail labels, `@microsoft/microsoft-graph-client` for Graph master categories, `zod` for taxonomy validation, `js-yaml` for parsing.
- **Logging (AD-7):** log per-account sync success/failure via `LogPort` with `accountId` in context; tokens are never logged.

## UX & Interaction Patterns

- No UX design contract exists; interface expectations are CLI-derived.
- Provide a `--sync-categories` command (with `--account <name|all>`) to run/refresh category and label sync on demand; `--account` defaults to `all`.
- Use clear, actionable error messages (not stack traces). Surface per-account sync failures individually so one broken account is visible without hiding the rest.

## Cross-Story Dependencies

- **4.1 → 4.2/4.3:** the merged, frozen taxonomy must exist before any sync runs; both sync stories consume it.
- **4.3 → Epic 7 (Gmail write-back):** the cached label-name → label-ID mapping built here is the lookup used when applying Gmail labels.
- **Epic 2 (M365 auth) / Epic 3 (Gmail auth):** sync requires per-account authenticated clients; each account syncs independently.
- **Epic 1:** `MailPort.ensureCategories`, `LabelDef`/`Taxonomy` DTOs, and the DI-per-account wiring are defined there; confirm they exist before wiring sync.
- **Epic 6 (Classification):** the active taxonomy is the label universe the classifier may return; user edits take effect on next load.
- **Epic 11 (Config & CLI):** `taxonomyOverrides` merge, validation bounds, `accountName` regex, and CLI command/help surface are owned there; this epic consumes them.
