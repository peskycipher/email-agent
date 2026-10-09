import type { MessageDTO } from "../../core/dto/MessageDTO.js";

/** Reads a top-level string field, degrading a missing or non-string value to `""`. */
function readString(entry: unknown, key: string): string {
  if (typeof entry !== "object" || entry === null) return "";
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** Reads Graph's nested `from.emailAddress.{address,name}` pair, degrading to empty strings. */
function readSender(entry: unknown): { email: string; name: string } {
  if (typeof entry !== "object" || entry === null) return { email: "", name: "" };
  const from = (entry as Record<string, unknown>).from;
  if (typeof from !== "object" || from === null) return { email: "", name: "" };
  const emailAddress = (from as Record<string, unknown>).emailAddress;
  if (typeof emailAddress !== "object" || emailAddress === null) return { email: "", name: "" };
  const record = emailAddress as Record<string, unknown>;
  return {
    email: typeof record.address === "string" ? record.address : "",
    name: typeof record.name === "string" ? record.name : "",
  };
}

/** A missing or non-array `categories` degrades to `[]`; a non-string member is dropped. */
function readCategories(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const categories = (entry as Record<string, unknown>).categories;
  if (!Array.isArray(categories)) return [];
  return categories.filter((value): value is string => typeof value === "string");
}

/** Optional by contract, so a missing or non-boolean `isRead` is omitted rather than coerced. */
function readIsRead(entry: unknown): boolean | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const isRead = (entry as Record<string, unknown>).isRead;
  return typeof isRead === "boolean" ? isRead : undefined;
}

/**
 * Maps one Microsoft Graph message onto the canonical `MessageDTO`. This is the one
 * place Graph's payload shape is known (Story 5.1): the read is total — a missing or
 * mistyped field degrades to `""`/`[]`, never throws, and never drops a message.
 */
export function mapGraphMessage(entry: unknown, accountId: string): MessageDTO {
  const sender = readSender(entry);
  const isRead = readIsRead(entry);
  return {
    id: readString(entry, "id"),
    internetMessageId: readString(entry, "internetMessageId"),
    subject: readString(entry, "subject"),
    bodyPreview: readString(entry, "bodyPreview"),
    senderEmail: sender.email,
    senderName: sender.name,
    receivedDateTime: readString(entry, "receivedDateTime"),
    existingLabels: readCategories(entry),
    source: "m365",
    accountId,
    ...(isRead === undefined ? {} : { isRead }),
  };
}
