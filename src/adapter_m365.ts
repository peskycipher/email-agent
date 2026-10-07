import type { MailboxAction, MailboxAdapter, MailboxMessage, MailboxMessageState } from "./adapter.ts";
import { defaultFetch, parseJsonBody, type FetchFn } from "./http.ts";

export type M365MailboxAdapterConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  account: string;
  /**
   * `preview` (default) asks Graph for bodyPreview — plain text, light payload.
   * `full` asks Graph for body, which can be HTML and counts toward the message-size
   * budget for large mailboxes.
   */
  bodyMode?: "preview" | "full";
  /** Truncation cap (characters) applied to the body before classification. */
  bodyMaxChars?: number;
};

type M365Message = {
  id?: string;
  subject?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  categories?: unknown;
  bodyPreview?: string;
  body?: { content?: string };
  flag?: {
    flagStatus?: string;
  };
  from?: {
    emailAddress?: {
      address?: string;
    };
  };
};

export class M365MailboxAdapter implements MailboxAdapter {
  private readonly config: M365MailboxAdapterConfig;
  private readonly fetchFn: FetchFn;

  constructor(config: M365MailboxAdapterConfig, fetchFn?: FetchFn) {
    this.config = config;
    this.fetchFn = fetchFn ?? defaultFetch;
  }

