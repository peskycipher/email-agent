# email-agent

A safety-first inbox cleanup agent. V1 targets a single pilot **Microsoft 365** mailbox: it plans a cleanup as a dry run, waits for you to approve it category by category, then applies only the approved, low-risk actions (categorize and archive). Every action is audited, and nothing is ever deleted.

Gmail and the other mailboxes are deferred until the pilot passes a measured rollout gate. See [`SPEC-email-cleanup-agent-v1.md`](SPEC-email-cleanup-agent-v1.md) for the full spec.

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
2. **Deterministic rules** (existing mailbox categories, subject keywords).
3. **JEV System1** first pass: a cheap, high-throughput model call that returns a category and a confidence.
4. **Ollama Cloud** second pass, only for low-confidence items: `deepseek-4.1-flash`, falling back to `glm-5.3-flash` if the call fails. If System1 itself is unavailable, a local keyword classifier takes its place and still escalates uncertain items. If both Ollama models fail, the item keeps its System1 category and the failure is recorded in its rationale trace.

## Requirements

- Node.js **22.18 or newer** (or 23.6+). The CLI runs TypeScript directly through Node's built-in type stripping, so there is no build step. Older 22.x releases need `--experimental-strip-types`. The project is developed on Node 26.
- No runtime dependencies. `typescript` is a dev dependency used for type checking only.
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

## Usage

Run the CLI with `node src/cli.ts <command>` or `npm start -- <command>`.

### 1. Dry run

```bash
node src/cli.ts dry-run --config ./config.json --limit 500
```

Reads the inbox, classifies it, applies the no-touch policy, and writes a plan. **It makes zero changes to the mailbox.** `--limit` defaults to 50 and caps how many messages are ingested.

It prints the paths of the plan artifact and run record. Review the plan, including the exception queue, before moving on.

### 2. Approve and apply

```bash
node src/cli.ts live-apply \
  --plan data/plans/<plan-id>.json \
  --config ./config.json \
  --approve-category "Bulk/Archive" \
  --approve-category "FYI/Reference" \
  --reject-category "Action Needed"
```

You must give an explicit decision for **every** category that appears in the plan. A missing decision is an error, so nothing is applied by accident. Rejected categories leave mail untouched. Each live run is linked to the dry-run plan it came from.

Even with a category approved, an archive for any message in the exception queue is blocked, not sent. It is logged as `blocked:no-touch` and counted as a no-touch miss.

### 3. Check the rollout gate

```bash
node src/cli.ts gate --run data/runs/<live-run-id>.json
```

Prints each condition and whether expansion is allowed:

```
evidence: cumulative across 3 run(s)
processed >= 500: true (612)
precision >= 98%: true (0.99)
no-touch misses = 0: true (0)
sign-off go: false
allowed: false
```

Evidence is **cumulative across live runs for the account**: `gate` scans the account's live run records and unions processed message ids and sums archive attempts, successes, and misses. It reports the evidence source — `cumulative across N run(s)` or `run record` (the fallback when a run carries no cumulative evidence).

### Other commands

```bash
node src/cli.ts --help
node src/cli.ts --version
node src/cli.ts demo --config ./config.json   # writes one sample audit record, no mailbox access
```

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
V1 has no command that expands to other mailboxes, so the gate is the evidence you check before doing that yourself.

Record the sign-off with the CLI:

```bash
node src/cli.ts sign-off \
  --run data/runs/<live-run-id>.json \
  --decision go \
  --actor you@example.com \
  --note "Spot-checked 50 traces, all fine."
```

The decision (or `no-go`) is written to `signoffs/<run-id>.json`; the run record stays untouched. `gate` picks it up on the next evaluation.

## Development

```bash
npm test            # node --test (no network; adapters and models are stubbed)
npm run typecheck   # tsc --noEmit
```

Tests exercise behavior through the orchestrator seam (`src/orchestrator.ts`, which re-exports the dry-run and live-apply entry points) with stubbed mailbox and model clients.

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
  apply.ts           approval gating and live apply
  metrics.ts         run metrics
  report.ts          run report
  gate.ts            expansion gate, sign-off, and cumulative evidence scan
  audit.ts           append-only audit writer
  config.ts          config loading and validation
test/                behavior tests
```

## Known limits

- **Subject and sender only.** The mailbox contract carries no message body, so classification and finance/legal keyword matching read the subject and sender. Adding a body field is a change at the adapter seam.
- **Stubbed integrations.** The Graph, JEV System1, and Ollama Cloud clients are covered by stubbed tests. A real run needs live credentials.
- **Microsoft 365 only.** The adapter contract is provider-neutral so Gmail can follow, but only M365 is implemented.

## Project docs

- [`GLOSSARY.md`](GLOSSARY.md): the repo's domain language (single-context)
- [`docs/adr/`](docs/adr): decision records (no-delete V1, classification pipeline, immutable gate evidence)
- [`SPEC-email-cleanup-agent-v1.md`](SPEC-email-cleanup-agent-v1.md): problem, solution, user stories, and decisions
- [`AGENTS.md`](AGENTS.md) and [`docs/agents/`](docs/agents): issue tracker, triage labels, and domain-doc conventions
