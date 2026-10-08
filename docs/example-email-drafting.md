---
name: email-drafting
description: Use when composing, replying to, or drafting any email on behalf of the user. Covers tone, structure, sign-off conventions, and templates for common email types.
---

# Email Drafting

Draft emails that sound like the user wrote them — concise, enthusiastic, and human. Never sound robotic or AI-generated.

## Voice & Style

- **Concise**: Get to the point fast. No filler sentences, no "I hope this email finds you well."
- **Enthusiastic**: Warm and energetic without being over-the-top. Use exclamation marks sparingly but naturally.
- **Human**: Write like a real person. Vary sentence length. Use contractions. Avoid corporate jargon.
- **Direct**: Lead with the key information or ask. Context comes after, not before.

### What to Avoid

- Robotic phrasing: "As per our previous conversation", "Please find attached", "I wanted to reach out"
- Excessive hedging: "I was just wondering if maybe..."
- Over-formality: "Dear Sir/Madam", "Yours sincerely"
- AI tells: Overly structured bullet points in casual emails, unnaturally perfect grammar in quick replies, or generic filler

## Sign-off

Use the user's configured sign-off as the source of truth — the sign-off captured during onboarding and stored in the parent `AGENTS.md` / `/memories/AGENTS.md`. Apply it to both internal and external emails.

Only when no sign-off is configured, fall back to this neutral default:

```
Best regards,
[Your name]
```

## Structure by Email Type

### Quick Reply / Acknowledgment

- 1–3 sentences max
- No greeting needed if it's a thread reply
- Example: "Got it, thanks! I'll take a look this afternoon."

### Meeting Request

- State the purpose in one line
- Propose 2–3 specific times (use calendar availability)
- Keep it short

### Meeting Follow-up

- Thank attendees briefly
- Summarize key decisions or action items (bullet points)
- Call out next steps and owners

### Introduction / Outreach

- One line of context on who the user is
- Why they're reaching out (be specific)
- Clear ask or next step
- Keep under 5 sentences total

### Decline / Can't Attend

- Brief and polite
- Offer an alternative if possible (different time, async update)
- Don't over-apologize

### Escalation / Urgent

- Lead with the issue and impact
- State what's needed and by when
- Keep emotion out — facts and urgency speak for themselves

## Formality Calibration

| Context | Tone |
| --- | --- |
| Internal team (colleagues, reports) | Casual, friendly, direct |
| Cross-team or leadership | Professional but warm |
| External (clients, partners, vendors) | Professional, enthusiastic, polished |
| Sales / cold outreach | Confident, value-first, concise |
| Personal contacts | Warm, natural, conversational |

Adjust naturally — don't switch styles jarringly within a thread. Match the tone of the thread if replying.

## Templates

### Template: Meeting Request

```
Hi [Name],

Would love to chat about [topic]. Are any of these times open for you?

- [Option 1]
- [Option 2]
- [Option 3]

Happy to adjust if none of these work!

Best regards,
[Your name]
```

### Template: Meeting Follow-up

```
Hi everyone,

Thanks for the great discussion! Here's a quick recap:

- [Decision/takeaway 1]
- [Decision/takeaway 2]

Next steps:
- [Action item] — [Owner] by [Date]

Let me know if I missed anything.

Best regards,
[Your name]
```

### Template: Introduction

```
Hi [Name],

I'm [Your name] — [brief context]. I'm reaching out because [specific reason].

[Clear ask or proposed next step.]

Best regards,
[Your name]
```

### Template: Decline

```
Hi [Name],

Thanks for the invite! Unfortunately I can't make it on [date/time]. Would [alternative] work instead?

Best regards,
[Your name]
```

## Gotchas

- Don't over-explain why the user is declining — a brief reason is enough, or none at all.
- When replying in a thread, don't repeat context everyone already has. Jump straight to the new information.
- For sensitive topics (performance, complaints, legal), keep it factual and suggest taking it to a call rather than writing long emails.
- Check if the user has an existing thread before drafting a new email — reply in-thread when possible to keep context together.
- Never include internal meeting notes, calendar details, or private information in outbound emails unless the user explicitly says to.
