export type MailboxMessage = {
  id: string;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
  flagged: boolean;
  categories: string[];
};

export type MailboxAction = "classify" | "archive";

export type MailboxAdapter = {
  listRecentInbox(limit: number): Promise<MailboxMessage[]>;
  apply(messageId: string, action: MailboxAction, category?: string): Promise<{ ok: boolean; error?: string }>;
};
