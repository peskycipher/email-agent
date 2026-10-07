import type { MailboxMessage } from "./adapter.ts";
import type { EmailLabel } from "./classify/labels.ts";

export type SenderLabelConfig = {
  familySenders?: string[];
  friendSenders?: string[];
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function matchesDomain(from: string, domain: string): boolean {
  return normalize(from).endsWith(`@${normalize(domain)}`);
}

/**
 * Family, Friends and IT News cannot be inferred from message content — they come
 * from who sent it. Family/Friends are configured address lists; IT News is the
 * itnews sender domain.
 */
export function buildSenderLabelResolver(config: SenderLabelConfig): (message: MailboxMessage) => EmailLabel[] {
  const family = new Set((config.familySenders ?? []).map(normalize));
  const friends = new Set((config.friendSenders ?? []).map(normalize));

  return (message: MailboxMessage): EmailLabel[] => {
    const labels: EmailLabel[] = [];
    const from = normalize(message.from);

    if (family.has(from)) {
      labels.push("Family");
    }

    if (friends.has(from)) {
      labels.push("Friends");
    }

    // ponytail: hardcoded IT News sender domain; move to config if more source
    // mappings appear.
    if (matchesDomain(message.from, "email.itnews.com.au")) {
      labels.push("IT News");
    }

    return labels;
  };
}
