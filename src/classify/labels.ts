/**
 * Flat multi-label vocabulary. An email carries any number of these labels;
 * labels are orthogonal (an email can be Realestate + Invoices + Action Needed).
 *
 * Values are canonical Title Case strings, stored verbatim in run/plan records
 * and written as Outlook categories.
 */
export const EMAIL_LABELS = [
  "Action Needed",
  "Waiting/Follow Up",
  "Important",
  "Realestate",
  "Invoices",
  "Crypto",
  "Business",
  "Travel",
  "Clients",
  "Family",
  "Friends",
  "IT News",
  "Newsletters",
  "Promos",
  "Notifications",
  "Subscriptions"
] as const;

export type EmailLabel = (typeof EMAIL_LABELS)[number];

export function isEmailLabel(value: string): value is EmailLabel {
  return (EMAIL_LABELS as readonly string[]).includes(value);
}

/** Labels the model may infer from message content. */
export const MODEL_INFERABLE_LABELS: EmailLabel[] = EMAIL_LABELS.filter(
  (label) => label !== "Family" && label !== "Friends" && label !== "IT News"
);

/**
 * Labels that mark a message as safe to archive. A message is archive-eligible
 * when it carries at least one of these and no veto label.
 * ponytail: any-safe-label-is-enough; tighten to all-labels-safe if promos start
 * riding along with action items.
 */
export const ARCHIVE_SAFE_LABELS: EmailLabel[] = [
  "Newsletters",
  "Promos",
  "Notifications",
  "Subscriptions",
  "IT News"
];

/**
 * Labels that veto archiving even when an archive-safe label is also present.
 * The neutral labels (Realestate, Invoices, Crypto, Business, Travel, Clients,
 * Waiting/Follow Up) neither qualify a message for archiving nor block it.
 */
export const ARCHIVE_VETO_LABELS: EmailLabel[] = ["Action Needed", "Important", "Family", "Friends"];

export function isArchiveSafe(label: EmailLabel): boolean {
  return ARCHIVE_SAFE_LABELS.includes(label);
}
