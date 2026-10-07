## Problem Statement

The user manages multiple inboxes (Microsoft 365 and Gmail) and has accumulated too much unread and unorganized email to process manually with confidence. They need an agent that can perform a safe, one-time cleanup first, with explicit guardrails and full action tracing, so they can regain control of inbox state without risking important communication.

## Solution

Build an email-cleanup agent V1 that runs Microsoft 365 first (single pilot mailbox), performs a dry-run classification and action plan, and then applies approved categories of low-risk actions (categorize + archive) while enforcing strict no-touch protections.

The cleanup objective is “zero unread where allowed,” with protected messages moved into an exception queue for manual handling. Every agent action is fully auditable with reasoning trace, and rollout expands only after quality gates are met and the user explicitly signs off.

## User Stories

1. As an inbox owner, I want the agent to connect to my Microsoft 365 mailbox first, so that rollout risk is minimized before multi-provider expansion.
2. As an inbox owner, I want the first run to be a dry-run preview, so that I can review planned actions before any live changes.
3. As an inbox owner, I want planned actions grouped by category, so that I can approve or reject batches quickly.
4. As an inbox owner, I want the cleanup goal to be zero unread where allowed, so that inbox state becomes manageable.
5. As an inbox owner, I want protected items excluded from auto-archive, so that important messages are not mishandled.
6. As an inbox owner, I want VIP senders always protected, so that high-value communication is never auto-archived.
7. As an inbox owner, I want flagged/starred messages always protected, so that my prior prioritization is respected.
8. As an inbox owner, I want recent threads (7-day window) protected, so that active conversations remain visible.
9. As an inbox owner, I want finance/legal keyword matches protected, so that sensitive business communications are not auto-archived.
10. As an inbox owner, I want non-important messages categorized and archived automatically after approval, so that cleanup impact is meaningful with low risk.
11. As an inbox owner, I want the agent to never delete email in V1, so that all actions remain reversible.
12. As an inbox owner, I want exceptions surfaced as a manual queue, so that I can finish edge cases safely.
13. As an inbox owner, I want each message assigned to one of four categories (Action Needed, Waiting/Follow-up, FYI/Reference, Bulk/Archive), so that organization is consistent.
14. As an inbox owner, I want importance determined by rules first and model second, so that high-confidence policy decisions happen deterministically.
15. As an inbox owner, I want a summary report after each run, so that I can quickly understand outcomes.
16. As an inbox owner, I want sample item-level traces in the report, so that I can spot-check reasoning quality.
17. As an inbox owner, I want full audit logs for every action, so that I can investigate unexpected outcomes.
18. As an inbox owner, I want reasoning traces attached to actions, so that I can understand why a decision was made.
19. As an inbox owner, I want the system to record action outcomes (success/failure), so that operational reliability is measurable.
20. As an inbox owner, I want quality metrics (archive precision, no-touch misses) computed per run, so that expansion is evidence-based.
21. As an inbox owner, I want expansion blocked unless 500 emails are processed in pilot, so that decisions are based on enough data.
22. As an inbox owner, I want expansion blocked unless archive precision reaches at least 98%, so that automation quality is proven.
23. As an inbox owner, I want expansion blocked if any VIP/no-touch miss occurs, so that critical policy failures prevent scale-out.
24. As an inbox owner, I want explicit go/no-go sign-off before expansion, so that I remain in control of rollout risk.
25. As an inbox owner, I want Gmail integration deferred until M365 pilot gates pass, so that implementation remains focused and safer.
26. As an inbox owner, I want the same policy model portable to Gmail later, so that provider expansion does not require redefining core safety behavior.
27. As an inbox owner, I want category approval history preserved, so that repeated runs can become faster and more consistent.
28. As an inbox owner, I want run configuration and thresholds visible, so that policy behavior is transparent and tunable.
29. As an inbox owner, I want every live run linked to its dry-run plan, so that applied actions are traceable to approved intent.
30. As an inbox owner, I want this cleanup foundation to feed a future daily email copilot, so that one-time cleanup evolves into ongoing value.

## Implementation Decisions

- Introduce one top-level cleanup seam: a **Cleanup Run Orchestrator** that owns run lifecycle end-to-end (ingest, classify, enforce policy, plan, approval, apply, report, metrics).
- Keep provider integration behind a minimal mailbox adapter contract, with Microsoft 365 implemented first and Gmail deferred.
- Use a policy-first decision pipeline:
  1. Hard no-touch rules (VIP, flagged/starred, recent<=7 days, finance/legal terms)
  2. Deterministic rule-based importance checks
  3. JEV System1 first-pass classification for unresolved remainder (cheap/high-throughput pass)
  4. Ollama Cloud second-pass classifier: `deepseek-4.1-flash` (locked for V1) only for ambiguous/low-confidence items, with `glm-5.3-flash` as the named backup/swap candidate if cost/quality tests later justify switching.
- Restrict V1 action set to:
  - Categorize
  - Archive (only for approved categories and non-protected mail)
  - No delete operations
- Model “zero unread” as:
  - Inbox unread count reduced to zero where policy allows
  - Remaining protected unread items emitted to exception queue
- Approval model is **category-batch approval** between dry-run and apply phases.
- Persist immutable run/audit records with per-action:
  - timestamp
  - account/mailbox identifier
  - message identifier
  - chosen action
  - category
  - policy/rule/model rationale trace
  - outcome/result state
- Persist run-level metrics:
  - processed message count
  - archive precision estimate
  - no-touch miss count
  - category-level action totals
- Enforce rollout gate policy in orchestrator before expansion from pilot mailbox:
  - processed >= 500
  - archive precision >= 98%
  - VIP/no-touch misses = 0
  - explicit user sign-off present
- Define reporting outputs as:
  - run summary totals
  - sample item-level reasoning traces
  - exception queue snapshot

## Testing Decisions

- Good tests should validate externally observable behavior (planned actions, blocked actions, approval gating, resulting state/metrics), not internal implementation details or model internals.
- Primary seam under test is the Cleanup Run Orchestrator; most scenarios should be validated via orchestrator-level tests with adapter/model stubs.
- Secondary seam tests cover policy engine behavior for no-touch enforcement and rules-first fallback sequence.
- Required behavior tests:
  - Dry-run produces proposed actions but no mailbox mutations.
  - Category approval controls which planned actions are applied.
  - No-touch classes are never auto-archived.
  - Delete action is impossible in V1.
  - Exception queue receives protected unread items when driving to zero unread.
  - Rollout expansion is blocked until all gate thresholds and sign-off conditions are met.
  - Audit log records required fields for each attempted/applied action.
  - Run summary and sample trace outputs are generated.
- Prior art in this repository: none currently present; establish one consistent orchestrator-focused test style and reuse it for follow-on features.

## Out of Scope

- Calendar management and appointment booking.
- Contact sync/update workflows.
- Gmail live rollout in V1 (planned after M365 pilot success).
- Automatic sending/drafting of responses.
- Full autonomous high-risk operations without approval.
- Message deletion policies and lifecycle management.
- Long-term analytics dashboards beyond per-run report outputs.

## Further Notes

- This spec intentionally optimizes for safety, reversibility, and explainability over maximal automation.
- Phase 2 target (already prioritized): daily email copilot (triage/summarize/draft, still approval-gated for send actions).
