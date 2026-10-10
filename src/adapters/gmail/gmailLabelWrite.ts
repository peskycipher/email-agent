import { readLabelIds } from "./messageMapper.js";
import {
  authorizationHeader,
  getRequest,
  postRequest,
  readJsonObject,
  send,
  MESSAGES_URL,
  GmailAdapterError,
  type GmailAdapterServices,
} from "./gmailWire.js";

/**
 * Add-only label write for a single Gmail message (Story 7.2). Resolves each predicted
 * taxonomy name to its id in the account's cached name → id map, reads the message's current
 * `labelIds`, and POSTs `addLabelIds` with only the ids that are missing. Existing labels
 * are never removed. A per-message 404 is logged and absorbed so one moved message cannot
 * fail a batch.
 */
export async function writeLabels(
  services: GmailAdapterServices,
  accountId: string,
  messageId: string,
  labels: string[],
): Promise<void> {
  if (labels.length === 0) return;
  try {
    await runWriteLabels(services, accountId, messageId, labels);
  } catch (error) {
    if (error instanceof GmailAdapterError && error.status === 401) {
      const refreshed = (await services.getAccessToken(accountId, { forceRefresh: true })).accessToken;
      await runWriteLabels(services, accountId, messageId, labels, refreshed);
      return;
    }
    throw error;
  }
}

async function runWriteLabels(
  services: GmailAdapterServices,
  accountId: string,
  messageId: string,
  labels: string[],
  token?: string,
): Promise<void> {
  const effectiveToken = token ?? (await services.getAccessToken(accountId)).accessToken;

  const labelIdsMap = services.labelIdsByAccount.get(accountId);
  if (labelIdsMap === undefined) {
    throw new GmailAdapterError(
      "WRITE_LABELS_FAILED",
      accountId,
      `No label sync cache for account "${accountId}" — run sync-categories before writing labels.`,
    );
  }

  const predictedIds = new Set<string>();
  for (const name of labels) {
    const id = labelIdsMap.get(name);
    if (id === undefined) {
      throw new GmailAdapterError(
        "WRITE_LABELS_FAILED",
        accountId,
        `No Gmail label id cached for "${name}" in account "${accountId}".`,
      );
    }
    predictedIds.add(id);
  }

  const messageUrl = `${MESSAGES_URL}/${encodeURIComponent(messageId)}`;
  const readUrl = `${messageUrl}?format=minimal&fields=labelIds`;
  const readResponse = await send(
    services.fetchFn,
    readUrl,
    getRequest(authorizationHeader(effectiveToken)),
    accountId,
    "WRITE_LABELS_FAILED",
  );
  if (readResponse.status === 404) {
    warnMessageNotFound(services, accountId, messageId);
    return;
  }
  if (!readResponse.ok) {
    throw new GmailAdapterError(
      "WRITE_LABELS_FAILED",
      accountId,
      `Gmail refused to read message "${messageId}" for account "${accountId}" (HTTP ${readResponse.status}).`,
      readResponse.status,
    );
  }

  const body = await readJsonObject(readResponse);
  if (typeof body !== "object" || body === null || !Array.isArray(body.labelIds)) {
    throw new GmailAdapterError(
      "WRITE_LABELS_FAILED",
      accountId,
      `Gmail returned message "${messageId}" without a labelIds list for account "${accountId}".`,
    );
  }
  const existingIds = readLabelIds(body);

  const missing: string[] = [];
  for (const id of predictedIds) {
    if (!existingIds.includes(id)) missing.push(id);
  }
  if (missing.length === 0) return;

  const modifyResponse = await send(
    services.fetchFn,
    `${messageUrl}/modify`,
    postRequest(authorizationHeader(effectiveToken), { addLabelIds: missing }),
    accountId,
    "WRITE_LABELS_FAILED",
  );
  if (modifyResponse.status === 404) {
    warnMessageNotFound(services, accountId, messageId);
    return;
  }
  if (!modifyResponse.ok) {
    throw new GmailAdapterError(
      "WRITE_LABELS_FAILED",
      accountId,
      `Gmail refused to write labels to message "${messageId}" for account "${accountId}" (HTTP ${modifyResponse.status}).`,
      modifyResponse.status,
    );
  }
}

function warnMessageNotFound(services: GmailAdapterServices, accountId: string, messageId: string): void {
  services.logPort.warn(
    `Message "${messageId}" was not found for account "${accountId}" — skipping label write.`,
    { accountId, messageId },
  );
}
