# Delete is impossible in V1

The spec optimizes for reversibility: the first cleanup must never destroy
anything. We restricted the V1 action set to `classify` (categorize) and
`archive` — there is no delete action anywhere in the code, and "no delete" is
enforced twice: `delete` is not assignable to the `MailboxAction` or
`AuditAction` unions (compile-time), and the audit writer rejects a delete action
at runtime (`test/delete_impossible.test.ts`).

Consequences: nothing is ever destroyed in V1 — archiving only moves mail out of
the inbox into the standard Archive folder (a classification action rewrites
labels), the agent exposes no restore path and no delete path, only messages
carrying an archive-safe label with no veto label archive (`Newsletters`,
`Promos`, `Notifications`, `Subscriptions`, `IT News`), and deleting messages
later means a new decision with its own ADR.