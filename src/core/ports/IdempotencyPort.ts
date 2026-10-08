export interface IdempotencyPort {
  /**
   * Key format: `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))`
   * — the `accountId` prefix partitions one shared store across accounts.
   */
  has(key: string): Promise<boolean>;
  set(key: string): Promise<void>;
}
