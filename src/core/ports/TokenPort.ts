import type { TokenSet } from "../dto/TokenSet.js";

export interface TokenPort {
  get(provider: "m365" | "gmail", accountId: string): Promise<TokenSet>;
  set(provider: "m365" | "gmail", accountId: string, tokens: TokenSet): Promise<void>;
  delete(provider: "m365" | "gmail", accountId: string): Promise<void>;
}
