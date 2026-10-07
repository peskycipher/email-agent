import fs from "node:fs/promises";
import path from "node:path";

import type { MailboxAction } from "./adapter.ts";

export type AuditAction = MailboxAction;

export type AuditRecord = {
  timestamp: string;
  account: string;
  message_id: string;
  action: AuditAction;
  /** Comma-joined labels attached to the message. */
  labels: string;
  outcome: string;
  rationale: string;
  run_id: string;
};

const REQUIRED_FIELDS: Array<keyof AuditRecord> = [
  "timestamp",
  "account",
  "message_id",
  "action",
  "labels",
  "outcome",
  "rationale",
  "run_id"
];

function validateRecord(record: AuditRecord): void {
  for (const field of REQUIRED_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Missing required audit field: ${field}`);
    }
  }

  if (record.action !== "classify" && record.action !== "archive") {
    throw new Error(`Invalid audit action: ${record.action}`);
  }
}

export async function appendAuditRecord(logPath: string, record: AuditRecord): Promise<void> {
  validateRecord(record);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
}
