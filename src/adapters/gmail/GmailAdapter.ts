import type { FetchOpts } from "../../core/dto/FetchOpts.js";
import type { LabelDef } from "../../core/dto/LabelDef.js";
import type { MessageDTO } from "../../core/dto/MessageDTO.js";
import type { TokenSet } from "../../core/dto/TokenSet.js";
import type { FetchResponseLike } from "./GmailAuthAdapter.js";
import { nearestGmailColor, textColorFor } from "./labelColors.js";
import { mapGmailMessage } from "./messageMapper.js";

/** Gmail's per-account labels: one GET to list them, one POST per missing label. */
const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";

/** The whole-mailbox message list; `labelIds` scopes it to one label (Story 5.3). */
const MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

/**
 * Gmail exposes no REST `messages.batchGet`: hydrating details is a generic multipart
 * batch POST, one inner metadata GET per id (Story 5.3 design note).
 */
const BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";

/** The multipart boundary this adapter sends on a batch request; Gmail answers with its own, read from the response. */
const BATCH_BOUNDARY = "email_classify_batch";

/** Gmail's system label for the inbox, used when the account configures no label. */
const DEFAULT_LABEL = "INBOX";

/** Gmail's `maxResults` ceiling and this adapter's fallback; the orchestrator owns the effective default. */
const MAX_BATCH_SIZE = 100;
const DEFAULT_BATCH_SIZE = 50;

/** A healthy Gmail call answers in seconds; a stalled socket must not hang the sync forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * `FetchResponseLike` models only JSON responses; a batch response is `multipart/mixed`, whose
 * boundary is a response header and whose body is text. A real `Response` supplies both, and
 * both are optional here so an injected JSON-only test double still satisfies the seam.
 */
interface MultipartResponseLike extends FetchResponseLike {
  headers?: { get(name: string): string | null };
  text?: () => Promise<string>;
}

/** The per-account label-name → label-id map Epic 7 writes classifications back with. */
export type GmailLabelIds = ReadonlyMap<string, string>;

export type GmailAdapterErrorCode =
  | "LIST_LABELS_FAILED"
  | "CREATE_LABEL_FAILED"
  | "LIST_MESSAGES_FAILED"
  | "BATCH_GET_MESSAGES_FAILED";

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

export interface GmailAdapterDeps {
  /**
   * Story 3.1's `FetchLike` shape, except `body` is optional: a Gmail label-list `GET`
   * must not carry a body, while `GmailAuthAdapter`'s shape requires one for its form
   * posts. The wider shape accepts that seam, so one injected `fetchFn` serves both.
   */
  fetchFn: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => Promise<FetchResponseLike>;
  /** Story 3.1's silent-refresh seam (`GmailAuthAdapter.getAccessToken`); Gmail work never talks to Google's token endpoint directly. */
  getAccessToken(accountName: string, options?: { forceRefresh?: boolean }): Promise<TokenSet>;
}

/** The `fetch` init shape, reused so the GET builder can honestly omit `body`. */
type FetchInit = Parameters<GmailAdapterDeps["fetchFn"]>[1];

function authorizationHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function getRequest(headers: Record<string, string>): FetchInit {
  // A Gmail GET must not carry a body; that is why this adapter's `fetchFn` types one as optional.
  return { method: "GET", headers };
}

