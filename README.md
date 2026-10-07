# email-agent

A safety-first inbox cleanup agent. V1 targets a single pilot **Microsoft 365** mailbox: it plans a cleanup as a dry run, waits for you to approve it category by category, then applies only the approved, low-risk actions (categorize and archive). Every action is audited, and nothing is ever deleted.

Gmail and the other mailboxes are deferred until the pilot passes a measured rollout gate. See [`SPEC-email-cleanup-agent-v1.md`](SPEC-email-cleanup-agent-v1.md) for the full spec.

**Running it:** [How to use](#how-to-use) (the workflow and every command) and [Configuration](#configuration). **Working on it:** [Development](#development), [Known limits](#known-limits), and [Project docs](#project-docs).

## How it works

```
dry-run                                   live-apply                         gate
  ingest inbox (M365 / Graph)               read the dry-run plan              read run metrics
  -> no-touch policy                        require a decision per category    -> 4 conditions
  -> rules                                  skip anything protected            -> allowed / blocked
  -> JEV System1 (first pass)               apply approved categories only
  -> Ollama Cloud (ambiguous only)          write audit + report + metrics
  -> persist plan (zero mutations)
```

- **Categories.** Every message gets exactly one of: `Action Needed`, `Waiting/Follow-up`, `FYI/Reference`, `Bulk/Archive`.
- **Actions.** Only `classify` (categorize) and `archive` exist. There is no delete code path, and tests enforce that at compile time and runtime.
- **Zero unread, where allowed.** Protected messages are never archived. They go to an exception queue for you to handle by hand.

### Decision order

Each step only handles what the earlier ones left unresolved. Model output never overrides a rule or a no-touch protection.

1. **No-touch policy** (hard rules, always first). Protected from archive:
   - senders on your VIP list (exact address match, case-insensitive)
   - flagged or starred messages
   - messages from the last 7 days (configurable, boundary inclusive)
   - messages whose subject contains a finance or legal keyword (case-insensitive substring)
   - messages with an unparseable date (fails closed)
2. **Deterministic rules** (existing mailbox categories, subject keywords, then body keywords when the subject has no match).
3. **JEV System1** first pass: a cheap, high-throughput model call that returns a category and a confidence.
4. **Ollama Cloud** second pass, only for low-confidence items: `deepseek-4.1-flash`, falling back to `glm-5.3-flash` if the call fails. If System1 itself is unavailable, a local keyword classifier takes its place and still escalates uncertain items. If both Ollama models fail, the item keeps its System1 category and the failure is recorded in its rationale trace.

## Requirements

- Node.js **22.18 or newer** (or 23.6+). The CLI runs TypeScript directly through Node's built-in type stripping, so there is no build step. Older 22.x releases need `--experimental-strip-types`. The project is developed on Node 26.
- One runtime dependency: [`ora`](https://github.com/sindresorhus/ora) for the terminal spinner. `typescript` is a dev dependency used for type checking only.
- Credentials for the services below.

## Setup

```bash
npm install
```

### Credentials

Set these as environment variables or in the config file (see [Configuration](#configuration)).

```bash
cp .env.example .env
# edit .env with real values
set -a; source .env; set +a
```

> The CLI does **not** auto-load `.env` by itself (no dotenv). Source it in your shell before running commands, or use your shell profile/secret manager.

| Purpose | Variable | Notes |
| --- | --- | --- |
| Mailbox | `MAILBOX_ACCOUNT` | The pilot mailbox address. Required. |
| Microsoft Graph | `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` | App registration using client credentials. Needed by `dry-run` and `live-apply`. |
| JEV System1 | `TYPESAFE_API_KEY` | Optional `TYPESAFE_API_URL` overrides the default `https://api.typesafe.ai`. |
| Ollama Cloud | `OLLAMA_API_KEY` | Second-pass classifier. |

For config-file based setup, copy the template and edit it: `cp config.example.json config.json` (`config.json` is git-ignored). The CLI **does not** interpolate `${VAR}` placeholders — any unexpanded placeholder in a config file is a load error.

For full step-by-step setup (Microsoft Graph app registration, Ollama key, TypeSafe key), see [`docs/setup-credentials.md`](./docs/setup-credentials.md).

## How to use

Run the CLI with `node src/cli.ts <command>` or `npm start -- <command>`.

### The workflow

The cleanup is a step-by-step loop you drive yourself. Nothing touches the mailbox until you approve a category, and the agent never expands beyond the pilot on its own.

```bash
# 1. Plan — read the inbox, classify, apply no-touch rules. Zero mailbox changes.
node src/cli.ts dry-run --config ./config.json --limit 500

# 2. Review the plan it printed (actions, rationale traces, exception queue).

# 3. Apply — decide every category that appears in the plan.
node src/cli.ts live-apply \
  --plan data/plans/<plan-id>.json \
  --config ./config.json \
  --approve-category "Bulk/Archive" \
  --approve-category "FYI/Reference" \
  --reject-category "Action Needed"

# 4. Check the rollout gate against cumulative pilot evidence.
node src/cli.ts gate --run data/runs/<live-run-id>.json

# 5. Record your go/no-go once the gate thresholds are met.
node src/cli.ts sign-off \
  --run data/runs/<live-run-id>.json \
  --decision go \
  --actor you@example.com \
  --note "Spot-checked 50 traces, all fine."
```

**1. Dry run.** Reads the inbox, classifies every message, applies the no-touch policy, and writes a plan. **It makes zero changes to the mailbox.** `--limit` defaults to 50 and caps how many messages are ingested. It prints the path of the plan artifact and run record — review the plan, including the exception queue, before moving on.

It also prints a summary of what the run just did:
```
Summary
  ingested                 50
  Action Needed            12
  Waiting/Follow-up         8
  FYI/Reference            20
  Bulk/Archive             10
  archives planned         30
  protected (no-touch)      5
  duration                 4.2s
  no-touch reasons
    recent-thread           3
    flagged                 1
    vip-sender              1
```

A run where every message is protected is self-explaining: `archives planned 0` plus the reason breakdown tells you the recent-thread window (or your VIP/keyword lists) is covering the whole batch — raise `--limit` to reach older mail, or lower `recent_days`.

While it works, [`ora`](https://github.com/sindresorhus/ora) spins a status line on **stderr** (`⠋ dry-run: ingesting and classifying`), clearing it before the summary prints. stdout stays clean, so piped output is unaffected; when stderr is not a TTY the spinner writes nothing at all. The total run time is reported as the `duration` row in the summary rather than on the spinner line.

> **If the status line repeats instead of spinning in place**, your terminal is rendering each repaint as its own line instead of honouring the carriage return — the spinner cannot repaint in a renderer that appends. Redirect stderr (`node src/cli.ts dry-run 2>/dev/null`) to silence it, or ask for the single-line mode, which writes the status text once and never repaints.

**2. Approve and apply.** You must give an explicit decision for **every** category that appears in the plan; a missing decision is an error, so nothing is applied by accident. Rejected categories leave their mail untouched, and each live run is linked to the dry-run plan it came from. Even with a category approved, an archive for a protected message is blocked rather than sent: it is audited as `blocked:no-touch` and counted as a no-touch miss.

**3. Check the gate.** `gate` reads cumulative evidence and prints all four expansion conditions (see [Rollout gate](#rollout-gate)).

**4. Sign off.** Only when you are satisfied. The decision is written to `signoffs/<run-id>.json`, so the run record stays immutable, and `gate` picks it up on its next evaluation.

Then repeat 1–3 for the next batch. Evidence accumulates across live runs, so the pilot reaches the 500-processed and precision thresholds over as many runs as it takes. V1 has no command that expands to other mailboxes — the gate is the evidence you check before doing that yourself.

### Command reference

| Command | What it does | Reads/writes the mailbox |
| --- | --- | --- |
| `dry-run [--config <path>] [--limit <n>]` | Ingests, classifies, applies no-touch rules, and writes a plan + run + ingest record. `--limit` default 50. | Reads only |
| `live-apply --plan <path> [--config <path>] --approve-category <name> --reject-category <name>` | Applies approved categories from a plan: `classify` and `archive` only. Repeat the flags per category. | Writes (approved categories only) |
| `gate --run <path-to-run-json>` | Prints the four expansion conditions from cumulative evidence and whether expansion is allowed. | Reads local records |
| `sign-off --run <path-to-run-json> --decision <go\|no-go> [--actor <you>] [--note "..."]` | Records your expansion decision in `signoffs/<run-id>.json`. Invalid decisions and a missing `--run` are errors. | Reads local records |
| `demo [--config <path>] [--message-id <id>]` | Writes one sample audit record to prove the pipeline end to end. | Local only |
| `--help` (or `help`) | Prints the command list. | None |
| `--version` (or `version`) | Prints the version. | None |

All commands accept `--config <path>`, or read `EMAIL_CLEANUP_CONFIG`. Environment variables override values from the file (see [Configuration](#configuration)). `dry-run`, `live-apply`, and `demo` need a config with an account (plus Graph or model credentials where relevant); `gate` and `sign-off` take only the run path.

## Configuration

Settings come from a JSON file (`--config <path>`, or the `EMAIL_CLEANUP_CONFIG` variable). **Environment variables override the file.**

```json
{
  "account": "pilot@example.com",
  "data_dir": "data",
  "audit_log_path": "data/audit.jsonl",
  "vip_senders": ["ceo@example.com", "lawyer@example.com"],
  "finance_legal_keywords": ["invoice", "contract", "tax", "legal", "payment"],
  "recent_days": 7,
  "confidence_threshold": 0.7
}
```

A ready-to-copy version ships as `config.example.json` in the repo root.

| File key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `account` | `MAILBOX_ACCOUNT` | none, required | Mailbox to clean. |
| `data_dir` | `DATA_DIR` | `./data` | Where plans, runs, and sign-offs are stored. |
| `audit_log_path` | `AUDIT_LOG_PATH` | `./data/audit.jsonl` | Append-only audit log. |
| `m365_tenant_id`, `m365_client_id`, `m365_client_secret` | `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` | none | Graph credentials. |
| `vip_senders` | `VIP_SENDERS` | empty | Comma-separated in the environment. Always protected. |
| `finance_legal_keywords` | `FINANCE_LEGAL_KEYWORDS` | empty | Comma-separated in the environment. Subject matches are protected. |
| `recent_days` | `RECENT_DAYS` | `7` | Messages this recent are protected. |
| `confidence_threshold` | `CONFIDENCE_THRESHOLD` | `0.7` | System1 confidence below this escalates to the second pass. |

> **Body inclusion** is configured on the M365 adapter itself (`bodyMode`: `"preview"` (default) or `"full"` for the HTML body with tags stripped; `bodyMaxChars`: default `4000`). See [ADR-0004](docs/adr/0004-email-body-in-classification.md).

> **Set your VIP list and keywords before a real run.** Both default to empty, and an empty list protects nothing. The thresholds and lists in effect are saved into every plan and run record, so each run shows what protected it.

## What gets written

Everything lives under `data_dir` (default `./data`, which is git-ignored).

| Path | Contents |
| --- | --- |
| `audit.jsonl` | Append-only, one JSON object per action. Fields: `timestamp`, `account`, `message_id`, `action`, `category`, `outcome`, `rationale`, `run_id`. A record missing a required field is rejected. |
| `plans/<plan-id>.json` | The dry-run plan: proposed actions, rationale traces, exception queue, config snapshot. |
| `runs/<run-id>.json` | The run record, **immutable once written**. A dry run stores its planned actions and exception queue. A **live run** also stores the report (totals by category and action, unread delta, sample reasoning traces, exception queue snapshot), the metrics, and its own gate-evidence tallies (`message_ids`, `archive_attempt_tallies`) that `gate` unions across runs. |
| `runs/<run-id>-ingest.json` | The messages ingested by a dry run. |
| `signoffs/<run-id>.json` | Your go/no-go decision. Kept separate so run records stay immutable. |

Run metrics are `processed_count`, `archive_precision_estimate`, `no_touch_miss_count`, and category totals. Archive precision is the success rate over archives of non-protected messages (zero attempts reports 0 — no evidence, no pass). A no-touch miss is any blocked archive plus any archive attempt on a protected message. Transient mailbox fetch failures are logged as `failed:mailbox-fetch` and excluded from both precision and miss evidence.

## Rollout gate

Expanding beyond the pilot mailbox is blocked until **all four** hold:

1. at least **500** messages processed
2. archive precision of at least **98%**
3. **zero** VIP or no-touch misses
4. an explicit human **go** sign-off

`gate` reports all four from cumulative persisted evidence: the 500-processed count is the **union of distinct message ids across live runs**, and precision/miss tallies accumulate the same way, so a pilot can cross the thresholds over several runs.

```
evidence: cumulative across 3 run(s)
processed >= 500: true (612)
precision >= 98%: true (0.99)
no-touch misses = 0: true (0)
sign-off go: false
allowed: false
```

It reports the evidence source — `cumulative across N run(s)`, or `run record` (the fallback when a run carries no cumulative evidence).

V1 has no command that expands to other mailboxes, so the gate is the evidence you check before doing that yourself. Record the sign-off with [`sign-off`](#command-reference).

## Development

```bash
npm test            # node --test (no network; adapters and models are stubbed)
npm run typecheck   # tsc --noEmit
```

Tests stub the mailbox adapter and both model clients, so the suite never touches the network. They cover the dry-run, live-apply, metrics, gate, and audit behavior at their module boundaries.

```
src/
  cli.ts             commands and argument parsing
  orchestrator.ts    provider-neutral run seam; re-exports dry_run + apply
  dry_run.ts         dry-run lifecycle: ingest, classify, plan, persist
  apply.ts           live-apply lifecycle: approval gating, no-touch re-check, audit, report
  policy.ts          no-touch rules and exception queue
  classify/          rules, JEV System1, Ollama Cloud, pipeline
  adapter.ts         mailbox contract (provider seam)
  adapter_m365.ts    Microsoft Graph adapter
  metrics.ts         run metrics
  report.ts          run report
  gate.ts            expansion gate, sign-off, and cumulative evidence scan
  audit.ts           append-only audit writer
  config.ts          config loading and validation
test/                behavior tests
```

## Known limits

- **Body inclusion is opt-in per adapter.** The M365 adapter supplies a plain-text body: `bodyPreview` by default, or the full HTML body (tags stripped) with `bodyMode: "full"`. Bodies are truncated to `bodyMaxChars` (default 4000) before classification. Finance/legal keyword *protection* still matches the subject only (per spec), so a protected-topic body alone does not protect a message.
- **Stubbed integrations.** The Graph, JEV System1, and Ollama Cloud clients are covered by stubbed tests. A real run needs live credentials.
- **Microsoft 365 only.** The adapter contract is provider-neutral so Gmail can follow, but only M365 is implemented.

## Project docs

- [`GLOSSARY.md`](GLOSSARY.md): the repo's domain language (single-context)
- [`docs/adr/`](docs/adr): decision records (no-delete V1, classification pipeline, immutable gate evidence)
- [`SPEC-email-cleanup-agent-v1.md`](SPEC-email-cleanup-agent-v1.md): problem, solution, user stories, and decisions
- [`AGENTS.md`](AGENTS.md) and [`docs/agents/`](docs/agents): issue tracker, triage labels, and domain-doc conventions
