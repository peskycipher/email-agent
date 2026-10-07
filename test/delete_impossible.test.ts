import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MailboxAction } from "../src/adapter.ts";
import type { AuditAction } from "../src/audit.ts";
import { appendAuditRecord } from "../src/audit.ts";

test("delete is not assignable to the mailbox or audit action unions", () => {
  // @ts-expect-error delete is intentionally not part of the V1 action set
  const mailboxAction: MailboxAction = "delete";

  // @ts-expect-error delete is intentionally not part of the audit action set
  const auditAction: AuditAction = "delete";

  assert.equal(mailboxAction, "delete");
  assert.equal(auditAction, "delete");
});

test("audit writer rejects the delete action at runtime", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delete-impossible-"));
  const logPath = path.join(dir, "audit.jsonl");

  await assert.rejects(
    appendAuditRecord(logPath, {
      timestamp: "2026-01-01T00:00:00.000Z",
      account: "pilot@example.com",
      message_id: "message-1",
      action: "delete" as unknown as AuditAction,
      outcome: "success",
      rationale: "should-not-be-possible",
      run_id: "run-1"
    }),
    /Invalid audit action: delete/
  );
});
