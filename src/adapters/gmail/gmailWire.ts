import type { FetchOpts } from "../../core/dto/FetchOpts.js";
import type { TokenSet } from "../../core/dto/TokenSet.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import type { FetchResponseLike } from "./GmailAuthAdapter.js";

/** Gmail's per-account labels: one GET to list them, one POST per missing label. */
export const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";

/** The whole-mailbox message list; `labelIds` scopes it to one label (Story 5.3). */
export const MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

/** The mailbox's current `historyId`, the only place a list-path cycle can read one (Story 5.4). */
export const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** The account's change history since a stored id (Story 5.4); `labelId` scopes it to one label. */
export const HISTORY_URL = "https://gmail.googleapis.com/gmail/v1/users/me/history";

/**
 * Gmail exposes no REST `messages.batchGet`: hydrating details is a generic multipart
 * batch POST, one inner metadata GET per id (Story 5.3 design note).
 */
export const BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";

/** The multipart boundary this adapter sends on a batch request; Gmail answers with its own, read from the response. */
export const BATCH_BOUNDARY = "email_classify_batch";

/** Gmail's system label for the inbox, used when the account configures no label. */
const DEFAULT_LABEL = "INBOX";

/** Gmail's `maxResults` ceiling and this adapter's fallback; the orchestrator owns the effective default. */
const MAX_BATCH_SIZE = 100;
const DEFAULT_BATCH_SIZE = 50;

/** A healthy Gmail call answers in seconds; a stalled socket must not hang the sync forever. */
const REQUEST_TIMEOUT_MS = 30_000;

export type GmailAdapterErrorCode =
  | "LIST_LABELS_FAILED"
  | "CREATE_LABEL_FAILED"
  | "LIST_MESSAGES_FAILED"
  | "BATCH_GET_MESSAGES_FAILED"
  | "GET_PROFILE_FAILED"
  | "LIST_HISTORY_FAILED"
  | "WRITE_LABELS_FAILED";

/**
 * Typed at the adapter boundary so the CLI renders one actionable line (AD-4) —
 * it names the account and the HTTP status, never Gmail's raw error payload.
 */
export class GmailAdapterError extends Error {
  readonly code: GmailAdapterErrorCode;
  readonly accountId: string;
  readonly status?: number;

  constructor(code: GmailAdapterErrorCode, accountId: string, message: string, status?: number) {
    super(message);
    this.name = "GmailAdapterError";
    this.code = code;
    this.accountId = accountId;
    if (status !== undefined) this.status = status;
  }
}

export type GmailFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export type GmailGetAccessToken = (accountName: string, options?: { forceRefresh?: boolean }) => Promise<TokenSet>;

export interface GmailAdapterServices {
  fetchFn: GmailFetchFn;
  getAccessToken: GmailGetAccessToken;
  logPort: LogPort;
  /** Written only by `gmailLabelSync`'s complete sync; read by `gmailLabelSync` and `gmailLabelWrite`. */
  labelIdsByAccount: Map<string, GmailLabelIds>;
  /** Written and read only by `gmailMessageFetch`, which owns the per-account dedupe across walks. */
  returnedIdsByAccount: Map<string, Set<string>>;
}

/** The per-account label-name → label-id map Epic 7 writes classifications back with. */
export type GmailLabelIds = ReadonlyMap<string, string>;

/** The `fetch` init shape, reused so the GET builder can honestly omit `body`. */
export type FetchInit = Parameters<GmailFetchFn>[1];

/**
 * `FetchResponseLike` models only JSON responses; a batch response is `multipart/mixed`, whose
 * boundary is a response header and whose body is text. A real `Response` supplies both, and
 * both are optional here so an injected JSON-only test double still satisfies the seam.
 */
export interface MultipartResponseLike extends FetchResponseLike {
  headers?: { get(name: string): string | null };
  text?: () => Promise<string>;
}

export function authorizationHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export function getRequest(headers: Record<string, string>): FetchInit {
  // A Gmail GET must not carry a body; that is why this adapter's `fetchFn` types one as optional.
  return { method: "GET", headers };
}

