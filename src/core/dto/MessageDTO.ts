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
  /**
   * Provider read state (Graph's `isRead`, Gmail's `UNREAD` absence). Optional and additive
   * (Story 5.1 decision, 2026-10-09) so every existing `MessageDTO` consumer is unchanged.
   */
  isRead?: boolean;
  raw?: unknown;
}
