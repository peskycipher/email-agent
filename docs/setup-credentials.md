# Credential setup guide (Microsoft Graph + Ollama + TypeSafe)

This project needs three credential sets:

1. Microsoft Graph app credentials (for mailbox ingest/apply)
2. Ollama Cloud API key (second-pass classifier)
3. TypeSafe API key (JEV System1 first-pass classifier)

Use `.env` locally; never commit real secrets.

---

## 0) Prepare local env file

From repo root:

```bash
cp .env.example .env
```

Open `.env` and fill values as you complete the steps below.

Load it into your shell before running the CLI:

```bash
set -a; source .env; set +a
```

---

## 1) Microsoft Graph setup (app registration)

The code uses **client credentials** (`tenant/client/secret`) and calls Graph as an app.

### 1.1 Pick the pilot mailbox

Choose the mailbox to clean first (example: `pilot@example.com`).
Set this in `.env`:

```bash
MAILBOX_ACCOUNT=pilot@example.com
```

### 1.2 Create an Entra app registration

1. Go to Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name it (example: `email-cleanup-agent-v1`).
3. Account type: single-tenant is usually best for internal use.
4. Create.

Copy these values into `.env`:

```bash
M365_TENANT_ID=<Directory (tenant) ID>
M365_CLIENT_ID=<Application (client) ID>
```

### 1.3 Create a client secret

1. In the app: **Certificates & secrets** → **New client secret**.
2. Create and copy the **Value** immediately.
3. Save into `.env`:

```bash
M365_CLIENT_SECRET=<secret value>
```

### 1.4 Grant Graph permissions

1. In app: **API permissions** → **Add a permission** → **Microsoft Graph**.
2. Choose **Application permissions**.
3. Add **Mail.ReadWrite**.
4. Click **Grant admin consent**.

### 1.5 (Recommended) Restrict app access to the pilot mailbox

Even with app-wide Graph permission, you should scope access to the pilot mailbox only (or a tight mailbox group) using your tenant’s Exchange controls (Application Access Policy or the current RBAC/scoping model in your tenant).

Ask your M365 admin to apply and validate this restriction before live apply runs.

---

## 2) Ollama Cloud API key

1. Open <https://ollama.com>.
2. Sign in → Settings → Keys.
3. Create a key.
4. Put it in `.env`:

```bash
OLLAMA_API_KEY=<your key>
```

Optional quick check:

```bash
curl -sS https://ollama.com/v1/models \
  -H "Authorization: Bearer $OLLAMA_API_KEY" \
  -H "Content-Type: application/json" | head
```

---

## 3) TypeSafe API key (JEV System1)

1. Open <https://typesafe.ai>.
2. Create an API key with access to `jev-latest`.
3. Put it in `.env`:

```bash
TYPESAFE_API_KEY=<your key>
```

Optional endpoint override (normally leave default):

```bash
# TYPESAFE_API_URL=https://api.typesafe.ai
```

Optional quick check:

```bash
curl -sS https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"jev-latest",
    "state":{
      "request":"Classify: Invoice due Friday",
      "conversation_excerpt":null,
      "environment":{"cwd":null,"active_model":null,"context_tokens_used":null},
      "budget":{"spent_today_usd":0,"spent_this_month_usd":0,"daily_cap_usd":null,"monthly_cap_usd":null,"fraction_of_budget_used":0}
    },
    "questions":{
      "email_category":{
        "type":"choice",
        "instructions":"Classify the email in request into exactly one category.",
        "criteria":{
          "Action Needed":"requires a response or action",
          "Waiting/Follow-up":"waiting on someone else / follow-up",
          "FYI/Reference":"informational",
          "Bulk/Archive":"newsletter/promo/bulk"
        }
      }
    }
  }' | head
```

---

## 4) Smoke test the whole setup

From repo root (after `source .env`):

```bash
node src/cli.ts dry-run --config ./config.example.json --limit 5
```

You should see:
- `dry-run complete: ingested ...`
- a `plan artifact: ...`
- a `run record: ...`

No mailbox changes happen in dry-run.

---

## 5) Security checklist

- Keep `.env` local only (gitignored).
- Do not paste secrets into issues/PRs/logs.
- Rotate keys/secrets if exposed.
- Use short-lived pilot credentials first, then rotate before broader rollout.
