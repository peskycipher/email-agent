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

- **Label** — one of a flat, open vocabulary (`src/classify/labels.ts`) attached
  to a message. A message carries any number of labels, including none; labels
  are orthogonal (a message can be `Realestate` and `Invoices` and `Action
  Needed` at once). Canonical values are Title Case.
- **Archive-safe label** — a label that makes a message eligible for archiving
  (`Newsletters`, `Promos`, `Notifications`, `Subscriptions`, `IT News`). A
  message archives only when it carries an archive-safe label and no veto label.
- **Veto label** — a label that blocks archiving even when an archive-safe label
  is present (`Action Needed`, `Important`, `Family`, `Friends`). The remaining
  labels are neutral: they neither qualify nor block.
- **Sender-derived label** — a label resolved from the sender rather than the
  content (`Family` / `Friends` from config lists, `IT News` from the sender
  domain), added on top of whatever the other paths produced.
- **Primary label** — a message's first label (`labels[0]`). Every evaluated
  action is counted exactly once in `metrics.label_totals`, under its primary
  label, so totals still sum to action counts rather than label counts.
- **Classification pipeline** — the ordered decision sequence:
  1. **No-touch protection** (hard rules, always first — see below)
  2. **Deterministic rules** (existing mailbox labels, subject keywords, then
     body keywords when the subject has no match)
  3. **System1 pass** — the first model pass (JEV System1), one `noul` question
     per model-inferable label
  4. **Second pass** — Ollama Cloud, only for items the first pass returned with
     confidence below the configured threshold
- **Body inclusion** — the adapter may supply a plain-text message body
  (`body`), which the classifier evaluates: the JEV state carries it, the
  second-pass prompt carries it, and keyword rules fall back to it when the
  subject has no match. The body is truncated by the adapter (`bodyMaxChars`,
  default 4000) and is **not** consulted by no-touch protection, so a body alone
  never protects or unprotects a message.
- **Rationale trace** — the structured why (`policy` / `rule` / `model` entries)
  recorded for every classification; flattened into the audit log's `rationale`.

## Protection

- **No-touch protection** — the hard rules that exclude a message from archiving:
  VIP sender, flagged/starred, or finance/legal keyword match.
- **Exception queue** — the snapshot of all protected messages for a run; protected
  items are archived never; they are surfaced for manual handling.
- **VIP sender** — a sender address whose messages are always protected
  (case-insensitive, exact match).

## Actions

- **Planned action** — a unit in a plan: `classify` (with its labels) or
  `archive`. There is no third action: **delete is impossible in V1** — not in the
  adapter contract, not in the audit action union (ADR-0001).
- **Approval decision** — the operator's explicit per-label yes/no between dry
  run and live apply. A missing decision for any planned label is an error;
  nothing applies by accident. A message is skipped unless **every** label it
  carries is approved.

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