import type { FetchResponseLike } from "../../../src/adapters/gmail/GmailAuthAdapter.js";
import type { GmailAdapterDeps } from "../../../src/adapters/gmail/GmailAdapter.js";
import type { LabelDef } from "../../../src/core/dto/LabelDef.js";
import type { LogPort } from "../../../src/core/ports/LogPort.js";
import type { TokenSet } from "../../../src/core/dto/TokenSet.js";

export const ACCESS_TOKEN: TokenSet = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 9_999_999_999,
  scopes: ["gmail.readonly", "gmail.labels", "gmail.modify"],
};

export const LABELS: LabelDef[] = [
  { name: "Action Needed", description: "Needs a response.", m365Color: "preset0", gmailColor: "#E67C73" },
  { name: "Family/Friends", description: "Personal mail.", m365Color: "preset6", gmailColor: "#F9A8D4" },
  { name: "Real-estate", description: "Property mail.", m365Color: "preset10", gmailColor: "#A3A3A3" },
];

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  /** The verbatim request body — the batch POST is `multipart/mixed`, so it is never JSON-parsed. */
  rawBody: string | undefined;
  /** Every Gmail request must be bounded by an `AbortSignal`. */
  signal: boolean;
}

export function jsonResponse(body: unknown, ok = true, status = 200): FetchResponseLike {
  return { ok, status, json: async () => body };
}

export function scriptedFetch(responses: FetchResponseLike[]): {
  fetchFn: GmailAdapterDeps["fetchFn"];
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: GmailAdapterDeps["fetchFn"] = async (url, init) => {
    const rawBody = typeof init.body === "string" ? init.body : undefined;
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      body:
        rawBody === undefined || init.headers["content-type"] !== "application/json"
          ? undefined
          : (JSON.parse(rawBody) as Record<string, unknown>),
      rawBody,
      signal: init.signal !== undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetchFn, requests };
}

export function labelList(entries: Array<{ id: string; name: string }>): FetchResponseLike {
  return jsonResponse({ labels: entries });
}

export function created(id = "created"): FetchResponseLike {
  return jsonResponse({ id, name: "created" }, true, 200);
}

export function tokenSource(tokens: TokenSet = ACCESS_TOKEN): {
  getAccessToken: GmailAdapterDeps["getAccessToken"];
  calls: string[];
  /** The options each call carried, so a forced refresh is observable rather than inferred. */
  options: Array<{ forceRefresh?: boolean } | undefined>;
} {
  const calls: string[] = [];
  const options: Array<{ forceRefresh?: boolean } | undefined> = [];
  let issued = 0;
  return {
    calls,
    options,
    getAccessToken: async (accountName, opts) => {
      calls.push(accountName);
      options.push(opts);
      // A forced refresh must yield a new token: re-returning the rejected one would hide
      // a caller that never asked for a refresh at all.
      if (opts?.forceRefresh) return { ...tokens, accessToken: `access-${++issued + 1}` };
      return tokens;
    },
  };
}

export function colorOf(request: RecordedRequest | undefined): Record<string, string> {
  return request?.body?.["color"] as Record<string, string>;
}

export function makeLogPort(): LogPort & { warnings: Array<{ message: string; context?: Record<string, unknown> }> } {
  const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, context) => {
      warnings.push({ message, context: context as Record<string, unknown> | undefined });
    },
    error: () => undefined,
    warnings,
  };
}

export const BATCH_BOUNDARY = "email_classify_batch";
export const BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";

/** A `multipart/mixed` response, which is what the adapter's `fetchFn` seam must model for the batch POST. */
export interface MultipartTestResponse extends FetchResponseLike {
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * One `format=metadata` detail as the batch parser sees it. The message identity is the RFC
 * `Message-ID` header — Gmail's `Message` resource has no top-level `internetMessageId`, and the
 * batch request asks for `Message-ID` for exactly this reason (Story 8.2).
 */
export function gmailDetail(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    threadId: id,
    labelIds: ["INBOX"],
    snippet: `Preview ${id}`,
    internalDate: "1759999999000",
    payload: {
      headers: [
        { name: "From", value: `Sender ${id} <${id}@example.com>` },
        { name: "Subject", value: `Subject ${id}` },
        { name: "Message-ID", value: `<${id}@example.com>` },
      ],
    },
    ...overrides,
  };
}

/** A `multipart/mixed` batch response with one embedded HTTP response per part. */
export function batchResponse(
  parts: Array<{ status?: number; body?: unknown }>,
  boundary = "batch_abc",
): MultipartTestResponse {
  const chunks = parts.map(
    (part, index) =>
      `--${boundary}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <response-message-${index + 1}>\r\n` +
      `\r\n` +
      `HTTP/1.1 ${part.status ?? 200} OK\r\n` +
      `Content-Type: application/json\r\n` +
      `\r\n` +
      `${part.body === undefined ? "" : JSON.stringify(part.body)}\r\n\r\n`,
  );
  chunks.push(`--${boundary}--\r\n`);
  const text = chunks.join("");
  return {
    ok: true,
    status: 200,
    headers: { get: () => `multipart/mixed; boundary="${boundary}"` },
    json: async () => ({}),
    text: async () => text,
  };
}
