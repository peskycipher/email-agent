import type { EmailLabel } from "./classify/labels.ts";
import type { PlannedAction } from "./store.ts";

export type LabelApprovals = Partial<Record<EmailLabel, boolean>>;

export function collectPlannedLabels(actions: PlannedAction[]): EmailLabel[] {
  const labels = new Set<EmailLabel>();

  for (const action of actions) {
    if (action.action !== "classify") {
      continue;
    }

    for (const label of action.labels) {
      labels.add(label);
    }
  }

  return [...labels];
}

export function requireApprovalDecisions(labels: EmailLabel[], approvals: LabelApprovals): Record<EmailLabel, boolean> {
  const decisions = {} as Record<EmailLabel, boolean>;

  for (const label of labels) {
    const approved = approvals[label];
    if (typeof approved !== "boolean") {
      throw new Error(`Missing explicit approval decision for label: ${label}`);
    }

    decisions[label] = approved;
  }

  return decisions;
}
