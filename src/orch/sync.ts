import type { LabelDef } from "../core/dto/LabelDef.js";
import type { LogPort } from "../core/ports/LogPort.js";

/** The one `MailPort` method this loop needs; both provider adapters implement it (AD-8). */
export interface CategorySyncTarget {
  ensureCategories(accountId: string, labels: LabelDef[]): Promise<void>;
}

export interface SyncCategoriesOptions {
  accounts: string[];
  /** The frozen merged taxonomy (Story 4.1); the orchestrator consumes it and never re-validates it. */
  labels: LabelDef[];
  mailPort: CategorySyncTarget;
  logPort: LogPort;
}

/** Renders one actionable line — never a stack trace or a raw payload (AD-4). */
function errorLine(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ensures the taxonomy's categories exist for every account, independently: one
 * account's failure (auth, non-2xx, network) is logged with its `accountId` and never
 * aborts the others. Returns the failure count so the caller can set an exit code.
 * Story 4.3 reuses this loop for Gmail labels.
 */
export async function syncCategories(options: SyncCategoriesOptions): Promise<number> {
  const { accounts, labels, mailPort, logPort } = options;
  let failures = 0;
  for (const accountId of accounts) {
    try {
      await mailPort.ensureCategories(accountId, labels);
      logPort.info(`Ensured ${labels.length} categories.`, { accountId });
    } catch (error) {
      failures += 1;
      logPort.error(errorLine(error), { accountId });
    }
  }
  return failures;
}
