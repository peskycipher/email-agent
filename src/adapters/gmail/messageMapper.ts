import type { MessageDTO } from "../../core/dto/MessageDTO.js";

/** Gmail's system label for unread mail; `MessageDTO.isRead` is its absence (Story 5.3). */
const UNREAD_LABEL = "UNREAD";

/** Reads a top-level string field, degrading a missing or non-string value to `""`. */
function readString(entry: unknown, key: string): string {
  if (typeof entry !== "object" || entry === null) return "";
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** Gmail's `labelIds`; a missing or non-array value degrades to `[]` and a non-string member is dropped. */
function readLabelIds(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const labelIds = (entry as Record<string, unknown>).labelIds;
  if (!Array.isArray(labelIds)) return [];
  return labelIds.filter((value): value is string => typeof value === "string");
}

/**
 * Gmail returns `internalDate` as a string of milliseconds since the epoch; the DTO keeps
 * ISO-8601 UTC. A missing, non-string or unparseable value degrades to `""` rather than
 * throwing (`new Date(NaN).toISOString()` would).
 */
function readInternalDate(entry: unknown): string {
  if (typeof entry !== "object" || entry === null) return "";
  const value = (entry as Record<string, unknown>).internalDate;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return "";
  const millis = Number(value);
  if (!Number.isFinite(millis)) return "";
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** The message's `payload.headers` as a lower-cased name → first value map; malformed entries are skipped. */
function readHeaders(entry: unknown): Map<string, string> {
  const headers = new Map<string, string>();
  if (typeof entry !== "object" || entry === null) return headers;
  const payload = (entry as Record<string, unknown>).payload;
  if (typeof payload !== "object" || payload === null) return headers;
  const list = (payload as Record<string, unknown>).headers;
  if (!Array.isArray(list)) return headers;
  for (const header of list) {
    if (typeof header !== "object" || header === null) continue;
    const name = (header as Record<string, unknown>).name;
    const value = (header as Record<string, unknown>).value;
    if (typeof name !== "string" || typeof value !== "string") continue;
    const key = name.toLowerCase();
    if (!headers.has(key)) headers.set(key, value);
  }
  return headers;
}

/**
 * Splits a `From` header into its display name and address: `Name <a@b>` → `("a@b", "Name")`,
 * a bare `a@b` → `("a@b", "")`. Anything ambiguous is treated as the address, so no
 * information is invented; surrounding quotes on the display name are stripped.
 */
function parseSender(value: string): { email: string; name: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { email: "", name: "" };
  const match = /^([\s\S]*)<([^>]*)>\s*$/.exec(trimmed);
  if (match === null) return { email: trimmed, name: "" };
  const name = (match[1] ?? "").trim().replace(/^"(.*)"$/s, "$1").trim();
  return { email: (match[2] ?? "").trim(), name };
}

/**
 * Maps one Gmail message (a `format=metadata` detail) onto the canonical `MessageDTO`.
 * This is the one place Gmail's payload shape is known (Story 5.3): the read is total —
 * a missing or mistyped field degrades to `""`/`[]`, never throws, and never drops a message.
 */
export function mapGmailMessage(entry: unknown, accountId: string): MessageDTO {
  const labelIds = readLabelIds(entry);
  const headers = readHeaders(entry);
  const sender = parseSender(headers.get("from") ?? "");
  return {
    id: readString(entry, "id"),
    internetMessageId: readString(entry, "internetMessageId"),
    subject: headers.get("subject") ?? "",
    bodyPreview: readString(entry, "snippet"),
    senderEmail: sender.email,
    senderName: sender.name,
    receivedDateTime: readInternalDate(entry),
    existingLabels: labelIds,
    source: "gmail",
    accountId,
    // Read state is derivable for every Gmail message, so unlike Graph's optional flag it is always set.
    isRead: !labelIds.includes(UNREAD_LABEL),
  };
}
