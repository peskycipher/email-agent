import type { LabelDef } from "../../core/dto/LabelDef.js";
import type { TokenSet } from "../../core/dto/TokenSet.js";
import type { FetchResponseLike } from "./GmailAuthAdapter.js";
import { nearestGmailColor, textColorFor } from "./labelColors.js";

/** Gmail's per-account labels: one GET to list them, one POST per missing label. */
const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";

/** A healthy Gmail call answers in seconds; a stalled socket must not hang the sync forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The per-account label-name → label-id map Epic 7 writes classifications back with. */
export type GmailLabelIds = ReadonlyMap<string, string>;

export type GmailAdapterErrorCode = "LIST_LABELS_FAILED" | "CREATE_LABEL_FAILED";

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
 * providers; the other two `MailPort` methods belong to Epics 5 and 7.
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
    init: FetchInit,
    accountId: string,
    code: GmailAdapterErrorCode,
  ): Promise<FetchResponseLike> {
    try {
      return await this.fetchFn(LABELS_URL, {
        ...init,
        // Never override a caller-supplied signal; bound the request only when there is none.
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The thrown value can carry a stack and a raw cause; the typed error carries neither.
      throw new GmailAdapterError(code, accountId, `Gmail could not be reached for account "${accountId}".`);
    }
  }
}
