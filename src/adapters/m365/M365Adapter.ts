import type { FetchOpts } from "../../core/dto/FetchOpts.js";
import type { LabelDef } from "../../core/dto/LabelDef.js";
import type { MessageDTO } from "../../core/dto/MessageDTO.js";
import type { TokenSet } from "../../core/dto/TokenSet.js";
import type { LogPort } from "../../core/ports/LogPort.js";
import { mapGraphMessage, readCategories } from "./messageMapper.js";
import type { FetchLike, FetchResponseLike } from "./M365AuthAdapter.js";

/** Graph's per-mailbox master categories: one GET to list them, one POST per missing category. */
const MASTER_CATEGORIES_URL = "https://graph.microsoft.com/v1.0/me/outlook/masterCategories";

/** The whole-mailbox message list; a folder-scoped fetch prefixes `mailFolders/{folder}` to it. */
const MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/messages";
const MAIL_FOLDERS_URL = "https://graph.microsoft.com/v1.0/me/mailFolders";

/** The fields the mapper reads; `from` populates the DTO's required sender pair. */
const MESSAGE_SELECT = "id,internetMessageId,subject,bodyPreview,receivedDateTime,categories,isRead,from";

/** Graph's `$top` ceiling and this adapter's fallback; the orchestrator owns the effective default. */
const MAX_BATCH_SIZE = 100;
const DEFAULT_BATCH_SIZE = 50;

/** A healthy Graph call answers in seconds; a stalled socket must not hang the sync forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Story 9.1's backoff ladder, in seconds: the wait per throttled retry when the response's
 * `Retry-After` is absent or unreadable. Graph names throttling by status only; the wait
 * specifics — parsing, rung, give-up — are this adapter's own wire layer, not shared code.
 */
const THROTTLE_LADDER_SECONDS = [2, 4, 8, 16, 32];
/** The ceiling: neither a `Retry-After` nor a rung ever waits longer than 60 seconds. */
const MAX_THROTTLE_WAIT_SECONDS = 60;
/** The retry budget per call: one backoff wait per retry, all five rungs, then give up. */
const MAX_THROTTLE_RETRIES = THROTTLE_LADDER_SECONDS.length;

/**
 * The response's `Retry-After` in seconds when present and usable; a non-numeric header (an
 * HTTP-date) or a non-positive one (`"0"`, empty, whitespace — `Number("") === 0`) falls back to
 * the ladder, never a zero-second retry. Graph names throttling in seconds, so only a positive
 * integer wait parses.
 */
