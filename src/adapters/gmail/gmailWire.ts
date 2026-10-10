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
  | "WRITE_LABELS_FAILED"
  | "RATE_LIMIT_GAVE_UP";

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

/** Story 9.1's backoff seam: injectable so tests never really wait 2–60 seconds. */
export type ThrottleSleep = (ms: number) => Promise<void>;

/** A real wait, the seam's default. */
export function realThrottleSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Story 9.1's backoff ladder, in seconds: the wait per throttled retry when the response's
 * `Retry-After` is absent or unreadable. One rung per retry; the cap below can only bind
 * to a header wait longer than the ladder's last rung.
 */
const THROTTLE_LADDER_SECONDS = [2, 4, 8, 16, 32];
/** The ladder's ceiling: neither a `Retry-After` nor a rung ever waits longer than 60 seconds. */
const MAX_THROTTLE_WAIT_SECONDS = 60;
/** The retry budget per call: one backoff wait per retry, all five rungs, then give up. */
const MAX_THROTTLE_RETRIES = THROTTLE_LADDER_SECONDS.length;

/**
 * The response's `Retry-After` in seconds when present and usable; a non-numeric header (an
 * HTTP-date) or a non-positive one (`"0"`, empty, whitespace — `Number("") === 0`) falls back to
 * the ladder, never a zero-second retry. Gmail names throttling in seconds, so only a positive
 * integer wait parses.
 */
export function retryAfterSeconds(response: FetchResponseLike): number | undefined {
  const raw = response.headers?.get("retry-after");
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Gmail's body signal for throttling (Story 9.1, RATE_LIMIT_BODY): the provider can answer
 * `rateLimitExceeded` in the error body at a status other than 429. Detection is status or
 * body — the shape is `error.errors[].reason`.
 */
export function isRateLimitBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const error = (body as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return false;
  const errors = (error as Record<string, unknown>)["errors"];
  return (
    Array.isArray(errors) &&
    errors.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>)["reason"] === "rateLimitExceeded",
    )
  );
}

/** The throttle-aware caller's seam: the log the waits are written through, and the injectable wait. */
export interface ThrottleDeps {
  logPort: LogPort;
  sleep?: ThrottleSleep;
}

/**
 * The give-up: the retry budget is spent and the call is still throttled. A distinct code (AD-4)
 * so the caller sees an exhausted ladder, not an ordinary wire failure, and the batch's fate is
 * the account-failure isolation that already exists.
 */
export function throttleGiveUpError(
  provider: "Gmail" | "Microsoft Graph",
  accountId: string,
  status: number,
): GmailAdapterError {
  return new GmailAdapterError(
    "RATE_LIMIT_GAVE_UP",
    accountId,
    `${provider} kept throttling account "${accountId}" — the call was abandoned after ${MAX_THROTTLE_RETRIES} backoff retries (HTTP ${status}).`,
    status,
  );
}

/**
 * The per-part backoff rung (Story 9.1, RATE_LIMIT_BODY): Gmail can throttle one sub-request while
 * the batch envelope still answers 200, where `send`'s envelope-level check never sees it. The
 * caller re-issues the batch and asks for the wait here; `false` means the budget is spent.
 */
export async function throttlePartBackoff(
  deps: Pick<ThrottleDeps, "logPort" | "sleep">,
  accountId: string,
  retries: number,
): Promise<boolean> {
  if (retries >= MAX_THROTTLE_RETRIES) return false;
  const waitSeconds = THROTTLE_LADDER_SECONDS[retries];
  deps.logPort.warn(
    `Account "${accountId}" is throttled by Gmail — waiting ${waitSeconds}s before retry ${retries + 1} of ${MAX_THROTTLE_RETRIES}.`,
    { accountId, waitSeconds },
  );
  await (deps.sleep ?? realThrottleSleep)(waitSeconds * 1000);
  return true;
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
  /** Story 9.1's backoff seam, threaded from the CLI; the default is a real `setTimeout` sleep. */
  sleep?: ThrottleSleep;
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
 *
 * When a `throttle` seam is supplied (every mail-wire call supplies one — Story 9.1), a response
 * answering 429 — or with `rateLimitExceeded` in its error body — is retried on the same call:
 * the wait is the response's `Retry-After` seconds when present and parseable, else the next
 * ladder rung (2s, 4s, 8s, 16s, 32s), always capped at 60s. Every wait is logged naming the
 * account; after the retry budget is spent the give-up error throws and the batch's fate is the
 * caller's account-failure isolation. Any other failure returns the response untouched, so the
 * non-429 error paths — and the flat-retry mechanisms outside the adapters — stay exactly as
 * they were.
 */
export async function send(
  fetchFn: GmailFetchFn,
  url: string,
  init: FetchInit,
  accountId: string,
  code: GmailAdapterErrorCode,
  throttle?: ThrottleDeps,
): Promise<FetchResponseLike> {
  let retries = 0;
  for (;;) {
    let response: FetchResponseLike;
    try {
      response = await fetchFn(url, {
        ...init,
        // Never override a caller-supplied signal; bound the request only when there is none.
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The thrown value can carry a stack and a raw cause; the typed error carries neither.
      throw new GmailAdapterError(code, accountId, `Gmail could not be reached for account "${accountId}".`);
    }
    if (response.ok || throttle === undefined) return response;
    // Reading the error body here is safe: every caller renders a non-ok response from its
    // status alone and never re-reads the body, so nothing is consumed twice.
    const body = await readJsonObject(response);
    if (response.status !== 429 && !isRateLimitBody(body)) return response;
    if (retries >= MAX_THROTTLE_RETRIES) throw throttleGiveUpError("Gmail", accountId, response.status);
    const waitSeconds = Math.min(
      retryAfterSeconds(response) ?? THROTTLE_LADDER_SECONDS[retries],
      MAX_THROTTLE_WAIT_SECONDS,
    );
    // No silent sleeping: one line per wait, naming the account and the capped wait (AD-4).
    throttle.logPort.warn(
      `Account "${accountId}" is throttled by Gmail — waiting ${waitSeconds}s before retry ${retries + 1} of ${MAX_THROTTLE_RETRIES}.`,
      { accountId, waitSeconds },
    );
    await (throttle.sleep ?? realThrottleSleep)(waitSeconds * 1000);
    retries += 1;
  }
}

/**
 * The throttle-aware caller's entry point, one shape for every Gmail mail-wire call site
 * (Story 9.1): the caller hands its `services` and the wire specifics stay inside the adapter.
 */
export async function sendThrottled(
  services: Pick<GmailAdapterServices, "fetchFn" | "logPort"> & ThrottleDeps,
  url: string,
  init: FetchInit,
  accountId: string,
  code: GmailAdapterErrorCode,
): Promise<FetchResponseLike> {
  return send(services.fetchFn, url, init, accountId, code, services);
}

/**
 * The batch request body: one `application/http` part per message id, each a metadata GET
 * for exactly the fields the mapper reads. `Message-ID` is the RFC header the mapper takes the
 * message's identity from — Gmail's `Message` resource has no top-level `internetMessageId`.
 * The closing delimiter terminates the body.
 */
export function batchRequestBody(ids: string[]): string {
  const parts = ids.map(
    (id, index) =>
      `--${BATCH_BOUNDARY}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <message-${index + 1}>\r\n` +
      `\r\n` +
      `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From,Subject,Message-ID HTTP/1.1\r\n`,
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
