export interface MessageDTO {
  id: string;
  internetMessageId: string;
  subject: string;
  bodyPreview: string;
  senderEmail: string;
  senderName: string;
  /** ISO 8601 UTC. */
  receivedDateTime: string;
  existingLabels: string[];
  source: "m365" | "gmail";
  accountId: string;
  raw?: unknown;
}
