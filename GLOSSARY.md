# GLOSSARY

Domain language for the email-cleanup agent. Terms here are the vocabulary the
code, tests, issues, and docs use; avoid drifting to synonyms. Source of truth:
[`SPEC-email-cleanup-agent-v1.md`](SPEC-email-cleanup-agent-v1.md) plus the ADRs
in [`docs/adr/`](docs/adr/).

## Runs and lifecycle

- **Cleanup run** — one end-to-end pass over the pilot mailbox: ingest, classify,
  no-touch enforcement, plan (dry run) or apply, audit, report, metrics. V1 has
  exactly two lifecycle modes, dry-run and live-apply.
- **Dry run** — reads the inbox, classifies it, and persists a plan. Performs zero
  mailbox mutations.
- **Live apply** — turns an approved dry-run plan into mailbox changes. Always
  linked to its source dry-run plan (`source_plan_id` / `source_run_id`).
- **Run record** — the immutable JSON file (`data/runs/<run-id>.json`) describing
  one run, its planned (or applied) actions, report, and metrics. Immutable once
  written. A dry run's ingest snapshot lives beside it (`<run-id>-ingest.json`).
- **Plan / plan record** — the dry-run artifact (`data/plans/<plan-id>.json`)
  holding proposed actions, rationale traces, the exception queue, and the config
  snapshot in effect.

## Classification

- **Category** — exactly one of four values every message resolves to:
  `Action Needed`, `Waiting/Follow-up`, `FYI/Reference`, `Bulk/Archive`. Never a
  fifth value, never none.
- **Classification pipeline** — the ordered decision sequence:
  1. **No-touch protection** (hard rules, always first — see below)
  2. **Deterministic rules** (existing mailbox categories, subject keywords)
  3. **System1 pass** — the first model pass (JEV System1)
  4. **Second pass** — Ollama Cloud, only for items the first pass returned with
     confidence below the configured threshold
- **Rationale trace** — the structured why (`policy` / `rule` / `model` entries)
  recorded for every classification; flattened into the audit log's `rationale`.

## Protection

- **No-touch protection** — the hard rules that exclude a message from archiving:
  VIP sender, flagged/starred, within the recent-window, or finance/legal keyword
  match. An unparseable date fails closed (protected).
- **Exception queue** — the snapshot of all protected messages for a run; protected
  items are archived never; they are surfaced for manual handling.
- **VIP sender** — a sender address whose messages are always protected
  (case-insensitive, exact match).

## Actions

- **Planned action** — a unit in a plan: `classify` (with a category) or
  `archive`. There is no third action: **delete is impossible in V1** — not in the
  adapter contract, not in the audit action union (ADR-0001).
- **Approval decision** — the operator's explicit per-category yes/no between dry
  run and live apply. A missing decision for any planned category is an error;
  nothing applies by accident.

## Gate and evidence

- **Archive precision** — success rate over archive attempts on non-protected
  messages (operational failures excluded). Zero attempts fails closed at `0`,
  never at `1` (ADR-0003).
- **No-touch miss** — any blocked archive plus any archive attempt on a protected
  message. Operational failures (e.g. a mailbox fetch error) are not misses
  (ADR-0003).
- **Expansion gate** — the four rollout conditions that must all hold before
  expanding beyond the pilot mailbox: ≥500 processed, precision ≥98%, zero
  no-touch misses, explicit human sign-off. Evidence is cumulative across the
  account's live runs (ADR-0003).
- **Sign-off** — the operator's recorded go/no-go decision for expansion, kept in
  a separate file so run records stay immutable.
- **Processed (count)** — distinct message ids with evaluated actions in live
  runs; ids that repeat across runs count once.

## Seam and adapters

- **Mailbox adapter** — the provider-neutral contract
  (`src/adapter.ts`) behind which Microsoft 365 is implemented; Gmail is deferred
  until the pilot passes the gate.
- **Orchestrator** — the provider-neutral run seam (`src/orchestrator.ts`);
  re-exports the dry-run and live-apply entry points, which own the lifecycle.