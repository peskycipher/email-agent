import { ACCOUNT_NAME_PATTERN } from "../../core/dto/accountName.js";
import type { TokenSet } from "../../core/dto/TokenSet.js";
import type { TokenPort } from "../../core/ports/TokenPort.js";
import type { AccountSettingsReader } from "./accountSettings.js";

/** The scopes Story 2.1 freezes: exactly these two, for both the request and the stored `TokenSet`. */
export const M365_SCOPES = ["Mail.ReadWrite", "MailboxSettings.ReadWrite"] as const;

const DEVICE_CODE_AUTHORITY = "https://login.microsoftonline.com";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MAX_WAIT_SECONDS = 300;
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_MS = 5_000;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  /**
   * Story 9.1: the throttling backoff reads `Retry-After` here. A real `Response` always
   * supplies it; a JSON-only test double may omit it, which is exactly "no header".
   */
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface FetchLike {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<FetchResponseLike>;
}

export interface DeviceCodePrompt {
  accountName: string;
  userCode: string;
  verificationUri: string;
}

export interface M365AuthAdapterDeps {
  fetchFn: FetchLike;
  tokenStore: TokenPort;
  accountSettings: AccountSettingsReader;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Surfaces the user code + verification URL so the CLI can print them before polling starts. */
  onDeviceCode?: (prompt: DeviceCodePrompt) => void;
}

export type M365AuthErrorCode =
  | "INVALID_ACCOUNT_NAME"
  | "DEVICE_CODE_REQUEST_FAILED"
  | "DEVICE_CODE_DENIED"
  | "DEVICE_CODE_TIMEOUT"
  | "TOKEN_REQUEST_FAILED"
  | "AUTH_REQUIRED";

/** Typed at the adapter boundary so the CLI renders one actionable line (AD-4). */
export class M365AuthError extends Error {
  readonly code: M365AuthErrorCode;
  readonly accountName: string;
  readonly verificationUri?: string;

  constructor(code: M365AuthErrorCode, accountName: string, message: string, verificationUri?: string) {
    super(message);
    this.name = "M365AuthError";
    this.code = code;
    this.accountName = accountName;
    if (verificationUri) this.verificationUri = verificationUri;
  }
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

type PollOutcome =
  | { kind: "success"; payload: Record<string, unknown> }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "expired" }
  | { kind: "denied"; errorCode: string }
  | { kind: "failed"; errorCode: string };