  private async getAccessToken(): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: "https://graph.microsoft.com/.default"
    });

    const response = await this.fetchFn(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    const payload = await parseJsonBody(response, "M365 response");
    if (!response.ok) {
      throw new Error(`M365 auth failed (${response.status}): ${payload.error_description ?? payload.error ?? "unknown error"}`);
    }

    const token = payload.access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("M365 auth failed: missing access_token");
    }

    return token;
  }

  async listRecentInbox(limit: number): Promise<MailboxMessage[]> {
    const token = await this.getAccessToken();
    const requestUrl = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.config.account)}/mailFolders/inbox/messages`);
    requestUrl.searchParams.set("$top", String(limit));
    requestUrl.searchParams.set("$orderby", "receivedDateTime DESC");
    requestUrl.searchParams.set("$select", `id,from,subject,receivedDateTime,isRead,flag,categories,${this.bodyField()}`);

    const headers = {
      authorization: `Bearer ${token}`,
      prefer: 'IdType="ImmutableId"'
    };

    const messages: MailboxMessage[] = [];
    let nextUrl: string | undefined = requestUrl.toString();

    while (nextUrl && messages.length < limit) {
      const response = await this.fetchFn(nextUrl, { headers });
      const payload = await parseJsonBody(response, "M365 response");
      if (!response.ok) {
        throw new Error(`M365 list inbox failed (${response.status})`);
      }

      if (Array.isArray(payload.value)) {
        messages.push(
          ...payload.value
            .map((item: M365Message) => this.mapMessage(item))
            .filter((item: MailboxMessage | null): item is MailboxMessage => item !== null)
        );
      }

      if (messages.length >= limit) {
        break;
      }

      nextUrl = typeof payload["@odata.nextLink"] === "string" && payload["@odata.nextLink"].length > 0 ? payload["@odata.nextLink"] : undefined;
    }

    return messages.slice(0, limit);
  }

  async getMessage(messageId: string): Promise<MailboxMessageState> {
    const token = await this.getAccessToken();
    const encodedAccount = encodeURIComponent(this.config.account);
    const encodedMessageId = encodeURIComponent(messageId);
    const url = `https://graph.microsoft.com/v1.0/users/${encodedAccount}/messages/${encodedMessageId}?$select=subject,from,flag,isRead,${this.bodyField()}`;

    const response = await this.fetchFn(url, {
      headers: {
        authorization: `Bearer ${token}`,
        prefer: 'IdType="ImmutableId"'
      }
    });

    const payload = await parseJsonBody(response, "M365 response");
    if (!response.ok) {
      const error = payload.error?.message ?? payload.error_description ?? `M365 get message failed (${response.status})`;
      throw new Error(error);
    }

    const mapped = this.mapMessage(payload as M365Message);
    if (!mapped) {
      throw new Error("M365 get message failed: missing id");
    }

    return {
      id: mapped.id,
      from: mapped.from,
      subject: mapped.subject,
      flagged: mapped.flagged,
      unread: mapped.unread,
      body: mapped.body
    };
  }

  async apply(
    messageId: string,
    action: MailboxAction,
    category?: string,
    existingCategories?: string[]
  ): Promise<{ ok: boolean; error?: string }> {
    const token = await this.getAccessToken();
    const encodedAccount = encodeURIComponent(this.config.account);
    const encodedMessageId = encodeURIComponent(messageId);

    let url = "";
    let body: string | undefined;
    let method = "POST";

    if (action === "classify") {
      method = "PATCH";
      url = `https://graph.microsoft.com/v1.0/users/${encodedAccount}/messages/${encodedMessageId}`;

      let categoriesToMerge = existingCategories;
      if (!categoriesToMerge || categoriesToMerge.length === 0) {
        try {
          const categoriesUrl = `https://graph.microsoft.com/v1.0/users/${encodedAccount}/messages/${encodedMessageId}?$select=categories`;
          const categoriesResponse = await this.fetchFn(categoriesUrl, {
            headers: {
              authorization: `Bearer ${token}`,
              prefer: 'IdType="ImmutableId"'
            }
          });
          const categoriesPayload = await parseJsonBody(categoriesResponse, "M365 response");

          if (!categoriesResponse.ok) {
            const readError =
              categoriesPayload.error?.message ?? categoriesPayload.error_description ?? `M365 categories fetch failed (${categoriesResponse.status})`;
            return { ok: false, error: readError };
          }

          categoriesToMerge = Array.isArray(categoriesPayload.categories)
            ? categoriesPayload.categories.filter((value: unknown): value is string => typeof value === "string")
            : [];
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "M365 categories fetch failed" };
        }
      }

      const mergedCategories = [...new Set([...(categoriesToMerge ?? []), category ?? "FYI/Reference"])];
      body = JSON.stringify({ categories: mergedCategories });
    } else {
      url = `https://graph.microsoft.com/v1.0/users/${encodedAccount}/messages/${encodedMessageId}/move`;
      body = JSON.stringify({ destinationId: "archive" });
    }

    const response = await this.fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body
    });

    if (response.ok) {
      return { ok: true };
    }

    const payload = await parseJsonBody(response, "M365 response");
    const error = payload.error?.message ?? payload.error_description ?? `M365 apply failed (${response.status})`;
    return { ok: false, error };
  }

  private mapMessage(item: M365Message): MailboxMessage | null {
    if (typeof item.id !== "string" || item.id.length === 0) {
      return null;
    }

    return {
      id: item.id,
      from: item.from?.emailAddress?.address ?? "",
      subject: item.subject ?? "",
      date: item.receivedDateTime ?? "",
      unread: item.isRead === false,
      flagged: item.flag?.flagStatus === "flagged",
      categories: Array.isArray(item.categories) ? item.categories.filter((value): value is string => typeof value === "string") : [],
      body: this.truncateBody(extractBody(item, this.bodyMode()))
    };
  }

  private bodyField(): string {
    return this.bodyMode() === "full" ? "body" : "bodyPreview";
  }

  private bodyMode(): "preview" | "full" {
    return this.config.bodyMode ?? "preview";
  }

  private truncateBody(value: string): string {
    const max = this.config.bodyMaxChars ?? 4000;
    return value.length <= max ? value : value.slice(0, max);
  }
}

function extractBody(item: M365Message, mode: "preview" | "full"): string {
  if (mode === "full" && item.body && typeof item.body.content === "string") {
    return stripHtml(item.body.content);
  }
  return item.bodyPreview ?? "";
}

// ponytail: regex tag-stripping handles ordinary HTML mail; nested/malformed markup and
// exotic entities may leak through — swap in a real parser if bodies get adversarial.
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