function postRequest(headers: Record<string, string>, payload: Record<string, unknown>): FetchInit {
  return {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

/** `maxResults`/batch size: defaulted when unset and clamped to Gmail's 1..100 range. */
function clampBatchSize(batchSize: number | undefined): number {
  if (typeof batchSize !== "number" || !Number.isFinite(batchSize)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(Math.trunc(batchSize), 1), MAX_BATCH_SIZE);
}

/**
 * The message list URL: `labelIds` is `opts.folder` when set, else Gmail's `INBOX` system
 * label; `maxResults` is the clamped batch size; later pages carry a `pageToken`.
 */
function messagesListUrl(opts: FetchOpts, pageToken: string | undefined): string {
  const label = opts.folder === undefined || opts.folder.length === 0 ? DEFAULT_LABEL : opts.folder;
  const query = [`labelIds=${encodeURIComponent(label)}`, `maxResults=${clampBatchSize(opts.batchSize)}`];
  if (pageToken !== undefined) query.push(`pageToken=${encodeURIComponent(pageToken)}`);
  return `${MESSAGES_URL}?${query.join("&")}`;
}

/**
 * The batch request body: one `application/http` part per message id, each a metadata GET
 * for exactly the fields the mapper reads. The closing delimiter terminates the body.
 */
function batchRequestBody(ids: string[]): string {
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
function batchBoundary(contentType: string | null | undefined): string | undefined {
  if (typeof contentType !== "string") return undefined;
  const match = /boundary="?([^";]+)"?/i.exec(contentType);
  return match?.[1];
}

/** The batch-local index a response part's `Content-ID` names — Google echoes the request's `<message-N>`, documented as `<response-message-N>`, and the parser accepts both — or `undefined`. */
function contentIdIndexOf(chunk: string): number | undefined {
  const match = /Content-ID:\s*<(?:response-)?message-(\d+)>/i.exec(chunk);
  if (match === null) return undefined;
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** Splits a `multipart/mixed` body into its part texts; the closing delimiter's chunk is dropped. */
function splitBatchParts(body: string, boundary: string): string[] {
  const parts: string[] = [];
  for (const chunk of body.split(`--${boundary}`).slice(1)) {
    // Nothing follows the terminator, whose chunk starts with `--`.
    if (chunk.startsWith("--")) break;
    parts.push(chunk);
  }
  return parts;
}

/** One batch part's embedded HTTP status and JSON body; `undefined` means the part is not a parseable response. */
function parseBatchPart(chunk: string): { status: number; body: unknown } | undefined {
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

async function readResponseText(response: MultipartResponseLike): Promise<string | undefined> {
  if (typeof response.text !== "function") return undefined;
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/** One actionable line for a batch that cannot be parsed — never a silent skip (Story 5.3). */
function unreadableBatchError(accountId: string): GmailAdapterError {
  return new GmailAdapterError(
    "BATCH_GET_MESSAGES_FAILED",
    accountId,
    `Gmail returned an unreadable message batch for account "${accountId}".`,
  );
}

function readString(entry: unknown, key: string): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readJsonObject(response: FetchResponseLike): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Gmail label sync over plain `fetch` (Story 3.1's decision, and `tests/adapters/**` stay
 * stdlib-only). `ensureCategories` keeps `MailPort`'s name — and its `Promise<void>`
 * signature — so the same `CategorySyncTarget` seam and `syncCategories` loop serve both
 * providers. `fetchMessages` (Story 5.3) conforms to two of `MailPort`'s three methods;
 * `writeLabels` belongs to Epic 7.
 */
export class GmailAdapter {
  private readonly fetchFn: GmailAdapterDeps["fetchFn"];
  private readonly getAccessToken: GmailAdapterDeps["getAccessToken"];
  /**
   * The AC's per-account cache, keyed by account id, read back through `labelIdsFor`. It is a
   * snapshot of the last *complete* sync: a mid-loop create failure leaves the previous snapshot
   * untouched, and the next successful run replaces it.
   */
  private readonly labelIdsByAccount = new Map<string, GmailLabelIds>();
  /** Gmail labels overlap by design, so a message this instance already returned for the account is not returned twice. */
  private readonly returnedIdsByAccount = new Map<string, Set<string>>();

  constructor(deps: GmailAdapterDeps) {
    this.fetchFn = deps.fetchFn;
    this.getAccessToken = deps.getAccessToken;
  }

  /**
   * Idempotent: reads the account's labels, then creates only the labels whose `name` is
   * absent — an exact, case-sensitive match. A label that already exists keeps its name
   * and colour; nothing is ever renamed, re-coloured or deleted. Every taxonomy name ends
   * up in the account's name → id map, ids drawn from the list for the labels that existed
   * and from each create response for the rest.
   */
  async ensureCategories(accountId: string, labels: LabelDef[]): Promise<void> {
    const token = (await this.getAccessToken(accountId)).accessToken;
    const known = await this.listLabels(accountId, token);
    const labelIds = new Map<string, string>();
    for (const label of labels) {
      const existingId = known.get(label.name);
      if (existingId !== undefined) {
        labelIds.set(label.name, existingId);
        continue;
      }
      const createdId = await this.createLabel(accountId, token, label);
      labelIds.set(label.name, createdId);
      // A caller can pass the same name twice; remembering the create stops the second
      // one from being POSTed into a duplicate (or a 409).
      known.set(label.name, createdId);
    }
    this.labelIdsByAccount.set(accountId, labelIds);
  }

  /** The account's cached name → label-id map, or `undefined` before its first sync. Read-only: the cache is the adapter's. */
  labelIdsFor(accountId: string): GmailLabelIds | undefined {
    return this.labelIdsByAccount.get(accountId);
  }

  private async listLabels(accountId: string, token: string): Promise<Map<string, string>> {
    const response = await this.send(
      LABELS_URL,
      getRequest(authorizationHeader(token)),
      accountId,
      "LIST_LABELS_FAILED",
    );
    if (!response.ok) {
      throw new GmailAdapterError(
        "LIST_LABELS_FAILED",
        accountId,
        `Gmail refused to list the labels for account "${accountId}" (HTTP ${response.status}).`,
        response.status,
      );
    }
    const body = await readJsonObject(response);
    const page = body?.labels;
    if (!Array.isArray(page)) {
      // Without the list there is no way to tell which labels exist; creating them anyway
      // would duplicate every one.
      throw new GmailAdapterError(
        "LIST_LABELS_FAILED",
        accountId,
        `Gmail returned no label list for account "${accountId}".`,
      );
    }
    const byName = new Map<string, string>();
    // Unlike M365's master categories, Gmail's label list has no page token — one response
    // carries them all.
    for (const entry of page) {
      const name = readString(entry, "name");
      const id = readString(entry, "id");
      if (name !== undefined && id !== undefined && !byName.has(name)) byName.set(name, id);
    }
    return byName;
  }

  private async createLabel(accountId: string, token: string, label: LabelDef): Promise<string> {
    // Google accepts only its documented palette, so the taxonomy's hex is the intent and
    // the nearest allowed pair is what actually goes on the wire.
    const backgroundColor = nearestGmailColor(label.gmailColor);
    const response = await this.send(
      LABELS_URL,
      postRequest(authorizationHeader(token), {
        name: label.name,
        color: { backgroundColor, textColor: textColorFor(backgroundColor) },
      }),
      accountId,
      "CREATE_LABEL_FAILED",
    );
    if (!response.ok) {
      throw new GmailAdapterError(
        "CREATE_LABEL_FAILED",
        accountId,
        `Gmail refused to create label "${label.name}" for account "${accountId}" (HTTP ${response.status}).`,
        response.status,
      );
    }
    const id = readString(await readJsonObject(response), "id");
    if (id === undefined) {
      // Without the id the label could never be written back to; the create is not usable.
      throw new GmailAdapterError(
        "CREATE_LABEL_FAILED",
        accountId,
        `Gmail created label "${label.name}" for account "${accountId}" but returned no label id.`,
      );
    }
    return id;
  }

  private async send(
    url: string,
    init: FetchInit,
    accountId: string,
    code: GmailAdapterErrorCode,
  ): Promise<FetchResponseLike> {
    try {
      return await this.fetchFn(url, {
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
   * Walks the account's message list page by page, following `nextPageToken` until it is
   * absent, and hydrates each page's ids through the multipart batch endpoint (Story 5.3).
   * A non-2xx or malformed page, an unreadable batch, or a network failure throws a typed
   * error and returns no partial array — a truncated backfill must never look finished.
   */
  async fetchMessages(opts: FetchOpts): Promise<MessageDTO[]> {
    const token = (await this.getAccessToken(opts.accountId)).accessToken;
    const batchSize = clampBatchSize(opts.batchSize);
    const messages: MessageDTO[] = [];
    // A message can appear on two pages while mail arrives during a long backfill; each id is hydrated once.
    const seenIds = new Set<string>();
    // And on two labels — the account-scoped set from earlier walks in this run keeps the count honest.
    let accountSeen = this.returnedIdsByAccount.get(opts.accountId);
    if (accountSeen === undefined) {
      accountSeen = new Set<string>();
      this.returnedIdsByAccount.set(opts.accountId, accountSeen);
    }
    // A repeated page token would page forever; each token is followed once.
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const response = await this.send(
        messagesListUrl(opts, pageToken),
        getRequest(authorizationHeader(token)),
        opts.accountId,
        "LIST_MESSAGES_FAILED",
      );
      if (!response.ok) {
        throw new GmailAdapterError(
          "LIST_MESSAGES_FAILED",
          opts.accountId,
          `Gmail refused to list messages for account "${opts.accountId}" (HTTP ${response.status}).`,
          response.status,
        );
      }
      const body = await readJsonObject(response);
      const page = body?.messages;
      if (!Array.isArray(page)) {
        // A page without its `messages` array is an error, never "no messages" — the
        // same rule `listLabels` applies.
        throw new GmailAdapterError(
          "LIST_MESSAGES_FAILED",
          opts.accountId,
          `Gmail returned no message list for account "${opts.accountId}".`,
        );
      }
      const ids: string[] = [];
      for (const entry of page) {
        const id = readString(entry, "id");
        if (id === undefined) {
          // A list entry without an id cannot be hydrated; treating it as "no messages" would drop it.
          throw new GmailAdapterError(
            "LIST_MESSAGES_FAILED",
            opts.accountId,
            `Gmail listed a message without an id for account "${opts.accountId}".`,
          );
        }
        if (seenIds.has(id) || accountSeen.has(id)) continue;
        seenIds.add(id);
        ids.push(id);
      }
      for (let start = 0; start < ids.length; start += batchSize) {
        // Each batch carries at most the clamped batch size; a failure in any batch fails the account.
        messages.push(...(await this.fetchBatch(opts.accountId, token, ids.slice(start, start + batchSize))));
      }
      // The page's ids count as returned only once its batches succeeded.
      for (const id of ids) accountSeen.add(id);
      const rawToken = body?.nextPageToken;
      pageToken = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : undefined;
      if (rawToken !== undefined && pageToken === undefined) {
        // A present-but-unusable token must not quietly end the walk: a truncated backfill
        // may never look complete (the frozen partial-walk rule, kept from Story 5.3).
        throw new GmailAdapterError(
          "LIST_MESSAGES_FAILED",
          opts.accountId,
          `Gmail returned a malformed page token for account "${opts.accountId}".`,
        );
      }
      if (pageToken !== undefined) {
        if (seenTokens.has(pageToken)) {
          throw new GmailAdapterError(
            "LIST_MESSAGES_FAILED",
            opts.accountId,
            `Gmail repeated a page token for account "${opts.accountId}".`,
          );
        }
        seenTokens.add(pageToken);
      }
    } while (pageToken !== undefined);
    return messages;
  }

  /** Hydrates one batch of ids with a single `POST /batch/gmail/v1`; each part maps back to a DTO in order. */
  private async fetchBatch(accountId: string, token: string, ids: string[]): Promise<MessageDTO[]> {
    const response: MultipartResponseLike = await this.send(
      BATCH_URL,
      {
        method: "POST",
        headers: {
          ...authorizationHeader(token),
          "content-type": `multipart/mixed; boundary=${BATCH_BOUNDARY}`,
        },
        body: batchRequestBody(ids),
      },
      accountId,
      "BATCH_GET_MESSAGES_FAILED",
    );
    if (!response.ok) {
      throw new GmailAdapterError(
        "BATCH_GET_MESSAGES_FAILED",
        accountId,
        `Gmail refused to fetch message details for account "${accountId}" (HTTP ${response.status}).`,
        response.status,
      );
    }
    const body = await readResponseText(response);
    const boundary = batchBoundary(response.headers?.get("content-type"));
    const parts = body === undefined || boundary === undefined ? undefined : splitBatchParts(body, boundary);
    if (parts === undefined || parts.length !== ids.length) {
      // Without one parseable part per id, some message's details would be silently dropped.
      throw unreadableBatchError(accountId);
    }
    const messages: Array<MessageDTO | undefined> = Array.from({ length: ids.length }, () => undefined);
    parts.forEach((part, position) => {
      const parsed = parseBatchPart(part);
      if (parsed === undefined) throw unreadableBatchError(accountId);
      if (parsed.status < 200 || parsed.status >= 300) {
        throw new GmailAdapterError(
          "BATCH_GET_MESSAGES_FAILED",
          accountId,
          `Gmail refused to fetch message details for account "${accountId}" (HTTP ${parsed.status}).`,
          parsed.status,
        );
      }
      // The request names each part; prefer that Content-ID so a reordered response cannot swap ids.
      const index = contentIdIndexOf(part) ?? position;
      if (index >= ids.length || messages[index] !== undefined) throw unreadableBatchError(accountId);
      const message = mapGmailMessage(parsed.body, accountId);
      // A part that is not the message the request named — an empty id, or another
      // message's payload — is misattribution, never a silent swap or drop.
      if (message.id !== ids[index]) throw unreadableBatchError(accountId);
      messages[index] = message;
    });
    if (messages.some((message) => message === undefined)) throw unreadableBatchError(accountId);
    return messages as MessageDTO[];
  }
}
