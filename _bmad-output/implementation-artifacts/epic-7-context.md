# Epic 7 Context: Label Write-Back (per account)

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Close the loop between classification and the user's real mailbox: take the label set the engine returns for a fetched message and apply it to that message in the account it came from, as native M365 categories or Gmail labels. This is what makes the product useful — labels surface in Outlook and the Gmail UI rather than a side dashboard. The write is strictly **additive and idempotent**: it unions predicted labels with whatever the message already carries, never removes user-applied labels, and skips the network call when nothing is missing, so re-runs are safe.

## Stories

- Story 7.1: M365 Label Write (Multi-Account)
- Story 7.2: Gmail Label Write (Multi-Account)

## Requirements & Constraints

- **Add-only, never remove.** Existing M365 categories and Gmail labels are always preserved; only predicted taxonomy labels not already present are added. Removing a label the skill applied is out of scope for v1.
- **M365 write.** Update the message via `PATCH /me/messages/{id}` on its source account, setting `categories` to the union of existing categories + new labels. If the message already has every predicted label, make no API call.
- **Gmail write.** Call `users.messages.modify` on the source account with `addLabelIds` containing only the label IDs for predicted labels not already present. Label name → label ID mapping is cached per account from the label sync (Epic 4), not re-fetched per message.
- **Account scoping.** Writes are scoped to the account that owns the message; cross-account writes are forbidden. Every port method taking an account carries its `accountId`.
- **Per-message failure isolation.** A 404 (message moved/deleted) is a warning naming the account and message ID, and the batch continues — never a batch failure. The same tolerant shape applies to Gmail.
- **Label set contract.** Write-back consumes `LabelSet = { labels: string[] }` — label **names** from the active taxonomy, returned by the classifier. An empty set is valid (no write).

## Technical Decisions

- **AD-8 MailPort seam.** `MailPort.writeLabels(accountId, messageId, labels)` is implemented by the per-provider adapters (`M365Adapter`, `GmailAdapter`); the DI container instantiates one adapter per enabled account. Provider wire specifics (Graph `PATCH`, Gmail `modify`, ID mapping) stay inside the adapters, never in orchestration. Existing `ensureCategories(accountId, labels)` covers the pre-existing category/label sync.
- **Label names are canonical; IDs are adapter-internal.** The engine returns names; resolving names to Gmail label IDs belongs here (via the per-account cache). M365 writes the names directly as `categories`.
- **Existing labels arrive on the DTO.** `MessageDTO` carries `accountId` and the current labels (`existingLabels`); write-back unions against those rather than re-reading the message.
- **Error shape and logging.** Adapters throw/return the shared `{ code, message, context? }` error shape at their boundary. Warnings go through the injected `LogPort` with `accountId` and message id in context; tokens are never logged.
- **AD-10 dependency direction.** Write-back lives in `adapters/{m365,gmail}` and depends on core ports only; `core/` stays dependency-free.
- **Gmail adapter split (standing retro item, now urgent).** `GmailAdapter` has grown into a ~780-line class spanning four concerns (label sync, list walk, batch hydration, history walk). The carried follow-through is to split it along those concerns (and split its test file) so Story 7.2 adds write-back as a peer concern rather than a fifth responsibility to the monolith.
- **Gmail label-cache precondition (data landmine).** The per-account name→ID cache is only complete after a full label sync; a mid-loop failure can leave it incomplete. Write-back must not assume an unpopulated or partial cache yields correct IDs — treat missing mappings as an error, not a silent skip.
- **Concurrency assumption.** M365 `categories` updates are assumed atomic (no race with the user editing in Outlook). Cron runs as a single process; no distributed locking.
- **Rate limits are not owned here.** 429 / `rateLimitExceeded` backoff (per account) is Epic 9's; write-back surfaces the transport error rather than implementing its own retry policy.

## UX & Interaction Patterns

- No UX design contract exists; behaviour is CLI/log-derived.
- Writes are silent on success (progress/cycle summaries are orchestration concerns). Failures degrade gracefully — an unresolved or 404'd message costs one warning and is skipped, never an aborted batch or silent crash.
- Every warning carries the account name and message ID so a user can reconcile it in their client.

## Cross-Story Dependencies

- **Upstream.** Epic 1 supplies `MessageDTO` (with `accountId`, existing labels), `LabelSet`, `LabelDef`, `MailPort`, and DI wiring. Epic 4 guarantees the taxonomy labels already exist as M365 categories / Gmail labels and owns the per-account Gmail name→ID cache. Epic 5 supplies fetched `MessageDTO`s carrying current labels. Epic 6 supplies the validated `LabelSet` (names only) from a single classification call.
- **Downstream.** Epic 8 drives `writeLabels` inside backfill and cron (fetch → classify → write → state). Epic 9 owns 429 backoff around the write call; Epic 10 records labeled/skipped/errored counts in its per-cycle summaries.
- **In-epic.** 7.1 and 7.2 are independent per provider and can land in either order; both depend on the shared `MailPort.writeLabels` contract.
- **Deferred.** Label re-apply policy when a user manually removes a skill-applied label is an open question — v1 design is add-only; revisit on user friction.
