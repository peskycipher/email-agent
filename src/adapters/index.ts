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

export { accountSettingsDisplayPath, accountsDir, accountsDirDisplayPath, listEnabledAccounts, readAccountSettings, AccountSettingsError } from "./m365/accountSettings.js";
export type {
  AccountSettingsErrorCode,
  AccountSettingsOptions,
  AccountSettingsReader,
  M365AccountSettings,
} from "./m365/accountSettings.js";
