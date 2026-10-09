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
 * Temporary per-account reader (Story 2.1 decision 1): Epic 11 replaces it with
 * `ConfigLoader`/DI over `Config.m365.accounts[]`. The reader machine now lives in
 * `adapters/config/perAccountSettings.ts` (Story 3.1), shared with Gmail.
 */
const accountSettingsSchema = z.object({
  name: z.string().regex(ACCOUNT_NAME_PATTERN),
  enabled: z.boolean(),
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  // Story 5.1: optional so Story 2.1's `toEqual` on a four-key settings file stays green.
  folders: z.array(z.string().min(1)).min(1).optional(),
  batchSize: z.number().int().min(1).max(100).optional(),
});

export type M365AccountSettings = z.infer<typeof accountSettingsSchema>;

export type AccountSettingsReader = PerAccountSettingsReader<M365AccountSettings>;
export type AccountSettingsOptions = PerAccountSettingsOptions;
export type M365AccountsListing = PerAccountSettingsListing<M365AccountSettings>;

export { AccountSettingsError } from "../config/perAccountSettings.js";
export type { AccountSettingsErrorCode };

const settings = createPerAccountSettings({
  provider: "m365",
  schema: accountSettingsSchema,
  displayDir: "~/.config/email-classify/accounts/m365",
});

export const {
  accountsDir,
  accountsDirDisplayPath,
  accountSettingsDisplayPath,
  readAccountSettings,
  listEnabledAccounts,
} = settings;
