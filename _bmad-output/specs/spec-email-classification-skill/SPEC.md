---
id: SPEC-email-classification-skill
companions:
  - taxonomy.yaml
  - glossary.md
  - architecture-diagrams.md
sources:
  - _bmad-output/planning-artifacts/prds/prd-email-agent-2025-01-15/prd.md
  - _bmad-output/planning-artifacts/architecture/architecture-email-agent-2025-01-15/ARCHITECTURE-SPINE.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Email Classification Agent Skill

## Why

**Pain to solve + Vision to realize.** A solo technical user (Loki) has 8000+ unread emails across M365 (work) and Gmail (personal) with no systematic classification. Existing tooling is either rigid (rules/filters) or heavy (paid SaaS). The user needs a local, model-agnostic CLI skill that classifies messages against an 11-label taxonomy using Jev System1 (default), writes native labels back to both mail systems (M365 categories, Gmail labels), handles backfill + ongoing cron classification, and is architected so the classification core can be dropped into any harness (Cloudflare Worker, MCP server) without rewrite. This classification engine is the foundation for a future fully autonomous email agent.

## Capabilities

- **CAP-1**
  - **intent:** User can authenticate to M365 (Graph, read+write via device code / cached token) and Gmail (OAuth user consent flow) with tokens stored securely in OS keychain (encrypted file fallback).
  - **success:** `email-classify --auth m365` and `--auth gmail` complete without error; subsequent runs reuse cached tokens with silent refresh on expiry.

- **CAP-2**
  - **intent:** System ensures the 11-label taxonomy exists as native M365 master categories (with preset colors) and Gmail labels (with hex colors) on startup, idempotently.
  - **success:** `GET /me/outlook/masterCategories` and `users.labels.list` return all 11 labels after first run; re-running creates no duplicates.

- **CAP-3**
  - **intent:** System fetches messages from M365 and Gmail in configurable batches (default 50, max 100), with pagination and incremental polling (M365: `$filter=receivedDateTime ge`; Gmail: `history.list` with `startHistoryId`).
  - **success:** Backfill processes all messages in configured folders; cron mode fetches only messages since last successful run; both respect rate limits with exponential backoff.

- **CAP-4**
  - **intent:** System classifies a message (subject, bodyPreview ≤2000 chars, sender, receivedDateTime, existing labels) against the 11-label taxonomy via a pure, model-agnostic function using the configured model (default: Jev System1), returning a multi-label set (subset of taxonomy, empty allowed).
  - **success:** Single model call per message; output validates against strict JSON schema `{ "labels": string[] }` with Zod; invalid responses retried (max 2); temperature 0.1 for determinism.

- **CAP-5**
  - **intent:** User can swap the classification model (Jev System1 → GPT-4o-mini, Claude, local Ollama, etc.) by changing only the model config (provider, model, apiKeyEnvVar, temperature, maxTokens, extraParams) — no code changes.
  - **success:** Classification works with at least one non-Jev model via config-only change; `ModelPort` adapter pattern verified.

- **CAP-6**
  - **intent:** System writes classified labels back to the source mailbox as native M365 categories (`PATCH /messages/{id}` with `categories` union) and Gmail labels (`users.messages.modify` with `addLabelIds`), idempotently (only adds missing, never removes user-applied labels).
  - **success:** Labels visible in Outlook/Gmail UI; re-running on same messages produces zero duplicate labels; 404 on moved/deleted messages logged and skipped.

- **CAP-7**
  - **intent:** User can run one-shot backfill (`--backfill --source m365|gmail|all [--since ISO-date] [--batch-size N]`) that processes historical messages in batches, resumable via SQLite idempotency store (key = sha256(internetMessageId + "|" + sorted(labels))), with rate-limit handling (exponential backoff 2s–60s, max 5 retries).
  - **success:** 8000+ messages classified and labeled within 7 days; interrupt (SIGINT) saves progress; re-run with same args resumes.

- **CAP-8**
  - **intent:** User can run cron mode (`--cron --interval 15 --source m365|gmail|all`) that loops: fetch incremental → classify → write labels → update state → sleep interval, with graceful shutdown on SIGINT/SIGTERM (finish current message, flush logs, save state, exit 0 within 5s).
  - **success:** New messages labeled within 15 minutes of arrival; classification errors re-queue message for next cycle; fetch/write errors back off 30s and retry once.

- **CAP-9**
  - **intent:** System emits structured JSON logs (timestamp, level, source, message, context) to stdout and rotating daily files (max 7 days, 100MB each), plus per-cycle metrics summary (processed, labeled, skipped, errored, avgLatencyMs, tokens in/out, estimatedCostUSD).
  - **success:** All log lines parse as JSON; metrics summary logged at info level on every backfill/cron completion; log level configurable via `--log-level`.

