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

Even with app-wide Graph permission, restrict this app to only the pilot mailbox (or a tiny mailbox scope).

#### Option A: Application Access Policy (widely used)

> Run these as an Exchange admin in Exchange Online PowerShell.

1. Connect to Exchange Online:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline
```

2. Create (or reuse) a **mail-enabled security group** for the allowed scope:

```powershell
New-DistributionGroup -Name "EmailCleanupPilotScope" -Alias "EmailCleanupPilotScope" -Type Security
```

3. Add only the pilot mailbox (or a small allow-list) to that group:

```powershell
Add-DistributionGroupMember -Identity "EmailCleanupPilotScope" -Member "pilot@example.com"
```

4. Create the app access policy for your app registration:

```powershell
New-ApplicationAccessPolicy \
  -AppId "<M365_CLIENT_ID>" \
  -PolicyScopeGroupId "EmailCleanupPilotScope@yourdomain.com" \
  -AccessRight RestrictAccess \
  -Description "Limit email-cleanup app to pilot mailbox scope"
```

5. Validate access is allowed for pilot mailbox and denied outside scope:

```powershell
Test-ApplicationAccessPolicy -Identity "pilot@example.com" -AppId "<M365_CLIENT_ID>"
Test-ApplicationAccessPolicy -Identity "someoneelse@example.com" -AppId "<M365_CLIENT_ID>"
```

Expected: pilot mailbox = **Allowed**, non-scoped mailbox = **Denied**.

6. Wait for propagation (can take several minutes), then run a small `dry-run --limit 5` smoke test.

#### Option B: Exchange RBAC for Applications (newer model)

If your tenant uses the newer RBAC/scoping model instead of application access policies:

1. Register/confirm the app service principal in Exchange.
2. Create a recipient management scope for only the pilot mailbox (or small mailbox group).
3. Assign the app role to that service principal with that custom scope.
4. Validate access with your tenant’s RBAC test workflow, then run a small `dry-run --limit 5` smoke test.

Ask your M365 admin to use the model your tenant has standardized on and to validate deny-by-default behavior outside the pilot scope before any live apply run.

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
      "subject":"Invoice due Friday",
      "from":"billing@example.com",
      "received_at":"2026-01-01T00:00:00.000Z",
      "unread":true,
      "flagged":false,
      "existing_categories":[],
      "body":null
    },
    "questions":{
      "Action Needed":{"type":"noul","instructions":"Does this email belong to the label \"Action Needed\"?","criteria":"requires a response or action from the recipient"},
      "Invoices":{"type":"noul","instructions":"Does this email belong to the label \"Invoices\"?","criteria":"an invoice, bill, receipt, payment request, or payment confirmation"}
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
