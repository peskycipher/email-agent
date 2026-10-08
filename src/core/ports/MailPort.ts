import type { FetchOpts } from "../dto/FetchOpts.js";
import type { LabelDef } from "../dto/LabelDef.js";
import type { MessageDTO } from "../dto/MessageDTO.js";

export interface MailPort {
  fetchMessages(opts: FetchOpts): Promise<MessageDTO[]>;
  writeLabels(accountId: string, messageId: string, labels: string[]): Promise<void>;
  ensureCategories(accountId: string, labels: LabelDef[]): Promise<void>;
}