- **CAP-10**
  - **intent:** System loads a single YAML config file (`~/.config/email-classify/config.yaml`) at startup, validates via Zod, freezes it, and passes to all components via DI; env var overrides supported (`EMAIL_CLASSIFY_<SECTION>_<KEY>`).
  - **success:** CLI exits with clear error on invalid config; all paths support `~` expansion; env overrides work for any field.

## Constraints

- **Local-first, zero-infra v1** — runs on user's machine via cron; no serverless, Docker, or always-on server. Cloudflare Worker / MCP = v2+.
- **Hexagonal architecture** — Skill Core (classification) is pure function with zero I/O, zero deps; all I/O in adapters implementing ports (MailPort, ModelPort, TokenPort, IdempotencyPort, SchedulerPort, LogPort, ConfigPort).
- **Single shared MessageDTO** — all adapters map to/from one canonical shape (`id`, `internetMessageId`, `subject`, `bodyPreview`, `sender`, `receivedDateTime`, `existingLabels`, `source`, `raw?`); prevents translation drift.
- **Dependency direction enforced** — `core/` (zero deps) ← `adapters/` (depend on core ports) ← `cli/` (wires all). Enforced via tsconfig project references and the oxlint `no-restricted-imports` rule in `.oxlintrc.json` (run by `bun run lint`).
- **Multi-label by default** — classification returns a set of labels from the 11-label taxonomy; empty set valid.
- **Idempotency required** — backfill and cron must be safely re-runnable; key = sha256(internetMessageId + "|" + sorted(labels)).
- **Never remove user-applied labels** — label write only adds missing taxonomy labels; preserves existing categories/labels.
- **Single-user, single-account per provider** — no multi-tenancy, no multi-account.
- **Cron/poll only** — no push/webhook real-time (Graph subscriptions, Gmail push = v2).
- **OS keychain for tokens** — encrypted file fallback (`age`) only; no separate secrets manager.

## Non-goals

- Autonomous actions (archive, delete, reply, forward, move to folders) — vision only.
- Dashboard / web UI — labels live in native mail clients.
- Multi-user / multi-tenancy / multi-account per provider.
- Push/webhook real-time classification (Graph subscriptions, Gmail push).
- Conversation/threading awareness — per-message classification only.
- Encryption at rest beyond OS keychain + age fallback.
- Eval/benchmark framework — manual spot-check v1; eval harness = v2.
- Cloudflare Worker / MCP deployment — documented as v2 harness swap.
- Attachment parsing / OCR for Invoices label — bodyPreview only v1.

## Success signal

- **World-change moment:** User opens Outlook/Gmail after first backfill + cron run and sees their 8000+ previously-unread emails color-coded by the 11-label taxonomy, with new mail labeled within 15 minutes — all running locally on their machine with zero cloud infra, and the classification core portable to any harness by config-only model swap.

## Assumptions

- M365 token cache persists across CLI invocations via MSAL or custom cache; device code flow only for initial auth.
- Gmail OAuth client ID/secret stored in config (not secret manager); user creates in Google Cloud Console.
- Taxonomy definitions (descriptions, colors) are stable; changes require re-sync of master categories/labels.
- M365 `internetMessageId` is stable and unique per message (RFC 5322); used as idempotency key component.
- Gmail `internetMessageId` from message payload headers matches RFC 5322; used for idempotency.
- Jev System1 accepts the prompt format and returns valid JSON without additional parsing; few-shot examples sufficient.
- 2000-char bodyPreview captures enough signal for 11-label classification; full body not needed.
- M365 `categories` array update is atomic and preserves order; no race condition with user manually editing in Outlook.
- SQLite idempotency store at `~/.config/email-classify/idempotency.db` is single-writer (only one CLI instance at a time).
- Cron mode runs as single process; no distributed locking needed.
- Jev token pricing estimated at placeholder; actual cost tracked when pricing published.
- Config file location `~/.config/email-classify/config.yaml` follows XDG Base Directory spec.

## Open Questions

- **Gmail historyId expiry fallback**: Gmail `historyId` can expire (~7 days). If cron stops >7 days, incremental fetch fails. Mitigation: fall back to full Inbox list on history gap. Need to confirm behavior and implement fallback.
- **M365 delta query vs. filter**: `$filter=receivedDateTime ge ...` may not capture moved messages. Delta query (`/messages/delta`) is more robust but requires state token. Evaluate for v1.1.
- **Label conflict resolution**: If user manually removes a label the skill applied, should skill re-apply on next cron? Current design: only adds missing, never removes. Confirm desired.
- **Attachment handling for Invoices label**: Current input uses `bodyPreview` only. Some labels (Invoices) may need attachment parsing. Deferred to v2.
- **Cost tracking accuracy**: Jev pricing not public; estimate based on token count. Need actual pricing when available.