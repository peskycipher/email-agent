import type { LabelDef } from "../../core/dto/LabelDef.js";
import { nearestGmailColor, textColorFor } from "./labelColors.js";
import {
  authorizationHeader,
  getRequest,
  LABELS_URL,
  postRequest,
  readJsonObject,
  readString,
  send,
  GmailAdapterError,
  type GmailAdapterServices,
} from "./gmailWire.js";

/**
 * Idempotent label sync: reads the account's labels, then creates only the labels whose `name` is
 * absent — an exact, case-sensitive match. A label that already exists keeps its name and colour;
 * nothing is ever renamed, re-coloured or deleted. Every taxonomy name ends up in the account's
 * name → id map, ids drawn from the list for the labels that existed and from each create response
 * for the rest.
 */
export async function ensureCategories(
  services: GmailAdapterServices,
  accountId: string,
  labels: LabelDef[],
): Promise<void> {
  const token = (await services.getAccessToken(accountId)).accessToken;
  const known = await listLabels(services, accountId, token);
  const labelIds = new Map<string, string>();
  for (const label of labels) {
    const existingId = known.get(label.name);
    if (existingId !== undefined) {
      labelIds.set(label.name, existingId);
      continue;
    }
    const createdId = await createLabel(services, accountId, token, label);
    labelIds.set(label.name, createdId);
    // A caller can pass the same name twice; remembering the create stops the second
    // one from being POSTed into a duplicate (or a 409).
    known.set(label.name, createdId);
  }
  services.labelIdsByAccount.set(accountId, labelIds);
}

async function listLabels(
  services: GmailAdapterServices,
  accountId: string,
  token: string,
): Promise<Map<string, string>> {
  const response = await send(
    services.fetchFn,
    LABELS_URL,
    getRequest(authorizationHeader(token)),
    accountId,
    "LIST_LABELS_FAILED",
  );
  if (!response.ok) {
    throw new GmailAdapterError(
      "LIST_LABELS_FAILED",
      accountId,
      `Gmail refused to list the labels for account "${accountId}" (HTTP ${response.status}).`,
      response.status,
    );
  }
  const body = await readJsonObject(response);
  const page = body?.labels;
  if (!Array.isArray(page)) {
    // Without the list there is no way to tell which labels exist; creating them anyway
    // would duplicate every one.
    throw new GmailAdapterError(
      "LIST_LABELS_FAILED",
      accountId,
      `Gmail returned no label list for account "${accountId}".`,
    );
  }
  const byName = new Map<string, string>();
  // Unlike M365's master categories, Gmail's label list has no page token — one response
  // carries them all.
  for (const entry of page) {
    const name = readString(entry, "name");
    const id = readString(entry, "id");
    if (name !== undefined && id !== undefined && !byName.has(name)) byName.set(name, id);
  }
  return byName;
}

async function createLabel(
  services: GmailAdapterServices,
  accountId: string,
  token: string,
  label: LabelDef,
): Promise<string> {
  // Google accepts only its documented palette, so the taxonomy's hex is the intent and
  // the nearest allowed pair is what actually goes on the wire.
  const backgroundColor = nearestGmailColor(label.gmailColor);
  const response = await send(
    services.fetchFn,
    LABELS_URL,
    postRequest(authorizationHeader(token), {
      name: label.name,
      color: { backgroundColor, textColor: textColorFor(backgroundColor) },
    }),
    accountId,
    "CREATE_LABEL_FAILED",
  );
  if (!response.ok) {
    throw new GmailAdapterError(
      "CREATE_LABEL_FAILED",
      accountId,
      `Gmail refused to create label "${label.name}" for account "${accountId}" (HTTP ${response.status}).`,
      response.status,
    );
  }
  const id = readString(await readJsonObject(response), "id");
  if (id === undefined) {
    // Without the id the label could never be written back to; the create is not usable.
    throw new GmailAdapterError(
      "CREATE_LABEL_FAILED",
      accountId,
      `Gmail created label "${label.name}" for account "${accountId}" but returned no label id.`,
    );
  }
  return id;
}
