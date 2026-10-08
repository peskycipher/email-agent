export { KeychainTokenStore, TokenStoreError } from "./token/KeychainTokenStore.js";
export type { KeychainBinding, KeychainTokenStoreDeps, PassphrasePrompt, TokenStoreErrorCode } from "./token/KeychainTokenStore.js";

export { M365AuthAdapter, M365AuthError, M365_SCOPES } from "./m365/M365AuthAdapter.js";
export type {
  DeviceCodePrompt,
  FetchLike,
  FetchResponseLike,
  M365AuthAdapterDeps,
  M365AuthErrorCode,
} from "./m365/M365AuthAdapter.js";

export { M365Adapter, M365AdapterError } from "./m365/M365Adapter.js";
export type { M365AdapterDeps, M365AdapterErrorCode } from "./m365/M365Adapter.js";

export { accountSettingsDisplayPath, accountsDir, accountsDirDisplayPath, listEnabledAccounts, readAccountSettings, AccountSettingsError } from "./m365/accountSettings.js";
export type {
  AccountSettingsErrorCode,
  AccountSettingsOptions,
  AccountSettingsReader,
  M365AccountSettings,
  M365AccountsListing,
} from "./m365/accountSettings.js";

export { GmailAuthAdapter, GmailAuthError, GmailConsentError, GMAIL_SCOPES, authorizeWithLoopback } from "./gmail/GmailAuthAdapter.js";
export type {
  AuthorizeFn,
  GmailAuthAdapterDeps,
  GmailAuthErrorCode,
  GmailConsentErrorCode,
  LoopbackAuthorizeOptions,
} from "./gmail/GmailAuthAdapter.js";

export * as gmailAccountSettings from "./gmail/accountSettings.js";
export type { GmailAccountSettings, GmailAccountsListing } from "./gmail/accountSettings.js";

export { loadTaxonomy, TaxonomyError } from "./config/taxonomy.js";
export type { LoadTaxonomyOptions, TaxonomyErrorCode } from "./config/taxonomy.js";
