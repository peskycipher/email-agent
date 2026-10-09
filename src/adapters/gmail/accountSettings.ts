import { z } from "zod";
import { ACCOUNT_NAME_PATTERN } from "../../core/dto/accountName.js";
import {
  createPerAccountSettings,
  type AccountSettingsErrorCode,
  type PerAccountSettingsListing,
  type PerAccountSettingsOptions,
  type PerAccountSettingsReader,
} from "../config/perAccountSettings.js";

/**
 * Temporary per-account reader for `--account all` (Story 2.1 decision 1, applied to
 * Gmail in Story 3.1): Epic 11 replaces it with `ConfigLoader`/DI over
 * `Config.gmail.accounts[]`. Validates the four auth keys plus the optional
 * Story 5.3 fetch keys (`labels` — Gmail label **ids** such as `Label_5`, not names;
 * `batchSize`), mirroring m365's `folders`/`batchSize`.
 */
const accountSettingsSchema = z.object({
  name: z.string().regex(ACCOUNT_NAME_PATTERN),
  enabled: z.boolean(),
  clientId: z.string().min(1),
  clientSecretEnvVar: z.string().min(1),
  // Story 5.3: optional so Story 3.1's `toEqual` on a four-key settings file stays green.
  labels: z.array(z.string().min(1)).min(1).optional(),
  batchSize: z.number().int().min(1).max(100).optional(),
});

export type GmailAccountSettings = z.infer<typeof accountSettingsSchema>;

export type AccountSettingsReader = PerAccountSettingsReader<GmailAccountSettings>;
export type AccountSettingsOptions = PerAccountSettingsOptions;
export type GmailAccountsListing = PerAccountSettingsListing<GmailAccountSettings>;

export { AccountSettingsError } from "../config/perAccountSettings.js";
export type { AccountSettingsErrorCode };

const settings = createPerAccountSettings({
  provider: "gmail",
  schema: accountSettingsSchema,
  displayDir: "~/.config/email-classify/accounts/gmail",
});

export const {
  accountsDir,
  accountsDirDisplayPath,
  accountSettingsDisplayPath,
  readAccountSettings,
  listEnabledAccounts,
} = settings;
