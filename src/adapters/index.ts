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

export { mapGraphMessage } from "./m365/messageMapper.js";

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

export { GmailAdapter, GmailAdapterError } from "./gmail/GmailAdapter.js";
export type {
  GmailAdapterDeps,
  GmailAdapterErrorCode,
  GmailHistoryOpts,
  GmailHistoryOutcome,
  GmailLabelIds,
} from "./gmail/GmailAdapter.js";

export { mapGmailMessage } from "./gmail/messageMapper.js";

export { loadTaxonomy, TaxonomyError } from "./config/taxonomy.js";
export type { LoadTaxonomyOptions, TaxonomyErrorCode } from "./config/taxonomy.js";

export { completeWithRetry, labelSetSchema, validateLabelSet } from "./model/labelSetValidation.js";
export type { CompleteWithRetryOptions, LabelSetValidation } from "./model/labelSetValidation.js";

export { JevAdapter } from "./model/JevAdapter.js";
export type {
  JevAdapterDeps,
  JevClient,
  JevClientOptions,
  JevNoulQuestion,
  JevSystemOneRequest,
  JevSystemOneResult,
} from "./model/JevAdapter.js";

export { buildLabelSetResponseSchema, OpenAIAdapter } from "./model/OpenAIAdapter.js";
export type {
  OpenAIAdapterDeps,
  OpenAIChatClient,
  OpenAIChatCompletion,
  OpenAIChatParams,
  OpenAIClientOptions,
} from "./model/OpenAIAdapter.js";

export {
  createModelAdapter,
  defaultModelClientFactories,
  DEFAULT_MODEL_CONFIG,
  ModelAdapterError,
} from "./model/modelAdapterFactory.js";
export type {
  ModelAdapterDeps,
  ModelAdapterErrorCode,
} from "./model/modelAdapterFactory.js";

export {
  accountStateDir,
  readAccountState,
  stateFileDisplayPath,
  writeLastHistoryId,
  writeLastRunTimestamp,
  StateFileError,
} from "./config/stateFile.js";
export type { AccountState, StateFileErrorCode, StateFileOptions } from "./config/stateFile.js";

export { IdempotencyStore, IdempotencyStoreError } from "./idempotency/sqliteIdempotencyStore.js";
export type { IdempotencyStoreErrorCode, IdempotencyStoreOptions } from "./idempotency/sqliteIdempotencyStore.js";
export { idempotencyKey } from "./idempotency/key.js";

export { acquireRunLock, releaseRunLock, runLockPath, RunLockError } from "./lock/runLock.js";
export type { RunLockErrorCode, RunLockOptions } from "./lock/runLock.js";

export { createScheduler } from "./scheduler/scheduler.js";
