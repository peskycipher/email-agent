# Rules-first, confidence-gated classification

Classification cost and safety both demanded a deterministic-first pipeline. We
ordered the decision sequence: hard no-touch rules always win; existing mailbox
categories and subject keywords resolve what they can; JEV System1 handles the
unresolved remainder; Ollama Cloud (`deepseek-4.1-flash`, backup
`glm-5.3-flash`) sees only items returned with confidence below the threshold
(default 0.7). Model output never overrides a rule or a no-touch protection, and
every classification records a structured rationale trace
(policy/rule/model) for the audit log.

Considered options: a single large-model pass over everything (rejected: cost and
no deterministic guarantee over protected mail) and pure rules (rejected: keyword
rules alone misclassify the long tail). Confidence thresholds rather than
confidence values decide escalation, so tuning behavior is a config change, not a
prompt change. Model identities are locked by the repo's models rule
(AGENTS.md): Ollama Cloud and Typesafe Jev only.