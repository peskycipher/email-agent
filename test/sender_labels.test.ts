import test from "node:test";
import assert from "node:assert/strict";

import type { MailboxMessage } from "../src/adapter.ts";
import { buildSenderLabelResolver } from "../src/sender_labels.ts";

function message(from: string): MailboxMessage {
  return {
    id: "msg-1",
    from,
    subject: "Hello",
    date: "2026-01-01T00:00:00.000Z",
    unread: true,
    flagged: false,
    categories: []
  };
}

test("buildSenderLabelResolver maps configured senders and the IT News domain", () => {
  const resolve = buildSenderLabelResolver({
    familySenders: ["Mum@Example.com"],
    friendSenders: ["dave@example.com"]
  });

  // Case-insensitive exact match.
  assert.deepEqual(resolve(message("mum@example.com")), ["Family"]);
  assert.deepEqual(resolve(message("dave@example.com")), ["Friends"]);
  // Substring is not enough — only the exact address matches.
  assert.deepEqual(resolve(message("notmum@example.com")), []);
  // Source domain, regardless of local part.
  assert.deepEqual(resolve(message("newsletter@email.itnews.com.au")), ["IT News"]);
  assert.deepEqual(resolve(message("someone@example.com")), []);
});

test("buildSenderLabelResolver returns no labels without config", () => {
  const resolve = buildSenderLabelResolver({});
  assert.deepEqual(resolve(message("mum@example.com")), []);
});
