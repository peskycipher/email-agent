import { isEmailCategory, type EmailCategory } from "./classify/categories.ts";
import type { PlannedAction } from "./store.ts";

export type CategoryApprovals = Partial<Record<EmailCategory, boolean>>;

export function collectPlannedCategories(actions: PlannedAction[]): EmailCategory[] {
  const categories = new Set<EmailCategory>();

  for (const action of actions) {
    if (action.action !== "classify") {
      continue;
    }

    if (!action.category || !isEmailCategory(action.category)) {
      throw new Error(`Invalid category in dry-run plan for message ${action.message_id}`);
    }

    categories.add(action.category);
  }

  return [...categories];
}

export function requireApprovalDecisions(categories: EmailCategory[], approvals: CategoryApprovals): Record<EmailCategory, boolean> {
  const decisions = {} as Record<EmailCategory, boolean>;

  for (const category of categories) {
    const approved = approvals[category];
    if (typeof approved !== "boolean") {
      throw new Error(`Missing explicit approval decision for category: ${category}`);
    }

    decisions[category] = approved;
  }

  return decisions;
}
