import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { ACCOUNT_NAME_PATTERN } from "../../core/dto/accountName.js";
import type { TokenSet } from "../../core/dto/TokenSet.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";
import type { AccountSettingsReader } from "./accountSettings.js";

/** The scopes Story 3.1 freezes: exactly these three, for both the request and the stored `TokenSet`. */
export const GMAIL_SCOPES = ["gmail.readonly", "gmail.labels", "gmail.modify"] as const;

/**
 * Google's Gmail scope *values* are full URIs (`https://www.googleapis.com/auth/gmail.labels`, …).
 * The short names above are the PRD's shorthand and stay the value persisted in `TokenSet`; sending
 * them verbatim to the consent endpoint fails with `invalid_scope`.
 */
const GMAIL_SCOPE_URIS = GMAIL_SCOPES.map((scope) => `https://www.googleapis.com/auth/${scope}`);

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const MAX_WAIT_SECONDS = 300;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface FetchLike {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ): Promise<FetchResponseLike>;
}

/**
 * The single loopback seam: listens on the redirect URI, opens the consent URL and
 * resolves with the authorization code. Tests inject a canned code instead, so no
 * socket or browser is needed.
 */
export type AuthorizeFn = (authUrl: string, redirectUri: string) => Promise<string>;

export interface LoopbackAuthorizeOptions {
  /** Opens the consent URL; defaults to the platform opener and never fails when no browser exists. */
  open?: (url: string) => void;
  /** Consent cap; defaults to the 5-minute `MAX_WAIT_SECONDS`. */
  timeoutMs?: number;
}

/**
 * Thrown by the loopback `authorize` and mapped to a `GmailAuthError` by the adapter,
 * which is the layer that knows the account name.
 */
export type GmailConsentErrorCode = "CONSENT_DENIED" | "CONSENT_TIMEOUT" | "CONSENT_UNAVAILABLE";

export class GmailConsentError extends Error {
  readonly code: GmailConsentErrorCode;
  readonly consentUrl?: string;

  constructor(code: GmailConsentErrorCode, message: string, consentUrl?: string) {
    super(message);
    this.name = "GmailConsentError";
    this.code = code;
    if (consentUrl) this.consentUrl = consentUrl;
  }
}

export type GmailAuthErrorCode =
  | "INVALID_ACCOUNT_NAME"
  | "MISSING_CLIENT_SECRET"
  | "CONSENT_DENIED"
  | "CONSENT_TIMEOUT"
  | "CONSENT_UNAVAILABLE"
  | "TOKEN_REQUEST_FAILED"
  | "AUTH_REQUIRED";

/** Typed at the adapter boundary so the CLI renders one actionable line (AD-4). */
export class GmailAuthError extends Error {
  readonly code: GmailAuthErrorCode;
  readonly accountName: string;

  constructor(code: GmailAuthErrorCode, accountName: string, message: string) {
    super(message);
    this.name = "GmailAuthError";
    this.code = code;
    this.accountName = accountName;
  }
}

export interface GmailAuthAdapterDeps {
  fetchFn: FetchLike;
  tokenStore: TokenPort;
  accountSettings: AccountSettingsReader;
  /** Defaults to the loopback browser flow; injectable so tests supply a canned code. */
  authorize?: AuthorizeFn;
  now?: () => number;
  /** Where the `clientSecretEnvVar` is read from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function isTokenNotFound(error: unknown): boolean {
  // AD-10: the gmail adapter must not import the token adapter, so the store's
  // `TOKEN_NOT_FOUND` code is matched structurally.
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "TOKEN_NOT_FOUND"
  );
}

function toSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
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
 * Binds `127.0.0.1:0` briefly to learn a free port for the loopback redirect, so both
 * the consent URL and the code exchange carry the identical `redirect_uri`. The port
 * is never fixed or configurable; the seam rebinds it for the callback.
 */
async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Platform opener, best-effort only — the URL is printed regardless. */
function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    // No browser installed and no `xdg-open`: never fail the flow over it.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore — the consent URL was already printed.
  }
}

/**
 * Default `authorize`: a `node:http` loopback server bound to the redirect URI's
 * ephemeral port collects the code Google redirects back with. Prints the consent URL
 * so the user can complete the flow by hand when no browser is available.
 */
