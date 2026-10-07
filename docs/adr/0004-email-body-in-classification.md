# The email body is included in classification

The original V1 scope carried subject and sender only, which forced every
classification and keyword decision to work from a truncated signal — long
threads where the actionable request lives in the body looked like noise. We
expanded the mailbox contract with an optional plain-text `body`, and the
classifier now evaluates it: the JEV state includes `body`, the Ollama
second-pass prompt includes a `Body:` line, and keyword rules fall back to the
body when the subject has no match (the rationale trace records which field
matched, e.g. `keyword rule: … (body)`).

Two constraints keep the expansion from widening the blast radius:

- **No-touch protection still reads the subject only** for finance/legal
  keywords. Protection is the safety-critical side of the system, and the spec
  ties that rule to the subject; a body-only match must not silently protect or
  unprotect mail.
- **Bodies are bounded and text-only.** The M365 adapter requests
  `bodyPreview` by default (`bodyMode: "full"` asks for the HTML body and strips
  tags) and truncates to `bodyMaxChars` (default 4000) before the body leaves the
  adapter, so model payloads and the persisted ingest snapshot stay bounded.

Consequences: ingest snapshots and plan artifacts grow to include bodies;
enabling full-body mode increases Graph payload size; and classifiers that see
the body can change category, so existing dry-run plans should be regenerated
after switching body modes.