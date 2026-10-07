export type MailboxMessage = {
  id: string;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
  flagged: boolean;
  categories: string[];
};

export type MailboxMessageState = {
  id: string;
  from: string;
  subject: string;
  flagged: boolean;
  unread: boolean;
};

export type MailboxAction = "classify" | "archive";

export type MailboxAdapter = {
  listRecentInbox(limit: number): Promise<MailboxMessage[]>;
  getMessage(messageId: string): Promise<MailboxMessageState>;
  apply(
    messageId: string,
    action: MailboxAction,
    category?: string,
    existingCategories?: string[]
  ): Promise<{ ok: boolean; error?: string }>;
};
