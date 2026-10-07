---
title: "Email Classification Agent Skill"
status: draft
created: "2025-01-15"
updated: "2025-01-15"
---

# Product Brief: Email Classification Agent Skill

## Executive Summary

A model-agnostic AI agent skill that classifies emails from Microsoft 365 and Gmail using multi-label taxonomy (11 labels), starting with Typesafe Jev System1 as the default model. V1 tackles an 8000+ email backfill plus ongoing cron-based classification, writing native mailbox labels (M365 categories / Gmail labels) via a local CLI. The skill is architected for model/harness agnosticism so the classifier can swap models or run in any harness — Jev System1 is today's configured default, not a hard dependency. Vision: autonomous email management (triage, draft, act) once classification is trustworthy.

## The Problem

- **8000+ unread emails** in one M365 inbox alone — real, immediate pain. Manual triage is impossible at this volume.
- **No systematic classification** exists today. Emails pile up; important items (invoices, action items, family) get buried.
- **Two mail systems** (M365 + Gmail) with no unified view or automation.
- **Existing tooling is either too rigid** (rules/filters) or **too heavy** (full email clients, paid SaaS). Need a lightweight, programmable skill that runs locally, uses a strong reasoning model (Jev System1), and writes labels back to the native mailbox so they're visible everywhere.

## The Solution

A **local CLI skill** (Node/TypeScript or Python) that:

1. **Authenticates** to M365 (Graph, already configured with read+write) and Gmail (OAuth user consent flow, tokens stored locally).
2. **Fetches** unread/recent messages in batches (respecting rate limits).
3. **Classifies** each message via Jev System1 (default) against the 11-label taxonomy — **multi-label output** (an email can be *Action Needed + Business + Crypto*).
4. **Writes labels** back as native M365 categories and Gmail labels (visible in Outlook/Gmail UI).
5. **Runs on cron** (configurable interval, e.g., every 15 min) for new mail; includes a **one-shot backfill mode** for the 8000+ existing emails with idempotency (skip already-labeled).
6. **Exposes the classifier as a reusable skill** — prompt + schema + model config — so it can be dropped into any harness (local, Cloudflare Worker, MCP server) without rewrite.

## What Makes This Different

- **Model-agnostic skill architecture** — the classification logic (prompt, schema, label definitions) is decoupled from the model/harness. Jev System1 is the v1 default; swap to GPT-4o, Claude, or a local model by changing config.
- **Native label write-back** — labels appear in the user's actual mail clients, not a side dashboard.
- **Multi-label by default** — reflects real email semantics (an invoice from a crypto business *is* Invoices + Crypto + Business).
- **Local-first, zero-infra v1** — runs on the user's machine via cron. No serverless, no Docker, no always-on server. Cloudflare Worker / MCP are explicit v2+ paths.
- **Backfill-aware** — idempotent, resumable, rate-limit-friendly for 8k+ existing messages.

## Who This Serves

**Primary:** Loki (sole user, technical, owns the inboxes). Pain: 8000+ unread, two mail systems, wants programmable control.
**Secondary (future):** Anyone with M365/Gmail who wants local, model-agnostic email classification — the skill is portable.

Success for Loki: inbox goes from "unmanageable" to "labeled and triageable" within a week of v1 running.

## Success Criteria

- **Backfill completes**: 8000+ existing emails classified and labeled in M365 (Gmail added when connected) within 7 days of v1 launch, with <5% error rate on manual spot-check.
- **Ongoing cron**: New emails labeled within 15 minutes of arrival (cron interval), zero missed messages.
- **Multi-label accuracy**: ≥90% of spot-checked emails have correct label sets (human judgment).
- **Model swap verified**: Skill runs with at least one non-Jev model (e.g., GPT-4o-mini) by changing only config.
- **Zero infra cost** for v1 (local only).

## Scope

**In for v1:**
- Local CLI (TypeScript or Python) with `classify --backfill` and `classify --cron` modes
- M365 Graph auth (read+write, existing setup) + Gmail OAuth user consent
- 11-label taxonomy, multi-label output schema
- Jev System1 integration (API key from env), model config abstraction
- Native label write: M365 categories, Gmail labels
- Cron-friendly: idempotent, resumable, rate-limit aware, structured logs
- Skill package: prompt, schema, label definitions, model config — portable to other harnesses

**Explicitly out for v1:**
- Gmail push/webhooks (cron only)
- Autonomous actions (archive, reply, forward, delete) — vision only
- Dashboard/UI — labels live in the mail client
- Multi-user / multi-tenancy
- Cloudflare Worker / MCP server deployment (documented as v2 path)
- Advanced deduplication / threading awareness (basic message-ID tracking only)
- Encryption at rest for tokens (OS keychain assumed sufficient)

## Vision

**2–3 years:** The skill becomes the **classification engine** for a fully autonomous email agent. It runs continuously (MCP server or Worker), classifies in real time, and *acts*: archives newsletters/promos, drafts replies for "Action Needed," flags invoices for accounting, summarizes "Waiting/Follow-up" threads weekly, and learns from user corrections (few-shot updates to the prompt). The label taxonomy expands organically; the model improves via eval-driven prompt iteration. The user never sees an unread count above zero — the agent handles it.

---

[DECISION] Gmail OAuth tokens stored in OS keychain or local encrypted file; no separate secrets manager.
[DECISION] Jev System1 API accessed via `TYPESAFE_API_KEY` env var (already in `~/.bash.d/apiKeys`).
[DECISION] Classification prompt fits in single Jev call per email; no chaining or tool use needed.
[DECISION] M365 Graph API confirmed: custom categories via `POST /me/outlook/masterCategories` (displayName + preset color), applied via message `categories` string[] property. Multi-label native. No fallback needed.
[DECISION] Cron interval default 15 min; user can override via config file.
[DECISION] Backfill processes in batches of 50–100 to respect Graph/Gmail rate limits; exponential backoff on 429.
[DECISION] Idempotency key = message-ID + label set hash; re-running backfill is safe.
[DECISION] Skill written in TypeScript (Node) for typesafety with Jev SDK; Python acceptable if preferred.
[DECISION] Structured JSON logs to stdout + rotating file; no external observability in v1.
[DECISION] No eval framework in v1; manual spot-check is the quality gate. Eval harness = v2.