function retryAfterSeconds(response: FetchResponseLike): number | undefined {
  const raw = response.headers?.get("retry-after");
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** The `FetchLike` init shape, reused so the GET builder can honestly omit `body`. */
type FetchInit = Parameters<FetchLike>[1];

export type M365AdapterErrorCode =
  | "LIST_CATEGORIES_FAILED"
  | "CREATE_CATEGORY_FAILED"
  | "LIST_MESSAGES_FAILED"
  | "WRITE_LABELS_FAILED"
  | "RATE_LIMIT_GAVE_UP";

/**
 * Typed at the adapter boundary so the CLI renders one actionable line (AD-4) —
 * it names the account and the HTTP status, never Graph's raw error payload.
 */
export class M365AdapterError extends Error {
  readonly code: M365AdapterErrorCode;
  readonly accountId: string;
  readonly status?: number;

  constructor(code: M365AdapterErrorCode, accountId: string, message: string, status?: number) {
    super(message);
    this.name = "M365AdapterError";
    this.code = code;
    this.accountId = accountId;
    if (status !== undefined) this.status = status;
  }
}

export interface M365AdapterDeps {
  fetchFn: FetchLike;
  /** Story 2.1's silent-refresh seam (`M365AuthAdapter.getAccessToken`); Graph work never talks to Entra directly. */
  getAccessToken(accountName: string, options?: { forceRefresh?: boolean }): Promise<TokenSet>;
  /** Epic 7's 404 warning for moved messages; the caller supplies the orchestration log seam. */
  logPort: LogPort;
  /** Story 9.1's backoff seam, threaded from the CLI; defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

function authorizationHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function getRequest(headers: Record<string, string>): FetchInit {
  // A Graph GET must not carry a body; `FetchLike` types `body` as optional for exactly this case.
  return { method: "GET", headers };
}

function postRequest(headers: Record<string, string>, payload: Record<string, string>): FetchInit {
  return {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function patchRequest(headers: Record<string, string>, payload: Record<string, unknown>): FetchInit {
  return {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function readDisplayName(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const displayName = (entry as { displayName?: unknown }).displayName;
  return typeof displayName === "string" ? displayName : undefined;
}

function readNextLink(body: Record<string, unknown> | undefined): string | undefined {
  const next = body?.["@odata.nextLink"];
  return typeof next === "string" && next.length > 0 ? next : undefined;
}

/** `$top` is the batch size: defaulted when unset and clamped to Graph's 1..100 range. */
function clampBatchSize(batchSize: number | undefined): number {
  if (typeof batchSize !== "number" || !Number.isFinite(batchSize)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(Math.trunc(batchSize), 1), MAX_BATCH_SIZE);
}

/** Whole mailbox, or one folder when `opts.folder` is set. `$top` and `$select` are built here for the first page; every later page reuses Graph's `@odata.nextLink` verbatim, which carries the original query. */
function messagesUrl(opts: FetchOpts): string {
  // A configured folder is typically a display name ("Sent Items"), so the path segment is encoded.
  const base =
    opts.folder === undefined || opts.folder.length === 0
      ? MESSAGES_URL
      : `${MAIL_FOLDERS_URL}/${encodeURIComponent(opts.folder)}/messages`;
  const query = [`$top=${clampBatchSize(opts.batchSize)}`, `$select=${MESSAGE_SELECT}`];
  if (opts.since !== undefined) {
    // The stored instant is an ISO string; encode it rather than interpolating the raw `:`s into the query.
    query.push(`$filter=receivedDateTime ge ${encodeURIComponent(opts.since.toISOString())}`);
    query.push("$orderby=receivedDateTime asc");
  }
  return `${base}?${query.join("&")}`;
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
 * M365 Graph work over plain `fetch` (no Graph SDK — Story 2.1's decision,
 * and `tests/adapters/**` stay stdlib-only). `ensureCategories`, `fetchMessages`
 * and `writeLabels` are implemented.
 */
export class M365Adapter {
  private readonly fetchFn: FetchLike;
  private readonly getAccessToken: M365AdapterDeps["getAccessToken"];
  private readonly logPort: LogPort;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: M365AdapterDeps) {
    this.fetchFn = deps.fetchFn;
    this.getAccessToken = deps.getAccessToken;
    this.logPort = deps.logPort;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Idempotent: reads every page of the account's master categories, then creates only
   * the labels whose `name` is absent — an exact, case-sensitive match on `displayName`,
   * each created with the taxonomy's `presetN` colour. A category that already exists is
   * left exactly as it is; nothing is ever renamed, re-coloured or deleted.
   *
   * If any Graph call returns 401, the token is force-refreshed once via Story 2.1's seam
   * and the whole operation is retried; this absorbs the common race where the provider
   * revokes the token between acquisition and use.
   */
  async ensureCategories(accountId: string, labels: LabelDef[]): Promise<void> {
    try {
      await this.runEnsureCategories(accountId, labels);
    } catch (error) {
      if (error instanceof M365AdapterError && error.status === 401) {
        const refreshed = (await this.getAccessToken(accountId, { forceRefresh: true })).accessToken;
        await this.runEnsureCategories(accountId, labels, refreshed);
        return;
      }
      throw error;
    }
  }

  private async runEnsureCategories(accountId: string, labels: LabelDef[], token?: string): Promise<void> {
    const effectiveToken = token ?? (await this.getAccessToken(accountId)).accessToken;
    const existing = await this.listCategoryNames(accountId, effectiveToken);
    for (const label of labels) {
      if (existing.has(label.name)) continue;
      await this.createCategory(accountId, effectiveToken, label);
      // A caller can pass the same name twice; remembering the create stops the second
      // one from being POSTed into a duplicate (or a 409).
      existing.add(label.name);
    }
  }

  /**
   * Walks the account's message list page by page in Graph's order, following
   * `@odata.nextLink` until it is absent (Story 5.1). A non-2xx page, a missing
   * `value` array, or a network failure throws a typed error and returns no partial
   * array — a truncated backfill must never look like a finished one.
   */
  async fetchMessages(opts: FetchOpts): Promise<MessageDTO[]> {
    const token = (await this.getAccessToken(opts.accountId)).accessToken;
    const messages: MessageDTO[] = [];
    let url: string | undefined = messagesUrl(opts);
    let isFirstPage = true;
    while (url !== undefined) {
      const response = await this.send(
        url,
        getRequest(authorizationHeader(token)),
        opts.accountId,
        "LIST_MESSAGES_FAILED",
      );
      if (!response.ok) {
        // Story 2.1 exposes forceRefresh for exactly this case: a 401 on the first page
        // may mean the token was revoked at the provider between acquisition and use.
        // Refresh once and replay. A 401 on a later page is treated as a normal failure
        // (nextLink URLs are signed; replaying them after a token change is unsafe).
        if (response.status === 401 && isFirstPage) {
          const refreshed = (await this.getAccessToken(opts.accountId, { forceRefresh: true })).accessToken;
          const retry = await this.send(
            url,
            getRequest(authorizationHeader(refreshed)),
            opts.accountId,
            "LIST_MESSAGES_FAILED",
          );
          if (retry.ok) {
            const body = await readJsonObject(retry);
            const page = body?.value;
            if (!Array.isArray(page)) {
              throw new M365AdapterError(
                "LIST_MESSAGES_FAILED",
                opts.accountId,
                `Microsoft Graph returned no message list for account "${opts.accountId}".`,
                retry.status,
              );
            }
            for (const entry of page) messages.push(mapGraphMessage(entry, opts.accountId));
            url = readNextLink(body);
            isFirstPage = false;
            continue;
          }
        }
        throw new M365AdapterError(
          "LIST_MESSAGES_FAILED",
          opts.accountId,
          `Microsoft Graph refused to list messages for account "${opts.accountId}" (HTTP ${response.status}).`,
          response.status,
        );
      }
      const body = await readJsonObject(response);
      const page = body?.value;
      if (!Array.isArray(page)) {
        // A page without its `value` array is an error, never "no messages" — the
        // same rule `listCategoryNames` applies.
        throw new M365AdapterError(
          "LIST_MESSAGES_FAILED",
          opts.accountId,
          `Microsoft Graph returned no message list for account "${opts.accountId}".`,
          response.status,
        );
      }
      for (const entry of page) messages.push(mapGraphMessage(entry, opts.accountId));
      url = readNextLink(body);
      isFirstPage = false;
    }
    return messages;
  }

  /**
   * Add-only label write for a single message (Story 7.1). Reads the message's current
   * `categories` from Graph, then PATCHes with the union of existing + predicted labels.
   * Nothing is removed; duplicates collapse; a per-message 404 is logged and absorbed
   * so one moved message cannot fail a batch.
   */
  async writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    try {
      await this.runWriteLabels(accountId, messageId, labels);
    } catch (error) {
      if (error instanceof M365AdapterError && error.status === 401) {
        const refreshed = (await this.getAccessToken(accountId, { forceRefresh: true })).accessToken;
        await this.runWriteLabels(accountId, messageId, labels, refreshed);
        return;
      }
      throw error;
    }
  }

  private async runWriteLabels(
    accountId: string,
    messageId: string,
    labels: string[],
    token?: string,
  ): Promise<void> {
    const effectiveToken = token ?? (await this.getAccessToken(accountId)).accessToken;
    const url = M365Adapter.messageUrl(messageId);

    const readResponse = await this.send(
      `${url}?$select=categories`,
      getRequest(authorizationHeader(effectiveToken)),
      accountId,
      "WRITE_LABELS_FAILED",
    );
    if (readResponse.status === 404) {
      this.warnMessageNotFound(accountId, messageId);
      return;
    }
    if (!readResponse.ok) {
      throw new M365AdapterError(
        "WRITE_LABELS_FAILED",
        accountId,
        `Microsoft Graph refused to read message categories for account "${accountId}" (HTTP ${readResponse.status}).`,
        readResponse.status,
      );
    }

    const body = await readJsonObject(readResponse);
    if (typeof body !== "object" || body === null || !Array.isArray(body.categories)) {
      throw new M365AdapterError(
        "WRITE_LABELS_FAILED",
        accountId,
        `Microsoft Graph returned message "${messageId}" without a categories list for account "${accountId}".`,
      );
    }

    const existing = readCategories(body);
    const existingSet = new Set(existing);
    const union: string[] = [...existing];
    for (const label of labels) {
      if (!existingSet.has(label)) {
        union.push(label);
        existingSet.add(label);
      }
    }

    if (union.length === existing.length) return;

    const patchResponse = await this.send(
      url,
      patchRequest(authorizationHeader(effectiveToken), { categories: union }),
      accountId,
      "WRITE_LABELS_FAILED",
    );
    if (patchResponse.status === 404) {
      this.warnMessageNotFound(accountId, messageId);
      return;
    }
    if (!patchResponse.ok) {
      throw new M365AdapterError(
        "WRITE_LABELS_FAILED",
        accountId,
        `Microsoft Graph refused to write labels to message "${messageId}" for account "${accountId}" (HTTP ${patchResponse.status}).`,
        patchResponse.status,
      );
    }
  }

  private static messageUrl(messageId: string): string {
    return `${MESSAGES_URL}/${encodeURIComponent(messageId)}`;
  }

  /** The one warning shared by the read and PATCH 404 paths: a moved message is skipped, not fatal. */
  private warnMessageNotFound(accountId: string, messageId: string): void {
    this.logPort.warn(
      `Message "${messageId}" was not found for account "${accountId}" — skipping label write.`,
      { accountId, messageId },
    );
  }

  private async listCategoryNames(accountId: string, token: string): Promise<Set<string>> {
    const names = new Set<string>();
    let url: string | undefined = MASTER_CATEGORIES_URL;
    while (url !== undefined) {
      const response = await this.send(
        url,
        getRequest(authorizationHeader(token)),
        accountId,
        "LIST_CATEGORIES_FAILED",
      );
      if (!response.ok) {
        throw new M365AdapterError(
          "LIST_CATEGORIES_FAILED",
          accountId,
          `Microsoft Graph refused to list the master categories for account "${accountId}" (HTTP ${response.status}).`,
          response.status,
        );
      }
      const body = await readJsonObject(response);
      const page = body?.value;
      if (!Array.isArray(page)) {
        // Without the list there is no way to tell which categories exist; creating
        // them anyway would duplicate every one.
        throw new M365AdapterError(
          "LIST_CATEGORIES_FAILED",
          accountId,
          `Microsoft Graph returned no master-category list for account "${accountId}".`,
        );
      }
      for (const entry of page) {
        const displayName = readDisplayName(entry);
        if (displayName !== undefined) names.add(displayName);
      }
      url = readNextLink(body);
    }
    return names;
  }

  private async createCategory(accountId: string, token: string, label: LabelDef): Promise<void> {
    const response = await this.send(
      MASTER_CATEGORIES_URL,
      postRequest(authorizationHeader(token), { displayName: label.name, color: label.m365Color }),
      accountId,
      "CREATE_CATEGORY_FAILED",
    );
    if (!response.ok) {
      throw new M365AdapterError(
        "CREATE_CATEGORY_FAILED",
        accountId,
        `Microsoft Graph refused to create category "${label.name}" for account "${accountId}" (HTTP ${response.status}).`,
        response.status,
      );
    }
  }

  private async sendGraphRequest(
    url: string,
    init: FetchInit,
    accountId: string,
    code: M365AdapterErrorCode,
  ): Promise<FetchResponseLike> {
    return this.send(url, init, accountId, code);
  }

  /**
   * The bounded HTTP entry point every Graph call shares, made throttle-aware by Story 9.1:
   * a response answering 429 is retried on the same call — the wait is the response's
   * `Retry-After` seconds when present and parseable, else the next ladder rung (2s, 4s, 8s,
   * 16s, 32s), always capped at 60s. Every wait is logged naming the account; after the
   * retry budget is spent the give-up error throws and the batch's fate is the caller's
   * account-failure isolation. Graph names throttling by status alone (the body is never
   * read on an error path), so any other failure returns the response untouched and the
   * flat-retry mechanisms outside the adapters stay exactly as they were.
   */
  private async send(
    url: string,
    init: FetchInit,
    accountId: string,
    code: M365AdapterErrorCode,
  ): Promise<FetchResponseLike> {
    let retries = 0;
    for (;;) {
      let response: FetchResponseLike;
      try {
        response = await this.fetchFn(url, {
          ...init,
          // Never override a caller-supplied signal; bound the request only when there is none.
          signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // The thrown value can carry a stack and a raw cause; the typed error carries neither.
        throw new M365AdapterError(
          code,
          accountId,
          `Microsoft Graph could not be reached for account "${accountId}".`,
        );
      }
      if (response.status !== 429) return response;
      if (retries >= MAX_THROTTLE_RETRIES) {
        throw new M365AdapterError(
          "RATE_LIMIT_GAVE_UP",
          accountId,
          `Microsoft Graph kept throttling account "${accountId}" — the call was abandoned after ${MAX_THROTTLE_RETRIES} backoff retries (HTTP ${response.status}).`,
          response.status,
        );
      }
      const waitSeconds = Math.min(
        retryAfterSeconds(response) ?? THROTTLE_LADDER_SECONDS[retries],
        MAX_THROTTLE_WAIT_SECONDS,
      );
      // No silent sleeping: one line per wait, naming the account and the capped wait (AD-4).
      this.logPort.warn(
        `Account "${accountId}" is throttled by Microsoft Graph — waiting ${waitSeconds}s before retry ${retries + 1} of ${MAX_THROTTLE_RETRIES}.`,
        { accountId, waitSeconds },
      );
      await this.sleep(waitSeconds * 1000);
      retries += 1;
    }
  }
}