export function authorizeWithLoopback(
  authUrl: string,
  redirectUri: string,
  options: LoopbackAuthorizeOptions = {},
): Promise<string> {
  const port = Number(new URL(redirectUri).port);
  const timeoutMs = options.timeoutMs ?? MAX_WAIT_SECONDS * 1000;
  const open = options.open ?? ((url: string) => {
    process.stderr.write(`Open this URL to sign in with Google:\n${url}\n`);
    openBrowser(url);
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", redirectUri);
      const error = requestUrl.searchParams.get("error");
      if (error) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("Sign-in was declined. You can close this tab and return to the terminal.\n");
        finish(new GmailConsentError("CONSENT_DENIED", `Google declined the consent (${error}).`, authUrl));
        return;
      }
      const code = requestUrl.searchParams.get("code");
      if (!code) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Waiting for the Google redirect.\n");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Authentication complete. You can close this tab and return to the terminal.\n");
      finish(undefined, code);
    });

    function finish(error?: unknown, code?: string): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(code as string);
    }

    server.once("error", () =>
      finish(
        new GmailConsentError(
          "CONSENT_UNAVAILABLE",
          `The local sign-in callback could not listen on ${redirectUri}.`,
          authUrl,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => {
      try {
        open(authUrl);
      } catch {
        // `open` runs inside the listen callback, so a synchronous throw here would never
        // reach `requestConsentCode`'s catch — it would leave this promise unsettled and
        // escape as an uncaught exception.
        finish(
          new GmailConsentError(
            "CONSENT_UNAVAILABLE",
            `The consent page could not be opened — open ${authUrl} to sign in manually.`,
            authUrl,
          ),
        );
        return;
      }
      timer = setTimeout(
        () =>
          finish(
            new GmailConsentError(
              "CONSENT_TIMEOUT",
              `Google consent was not completed within ${MAX_WAIT_SECONDS} seconds.`,
              authUrl,
            ),
          ),
        timeoutMs,
      );
    });
  });
}

/**
 * Google's OAuth 2.0 installed-app consent flow over plain HTTP (no SDK): builds the
 * consent URL, collects the code through the injected `authorize` seam, exchanges it
 * for tokens and persists the `TokenSet` through the injected `TokenPort`. Cached
 * tokens are reused, and an expired token is refreshed silently from the refresh token.
 */
export class GmailAuthAdapter {
  private readonly fetchFn: FetchLike;
  private readonly tokenStore: TokenPort;
  private readonly accountSettings: AccountSettingsReader;
  private readonly authorize: AuthorizeFn;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;

  constructor(deps: GmailAuthAdapterDeps) {
    this.fetchFn = deps.fetchFn;
    this.tokenStore = deps.tokenStore;
    this.accountSettings = deps.accountSettings;
    this.authorize = deps.authorize ?? authorizeWithLoopback;
    this.now = deps.now ?? (() => Date.now());
    this.env = deps.env ?? process.env;
  }

  /**
   * Signs an account in. Reuses an unexpired cached token, silently refreshes an
   * expired one, and only falls back to the browser consent flow when neither is possible.
   */
  async authenticate(accountName: string): Promise<TokenSet> {
    this.assertAccountName(accountName);
    const cached = await this.readCached(accountName);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached;
    if (cached?.refreshToken) {
      try {
        return await this.refresh(accountName, cached.refreshToken);
      } catch (error) {
        // Only a revoked/invalid refresh token justifies a re-prompt; a network
        // failure must surface, not masquerade as a revoked token.
        if (!(error instanceof GmailAuthError && error.code === "AUTH_REQUIRED")) throw error;
      }
    }
    return this.runConsentFlow(accountName);
  }

  /**
   * Gmail-specific, non-port method (Story 2.1 decision 2): returns the cached token
   * while unexpired, otherwise refreshes it silently and re-persists.
   */
  async getAccessToken(accountName: string, options: { forceRefresh?: boolean } = {}): Promise<TokenSet> {
    this.assertAccountName(accountName);
    const cached = await this.readCached(accountName);
    if (!options.forceRefresh && cached !== undefined && cached.expiresAt > this.now()) return cached;
    if (cached?.refreshToken) return this.refresh(accountName, cached.refreshToken);
    throw new GmailAuthError(
      "AUTH_REQUIRED",
      accountName,
      `No valid token for account "${accountName}" — run \`--auth gmail --account ${accountName}\` to sign in.`,
    );
  }

  private assertAccountName(accountName: string): void {
    if (!ACCOUNT_NAME_PATTERN.test(accountName)) {
      throw new GmailAuthError(
        "INVALID_ACCOUNT_NAME",
        accountName,
        `Account name "${accountName}" is invalid — it must match ${ACCOUNT_NAME_PATTERN.source}.`,
      );
    }
  }

  private async readCached(accountName: string): Promise<TokenSet | undefined> {
    try {
      return await this.tokenStore.get("gmail", accountName);
    } catch (error) {
      if (isTokenNotFound(error)) return undefined;
      throw error;
    }
  }

  private async runConsentFlow(accountName: string): Promise<TokenSet> {
    const settings = await this.accountSettings.read(accountName);
    // Resolve the secret before opening a browser, so a missing secret never starts consent.
    const clientSecret = this.readClientSecret(accountName, settings.clientSecretEnvVar);
    const { code, redirectUri } = await this.requestConsentCode(accountName, settings.clientId);
    const response = await this.postForm(
      TOKEN_ENDPOINT,
      {
        code,
        client_id: settings.clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      },
      "TOKEN_REQUEST_FAILED",
      accountName,
    );
    const payload = await readJsonObject(response);
    if (!response.ok || typeof payload?.access_token !== "string") {
      const errorCode = typeof payload?.error === "string" ? payload.error : "unknown_error";
      throw new GmailAuthError(
        "TOKEN_REQUEST_FAILED",
        accountName,
        `Google rejected the code exchange for account "${accountName}" (${errorCode}) — try again.`,
      );
    }
    const tokens = this.tokenSetFromResponse(payload);
    await this.tokenStore.set("gmail", accountName, tokens);
    return tokens;
  }

