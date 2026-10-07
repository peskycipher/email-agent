export const EMAIL_CATEGORIES = [
  "Action Needed",
  "Waiting/Follow-up",
  "FYI/Reference",
  "Bulk/Archive"
] as const;

export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export function isEmailCategory(value: string): value is EmailCategory {
  return EMAIL_CATEGORIES.includes(value as EmailCategory);
}
