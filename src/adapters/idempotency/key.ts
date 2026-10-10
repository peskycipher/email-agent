import { createHash } from "node:crypto";

/**
 * The AC's frozen row identity for one classified message:
 * `sha256(accountId + "|" + internetMessageId + "|" + sorted(labels).join(","))`.
 *
 * The `accountId` is baked into the hash — it is what partitions the one shared store across
 * accounts — and the labels are sorted, so the same label set always yields the same key. Kept
 * here rather than in `core` because `IdempotencyPort` takes an opaque key and `core` may not
 * import `node:crypto` (AD-10).
 */
export function idempotencyKey(accountId: string, internetMessageId: string, labels: string[]): string {
  const canonical = `${accountId}|${internetMessageId}|${[...labels].sort().join(",")}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
