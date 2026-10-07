# Glossary

Downstream workflows and readers must use these terms exactly. SPEC.md, companions, and implementation code use these terms verbatim; introducing a synonym anywhere is a discipline violation.

- **Skill** — The portable classification unit: prompt template, JSON output schema, label definitions, model configuration. Harness-agnostic; can run in local CLI, Cloudflare Worker, MCP server, etc.

- **Harness** — The runtime that executes the skill (local Node CLI, Cloudflare Worker, MCP server). Provides auth, scheduling, I/O, logging.

- **Taxonomy** — The fixed set of 11 labels: `Action Needed`, `Waiting/Follow-up`, `Important`, `Invoices`, `Crypto`, `Business`, `Family/Friends`, `Newsletters`, `Promos`, `Notifications`, `Real-estate`. Defined in `taxonomy.yaml`.

- **Label Set** — The multi-label output for a single email: a subset of the Taxonomy (e.g., `["Action Needed", "Business", "Crypto"]`). Empty set allowed (no labels match).

- **Master Category (M365)** — An Outlook category defined in the user's master list via `POST /me/outlook/masterCategories` (displayName + preset color). Created once per label at startup.

- **Message Categories (M365)** — The `categories` property on a `message` resource (`string[]`). Updated via `PATCH /messages/{id}` to apply/remove labels.

- **Gmail Label** — A user-created label in Gmail (via Gmail API `users.labels.create`). Applied to messages via `users.messages.modify` with `addLabelIds`.

- **Idempotency Key** — `sha256(message.internetMessageId + "|" + sorted(labelSet).join(","))`. Used to skip re-processing already-classified messages during backfill/resume.

- **Backfill Mode** — One-shot operation that processes all historical messages (configurable date range, default: all) in batches, with resume capability.

- **Cron Mode** — Recurring operation that polls for new/unread messages since last successful run, classifies, and writes labels. Interval configurable (default 15 min).

- **Jev System1** — Typesafe's reasoning model, accessed via `TYPESAFE_API_KEY`. Default model for v1.

- **Model Config** — YAML/JSON object specifying `provider`, `model`, `apiKeyEnvVar`, `temperature`, `maxTokens`, and any provider-specific params.

- **MessageDTO** — Canonical message shape shared across all adapters: `{ id, internetMessageId, subject, bodyPreview, sender, receivedDateTime, existingLabels, source: "m365"|"gmail", raw?: unknown }`.

- **Port** — An interface (TypeScript) defining a contract the Skill Core depends on. Implemented by adapters. Suffix: `Port` (e.g., `MailPort`, `ModelPort`).

- **Adapter** — A concrete implementation of a Port for a specific technology/provider. Suffix: `Adapter` (e.g., `M365Adapter`, `JevAdapter`).

- **Orchestration** — Flow logic that coordinates adapters via ports (backfill, cron, sync). Lives in `src/orch/`.

- **DI Context** — Dependency injection container created at startup that wires ports to adapters and passes the frozen Config to all components.