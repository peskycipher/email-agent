# Multi-label vocabulary replaces the four-category taxonomy

V1 originally assigned every message **exactly one** of four categories:
`Action Needed`, `Waiting/Follow-up`, `FYI/Reference`, `Bulk/Archive`. That
single-value model forced one axis to carry several orthogonal questions at once
— urgency, topic, and source all competed for the same slot, so a real-estate
inspection reminder could be categorized as urgent *or* as real estate, never
both. In practice the taxonomy collapsed: the first run against the pilot mailbox
put 42.6% of messages in `Action Needed`, and 61% of those labels came from the
no-touch short-circuit rather than from classification at all.

## Decision

Messages now carry **any number of labels** drawn from a flat vocabulary
(`src/classify/labels.ts`). Labels are orthogonal — `Realestate` + `Invoices` +
`Action Needed` on one message is normal, and zero labels is valid.

- **Canonical values are Title Case** (`Action Needed`, `Waiting/Follow Up`,
  `Realestate`, `IT News`, ...) and are stored verbatim in run/plan records and
  written as Outlook categories.
- **Model pass:** JEV System1 asks one `noul` question per model-inferable label
  (`choice` can only pick one option, so independent yes/no questions are the
  documented way to attach several labels); every label above `0.7` is attached.
  The derived confidence decides escalation as before (ADR-0002).
- **Sender-derived labels** (`Family`, `Friends`, `IT News`) are never asked of
  the model — `Family`/`Friends` come from configured address lists and `IT News`
  from the sender domain. A model asked to guess these would answer confidently
  and wrongly.
- **Archiving:** a message archives only when it carries at least one
  archive-safe label (`Newsletters`, `Promos`, `Notifications`, `Subscriptions`,
  `IT News`) **and** no veto label (`Action Needed`, `Important`, `Family`,
  `Friends`). The remaining labels are neutral.
- **Approval** is per label. A message is skipped unless **every** label it
  carries is approved, so rejecting one label leaves that mail untouched.
- The **7-day recent-thread** no-touch rule is removed with this change: age is
  not evidence of importance, and blanket-protecting recent mail to the manual
  category was the single largest source of false `Action Needed` labels.

## Consequences

- `metrics.category_totals` becomes `metrics.label_totals`, keyed by every label;
  each evaluated action is counted once under the message's primary (first) label
  so totals still sum to actions, not labels.
- Audit records carry a comma-joined `labels` field instead of `category`.
- CLI approval flags rename to `--approve-label` / `--reject-label`.
- Existing plans on disk using the old `category` field no longer parse; apply
  rejects them explicitly rather than guessing.
- `SPEC-email-cleanup-agent-v1.md` still describes the original four-category
  design. It is superseded on this point by this ADR.
