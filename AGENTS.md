### Models

Only use models from Ollama-Cloud or Typesafe's Jev. No other model providers. This applies to every agent in this project, including code review and any classifier/model calls in the codebase.

### Delegation

Do not use subagents for this project. Work directly in the main agent only.

### Issue tracker

Issues are tracked in GitHub Issues via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default five canonical labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain docs are single-context (root `GLOSSARY.md` + `docs/adr/`). See `docs/agents/domain.md`.