  /**
   * Reserves an ephemeral loopback port, builds the consent URL around it and waits
   * for the code. Every failure maps to a typed error naming the account — including a
   * listener/bind failure, which arrives here as a plain `Error`.
   */
  private async requestConsentCode(
    accountName: string,
    clientId: string,
  ): Promise<{ code: string; redirectUri: string }> {
    try {
      const redirectUri = `http://127.0.0.1:${await reserveLoopbackPort()}`;
      const code = await this.authorize(this.buildConsentUrl(clientId, redirectUri), redirectUri);
      return { code, redirectUri };
    } catch (error) {
      throw this.consentFailure(accountName, error);
    }
  }

  private consentFailure(accountName: string, error: unknown): GmailAuthError {
    if (error instanceof GmailConsentError) {
      if (error.code === "CONSENT_TIMEOUT") {
        const retry = error.consentUrl ? ` — open ${error.consentUrl} to retry.` : ".";
        return new GmailAuthError(
          "CONSENT_TIMEOUT",
          accountName,
          `Consent for account "${accountName}" timed out after ${MAX_WAIT_SECONDS} seconds${retry}`,
        );
      }
      if (error.code === "CONSENT_DENIED") {
        return new GmailAuthError(
          "CONSENT_DENIED",
          accountName,
          `Google declined consent for account "${accountName}" — re-run \`--auth gmail --account ${accountName}\` if that was unintended.`,
        );
      }
      if (error.code === "CONSENT_UNAVAILABLE") {
        // Keep the specific cause (which port failed to listen, say) instead of
        // collapsing it into the generic line below.
        return new GmailAuthError(
          "CONSENT_UNAVAILABLE",
          accountName,
          `${error.message} Retry \`--auth gmail --account ${accountName}\`.`,
        );
      }
    }
    return new GmailAuthError(
      "CONSENT_UNAVAILABLE",
      accountName,
      `Sign-in for account "${accountName}" could not start — retry \`--auth gmail --account ${accountName}\`.`,
    );
  }

  private readClientSecret(accountName: string, envVar: string): string {
    const secret = this.env[envVar];
    if (!secret) {
      // Never echo the secret itself — only the env var the user must set.
      throw new GmailAuthError(
        "MISSING_CLIENT_SECRET",
        accountName,
        `The OAuth client secret for account "${accountName}" is not set — export ${envVar} before running \`--auth gmail --account ${accountName}\`.`,
      );
    }
    return secret;
  }

  private buildConsentUrl(clientId: string, redirectUri: string): string {
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", GMAIL_SCOPE_URIS.join(" "));
    // A refresh token is only issued for an offline prompt that is re-consented.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  private async refresh(accountName: string, refreshToken: string): Promise<TokenSet> {
    const settings = await this.accountSettings.read(accountName);
    const clientSecret = this.readClientSecret(accountName, settings.clientSecretEnvVar);
    const response = await this.postForm(
      TOKEN_ENDPOINT,
      {
        client_id: settings.clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      },
      "TOKEN_REQUEST_FAILED",
      accountName,
    );
    const payload = await readJsonObject(response);
    if (!response.ok || typeof payload?.access_token !== "string") {
      const errorCode = typeof payload?.error === "string" ? payload.error : "unknown_error";
      if (errorCode === "invalid_grant" || errorCode === "invalid_refresh_token") {
        throw new GmailAuthError(
          "AUTH_REQUIRED",
          accountName,
          `Sign-in for account "${accountName}" can no longer be refreshed (${errorCode}) — run \`--auth gmail --account ${accountName}\` to sign in again.`,
        );
      }
      throw new GmailAuthError(
        "TOKEN_REQUEST_FAILED",
        accountName,
        `Refreshing the token for account "${accountName}" failed (${errorCode}) — try again.`,
      );
    }
    const tokens = this.tokenSetFromResponse(payload, refreshToken);
    await this.tokenStore.set("gmail", accountName, tokens);
    return tokens;
  }

  private tokenSetFromResponse(payload: Record<string, unknown>, previousRefreshToken?: string): TokenSet {
    const refreshToken =
      typeof payload.refresh_token === "string" ? payload.refresh_token : previousRefreshToken;
    const expiresIn = toSeconds(payload.expires_in, 3600);
    return {
      accessToken: String(payload.access_token),
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: this.now() + expiresIn * 1000,
      scopes: [...GMAIL_SCOPES],
    };
  }

  private async postForm(
    url: string,
    params: Record<string, string>,
    errorCode: GmailAuthErrorCode,
    accountName: string,
  ): Promise<FetchResponseLike> {
    try {
      return await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
        // Bound each request so a hung connection cannot outlive the 5-minute cap.
        signal: AbortSignal.timeout(MAX_WAIT_SECONDS * 1000),
      });
    } catch {
      throw new GmailAuthError(
        errorCode,
        accountName,
        `Google could not be reached for account "${accountName}".`,
      );
    }
  }
}