export function postRequest(headers: Record<string, string>, payload: Record<string, unknown>): FetchInit {
  return {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

/** `maxResults` is the batch size: defaulted when unset and clamped to Gmail's 1..100 range. */
export function clampBatchSize(batchSize: number | undefined): number {
  if (typeof batchSize !== "number" || !Number.isFinite(batchSize)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(Math.trunc(batchSize), 1), MAX_BATCH_SIZE);
}

/**
 * The message list URL: `labelIds` is `opts.folder` when set, else Gmail's `INBOX` system
 * label; `maxResults` is the clamped batch size; later pages carry a `pageToken`. A `since`
 * lower bound (Story 5.4's expiry fallback) becomes Gmail's only server-side time filter,
 * `q=after:<epoch-seconds>` — stepped back one second, because `after:` is exclusive and the
 * bound must never drop the message sitting exactly on it.
 */
export function messagesListUrl(opts: FetchOpts, pageToken: string | undefined): string {
  const label = opts.folder === undefined || opts.folder.length === 0 ? DEFAULT_LABEL : opts.folder;
  const query = [`labelIds=${encodeURIComponent(label)}`, `maxResults=${clampBatchSize(opts.batchSize)}`];
  if (opts.since !== undefined) {
    const afterSeconds = Math.floor(opts.since.getTime() / 1000) - 1;
    query.push(`q=${encodeURIComponent(`after:${afterSeconds}`)}`);
  }
  if (pageToken !== undefined) query.push(`pageToken=${encodeURIComponent(pageToken)}`);
  return `${MESSAGES_URL}?${query.join("&")}`;
}

/**
 * The history walk URL: `startHistoryId` is the stored id, `labelId` scopes the walk to the epic's
 * INBOX cron window (the same Gmail system label `DEFAULT_LABEL` names for the list path), and
 * later pages carry a `pageToken`. All three are percent-encoded.
 */
export function historyUrl(historyId: string, pageToken: string | undefined): string {
  const query = [
    `startHistoryId=${encodeURIComponent(historyId)}`,
    `labelId=${encodeURIComponent(DEFAULT_LABEL)}`,
  ];
  if (pageToken !== undefined) query.push(`pageToken=${encodeURIComponent(pageToken)}`);
  return `${HISTORY_URL}?${query.join("&")}`;
}

/** The field of an object entry, or `undefined` when the entry is not an object or lacks the key. */
export function readField(entry: unknown, key: string): unknown {
  if (typeof entry !== "object" || entry === null) return undefined;
  return (entry as Record<string, unknown>)[key];
}

export function readString(entry: unknown, key: string): string | undefined {
  const value = readField(entry, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function readJsonObject(response: FetchResponseLike): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bounded HTTP entry point every Gmail adapter concern shares. A network failure is a typed
 * error carrying the caller's code; the raw thrown value is never forwarded.
 */
export async function send(
  fetchFn: GmailFetchFn,
  url: string,
  init: FetchInit,
  accountId: string,
  code: GmailAdapterErrorCode,
): Promise<FetchResponseLike> {
  try {
    return await fetchFn(url, {
      ...init,
      // Never override a caller-supplied signal; bound the request only when there is none.
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // The thrown value can carry a stack and a raw cause; the typed error carries neither.
    throw new GmailAdapterError(code, accountId, `Gmail could not be reached for account "${accountId}".`);
  }
}

/**
 * The batch request body: one `application/http` part per message id, each a metadata GET
 * for exactly the fields the mapper reads. The closing delimiter terminates the body.
 */
export function batchRequestBody(ids: string[]): string {
  const parts = ids.map(
    (id, index) =>
      `--${BATCH_BOUNDARY}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <message-${index + 1}>\r\n` +
      `\r\n` +
      `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From,Subject HTTP/1.1\r\n`,
  );
  // The parts already end in CRLF; `join` adds the blank line multipart requires before each delimiter.
  parts.push(`--${BATCH_BOUNDARY}--`);
  return `${parts.join("\r\n")}\r\n`;
}

/** The boundary named by a `multipart/mixed` response's `Content-Type`, or `undefined` when it is not multipart. */
export function batchBoundary(contentType: string | null | undefined): string | undefined {
  if (typeof contentType !== "string") return undefined;
  const match = /boundary="?([^";]+)"?/i.exec(contentType);
  return match?.[1];
}

/** The batch-local index a response part's `Content-ID` names — Google echoes the request's `<message-N>`, documented as `<response-message-N>`, and the parser accepts both — or `undefined`. */
export function contentIdIndexOf(chunk: string): number | undefined {
  const match = /Content-ID:\s*<(?:response-)?message-(\d+)>/i.exec(chunk);
  if (match === null) return undefined;
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** Splits a `multipart/mixed` body into its part texts; the closing delimiter's chunk is dropped. */
export function splitBatchParts(body: string, boundary: string): string[] {
  const parts: string[] = [];
  for (const chunk of body.split(`--${boundary}`).slice(1)) {
    // Nothing follows the terminator, whose chunk starts with `--`.
    if (chunk.startsWith("--")) break;
    parts.push(chunk);
  }
  return parts;
}

/** One batch part's embedded HTTP status and JSON body; `undefined` means the part is not a parseable response. */
export function parseBatchPart(chunk: string): { status: number; body: unknown } | undefined {
  const start = chunk.indexOf("HTTP/");
  if (start < 0) return undefined;
  const embedded = chunk.slice(start);
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(embedded);
  if (status === null) return undefined;
  const separator = embedded.indexOf("\r\n\r\n");
  if (separator < 0) return undefined;
  try {
    return { status: Number(status[1]), body: JSON.parse(embedded.slice(separator + 4).trim()) };
  } catch {
    return undefined;
  }
}

export async function readResponseText(response: MultipartResponseLike): Promise<string | undefined> {
  if (typeof response.text !== "function") return undefined;
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/** One actionable line for a batch that cannot be parsed — never a silent skip (Story 5.3). */
export function unreadableBatchError(accountId: string): GmailAdapterError {
  return new GmailAdapterError(
    "BATCH_GET_MESSAGES_FAILED",
    accountId,
    `Gmail returned an unreadable message batch for account "${accountId}".`,
  );
}