function isTokenNotFound(error: unknown): boolean {
  // AD-10: the m365 adapter must not import the token adapter, so the store's
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
 * Microsoft device code flow over an injected `fetch`-like fn (no Graph SDK — the
 * flow is two plain form posts against the public client). Reads/writes tokens
 * through the injected `TokenPort` and resolves credentials through the injected
 * per-account settings reader.
 */
export class M365AuthAdapter {
  private readonly fetchFn: FetchLike;
  private readonly tokenStore: TokenPort;
  private readonly accountSettings: AccountSettingsReader;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onDeviceCode: ((prompt: DeviceCodePrompt) => void) | undefined;

  constructor(deps: M365AuthAdapterDeps) {
    this.fetchFn = deps.fetchFn;
    this.tokenStore = deps.tokenStore;
    this.accountSettings = deps.accountSettings;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onDeviceCode = deps.onDeviceCode;
  }

  /**
   * Signs an account in. Reuses an unexpired cached token, silently refreshes an
   * expired one, and only falls back to device code when neither is possible.
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
        if (!(error instanceof M365AuthError && error.code === "AUTH_REQUIRED")) throw error;
      }
    }
    return this.runDeviceCodeFlow(accountName);
  }

  /**
   * M365-specific, non-port method (Story 2.1 decision 2): returns the cached
   * token while unexpired, otherwise refreshes it silently and re-persists.
   */
  async getAccessToken(accountName: string, options: { forceRefresh?: boolean } = {}): Promise<TokenSet> {
    this.assertAccountName(accountName);
    const cached = await this.readCached(accountName);
    if (!options.forceRefresh && cached !== undefined && cached.expiresAt > this.now()) return cached;
    if (cached?.refreshToken) return this.refresh(accountName, cached.refreshToken);
    throw new M365AuthError(
      "AUTH_REQUIRED",
      accountName,
      `No valid token for account "${accountName}" — run \`--auth m365 --account ${accountName}\` to sign in.`,
    );
  }

  private assertAccountName(accountName: string): void {
    if (!ACCOUNT_NAME_PATTERN.test(accountName)) {
      throw new M365AuthError(
        "INVALID_ACCOUNT_NAME",
        accountName,
        `Account name "${accountName}" is invalid — it must match ${ACCOUNT_NAME_PATTERN.source}.`,
      );
    }
  }

  private async readCached(accountName: string): Promise<TokenSet | undefined> {
    try {
      return await this.tokenStore.get("m365", accountName);
    } catch (error) {
      if (isTokenNotFound(error)) return undefined;
      throw error;
    }
  }

  private authorityFor(tenantId: string): string {
    return `${DEVICE_CODE_AUTHORITY}/${tenantId}/oauth2/v2.0`;
  }

  private async runDeviceCodeFlow(accountName: string): Promise<TokenSet> {
    const settings = await this.accountSettings.read(accountName);
    const authority = this.authorityFor(settings.tenantId);
    const code = await this.requestDeviceCode(accountName, authority, settings.clientId);
    this.onDeviceCode?.({
      accountName,
      userCode: code.user_code,
      verificationUri: code.verification_uri,
    });

    const start = this.now();
    const deadlineMs = Math.min(code.expires_in, MAX_WAIT_SECONDS) * 1000;
    let intervalMs = Math.max(code.interval, 1) * 1000;

    for (;;) {
      if (this.now() - start >= deadlineMs) throw this.timeoutError(accountName, code.verification_uri);
      await this.sleep(intervalMs);
      if (this.now() - start >= deadlineMs) throw this.timeoutError(accountName, code.verification_uri);

      const outcome = await this.pollToken(accountName, authority, settings.clientId, code.device_code);
      switch (outcome.kind) {
        case "pending":
          continue;
        case "slow_down":
          intervalMs += SLOW_DOWN_INCREMENT_MS;
          continue;
        case "expired":
          throw this.timeoutError(accountName, code.verification_uri);
        case "denied":
          throw new M365AuthError(
            "DEVICE_CODE_DENIED",
            accountName,
            `Sign-in for account "${accountName}" was declined.`,
          );
        case "failed":
          throw new M365AuthError(
            "TOKEN_REQUEST_FAILED",
            accountName,
            `Microsoft rejected the sign-in for account "${accountName}" (${outcome.errorCode}).`,
          );
        case "success": {
          const tokens = this.tokenSetFromResponse(outcome.payload);
          await this.tokenStore.set("m365", accountName, tokens);
          return tokens;
        }
      }
    }
  }

  private timeoutError(accountName: string, verificationUri: string): M365AuthError {
    return new M365AuthError(
      "DEVICE_CODE_TIMEOUT",
      accountName,
      `Sign-in for account "${accountName}" timed out after ${MAX_WAIT_SECONDS} seconds — open ${verificationUri} and re-run.`,
      verificationUri,
    );
  }

  private async requestDeviceCode(
    accountName: string,
    authority: string,
    clientId: string,
  ): Promise<DeviceCodeResponse> {
    const response = await this.postForm(
      `${authority}/devicecode`,
      { client_id: clientId, scope: M365_SCOPES.join(" ") },
      "DEVICE_CODE_REQUEST_FAILED",
      accountName,
    );
    const payload = await readJsonObject(response);
    if (
      !response.ok ||
      typeof payload?.device_code !== "string" ||
      typeof payload?.user_code !== "string"
    ) {
      throw new M365AuthError(
        "DEVICE_CODE_REQUEST_FAILED",
        accountName,
        `Microsoft rejected the device-code request for account "${accountName}".`,
      );
    }
    const verificationUri = [payload.verification_uri, payload.verification_uri_complete, payload.verification_url].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (!verificationUri) {
      throw new M365AuthError(
        "DEVICE_CODE_REQUEST_FAILED",
        accountName,
        `Microsoft did not return a verification URL for account "${accountName}".`,
      );
    }
    return {
      device_code: payload.device_code,
      user_code: payload.user_code,
      verification_uri: verificationUri,
      expires_in: toSeconds(payload.expires_in, MAX_WAIT_SECONDS),
      interval: toSeconds(payload.interval, DEFAULT_INTERVAL_SECONDS),
    };
  }

  private async pollToken(
    accountName: string,
    authority: string,
    clientId: string,
    deviceCode: string,
  ): Promise<PollOutcome> {
    const response = await this.postForm(
      `${authority}/token`,
      { client_id: clientId, grant_type: DEVICE_CODE_GRANT, device_code: deviceCode },
      "TOKEN_REQUEST_FAILED",
      accountName,
    );
    const payload = await readJsonObject(response);
    if (response.ok && typeof payload?.access_token === "string") return { kind: "success", payload };
    const errorCode = typeof payload?.error === "string" ? payload.error : "unknown_error";
    switch (errorCode) {
      case "authorization_pending":
        return { kind: "pending" };
      case "slow_down":
        return { kind: "slow_down" };
      case "expired_token":
        return { kind: "expired" };
      case "authorization_declined":
      case "access_denied":
        return { kind: "denied", errorCode };
      default:
        return { kind: "failed", errorCode };
    }
  }

  private async refresh(accountName: string, refreshToken: string): Promise<TokenSet> {
    const settings = await this.accountSettings.read(accountName);
    const response = await this.postForm(
      `${this.authorityFor(settings.tenantId)}/token`,
      {
        client_id: settings.clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: M365_SCOPES.join(" "),
      },
      "TOKEN_REQUEST_FAILED",
      accountName,
    );
    const payload = await readJsonObject(response);
    if (!response.ok || typeof payload?.access_token !== "string") {
      const errorCode = typeof payload?.error === "string" ? payload.error : "unknown_error";
      if (errorCode === "invalid_grant" || errorCode === "invalid_refresh_token") {
        throw new M365AuthError(
          "AUTH_REQUIRED",
          accountName,
          `Sign-in for account "${accountName}" can no longer be refreshed (${errorCode}) — run \`--auth m365 --account ${accountName}\` to sign in again.`,
        );
      }
      throw new M365AuthError(
        "TOKEN_REQUEST_FAILED",
        accountName,
        `Refreshing the token for account "${accountName}" failed (${errorCode}) — try again.`,
      );
    }
    const tokens = this.tokenSetFromResponse(payload, refreshToken);
    await this.tokenStore.set("m365", accountName, tokens);
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
      scopes: [...M365_SCOPES],
    };
  }

  private async postForm(
    url: string,
    params: Record<string, string>,
    errorCode: M365AuthErrorCode,
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
      throw new M365AuthError(
        errorCode,
        accountName,
        `Microsoft sign-in could not be reached for account "${accountName}".`,
      );
    }
  }
}
