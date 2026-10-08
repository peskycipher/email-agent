import type { LabelDef } from "../../core/dto/LabelDef.js";
import type { TokenSet } from "../../core/dto/TokenSet.js";
import type { FetchLike, FetchResponseLike } from "./M365AuthAdapter.js";

/** Graph's per-mailbox master categories: one GET to list them, one POST per missing category. */
const MASTER_CATEGORIES_URL = "https://graph.microsoft.com/v1.0/me/outlook/masterCategories";

/** A healthy Graph call answers in seconds; a stalled socket must not hang the sync forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The `FetchLike` init shape, reused so the GET builder can honestly omit `body`. */
type FetchInit = Parameters<FetchLike>[1];

export type M365AdapterErrorCode = "LIST_CATEGORIES_FAILED" | "CREATE_CATEGORY_FAILED";

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

function readDisplayName(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const displayName = (entry as { displayName?: unknown }).displayName;
  return typeof displayName === "string" ? displayName : undefined;
}

function readNextLink(body: Record<string, unknown> | undefined): string | undefined {
  const next = body?.["@odata.nextLink"];
  return typeof next === "string" && next.length > 0 ? next : undefined;
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
 * M365 master-category sync over plain `fetch` (no Graph SDK — Story 2.1's decision,
 * and `tests/adapters/**` stay stdlib-only). Only `ensureCategories` is implemented;
 * the other two `MailPort` methods belong to Epics 5 and 7.
 */
export class M365Adapter {
  private readonly fetchFn: FetchLike;
  private readonly getAccessToken: M365AdapterDeps["getAccessToken"];

  constructor(deps: M365AdapterDeps) {
    this.fetchFn = deps.fetchFn;
    this.getAccessToken = deps.getAccessToken;
  }

  /**
   * Idempotent: reads every page of the account's master categories, then creates only
   * the labels whose `name` is absent — an exact, case-sensitive match on `displayName`,
   * each created with the taxonomy's `presetN` colour. A category that already exists is
   * left exactly as it is; nothing is ever renamed, re-coloured or deleted.
   */
  async ensureCategories(accountId: string, labels: LabelDef[]): Promise<void> {
    const token = (await this.getAccessToken(accountId)).accessToken;
    const existing = await this.listCategoryNames(accountId, token);
    for (const label of labels) {
      if (existing.has(label.name)) continue;
      await this.createCategory(accountId, token, label);
      // A caller can pass the same name twice; remembering the create stops the second
      // one from being POSTed into a duplicate (or a 409).
      existing.add(label.name);
    }
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

  private async send(
    url: string,
    init: FetchInit,
    accountId: string,
    code: M365AdapterErrorCode,
  ): Promise<FetchResponseLike> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      // The thrown value can carry a stack and a raw cause; the typed error carries neither.
      throw new M365AdapterError(
        code,
        accountId,
        `Microsoft Graph could not be reached for account "${accountId}".`,
      );
    }
  }
}
