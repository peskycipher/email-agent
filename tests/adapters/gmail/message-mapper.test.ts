import { expect, test } from "vitest";
import { mapGmailMessage } from "../../../src/adapters/gmail/messageMapper.js";

/** A `format=metadata` Gmail detail carrying every field the mapper reads. */
function gmailDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "18f0a",
    threadId: "18f0a",
    internetMessageId: "<invoice@example.com>",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Your invoice is attached.",
    // 2025-10-09T08:53:19.000Z as Gmail's epoch-millisecond string.
    internalDate: "1759999999000",
    payload: {
      headers: [
        { name: "From", value: "Billing <billing@example.com>" },
        { name: "Subject", value: "Your invoice" },
      ],
    },
    ...overrides,
  };
}

test("maps a Gmail detail onto the canonical DTO (MAPPING)", () => {
  const message = mapGmailMessage(gmailDetail(), "personal");

  expect(message).toEqual({
    id: "18f0a",
    internetMessageId: "<invoice@example.com>",
    subject: "Your invoice",
    bodyPreview: "Your invoice is attached.",
    senderEmail: "billing@example.com",
    senderName: "Billing",
    receivedDateTime: "2025-10-09T08:53:19.000Z",
    existingLabels: ["INBOX", "UNREAD"],
    source: "gmail",
    accountId: "personal",
    // The label list carries UNREAD, so the message is unread.
    isRead: false,
  });
});

test("a detail missing subject, snippet, labelIds and headers degrades to empty values (MISSING_FIELDS)", () => {
  const message = mapGmailMessage({}, "personal");

  expect(message).toEqual({
    id: "",
    internetMessageId: "",
    subject: "",
    bodyPreview: "",
    senderEmail: "",
    senderName: "",
    receivedDateTime: "",
    existingLabels: [],
    source: "gmail",
    accountId: "personal",
    // No UNREAD label is present, so the absence reading makes the message read.
    isRead: true,
  });
});

test("labelIds containing UNREAD marks the message unread (UNREAD)", () => {
  const message = mapGmailMessage(gmailDetail({ labelIds: ["INBOX", "UNREAD"] }), "personal");

  expect(message.isRead).toBe(false);
});

test("labelIds without UNREAD marks the message read (UNREAD)", () => {
  const message = mapGmailMessage(gmailDetail({ labelIds: ["INBOX", "IMPORTANT"] }), "personal");

  expect(message.isRead).toBe(true);
});

test("a non-array labelIds degrades to [] and drops non-string members", () => {
  expect(mapGmailMessage(gmailDetail({ labelIds: "INBOX" }), "personal").existingLabels).toEqual([]);
  expect(
    mapGmailMessage(gmailDetail({ labelIds: ["INBOX", 7, null] }), "personal").existingLabels,
  ).toEqual(["INBOX"]);
});

test("a bare From address has no display name and a quoted name is unquoted", () => {
  expect(
    mapGmailMessage(
      gmailDetail({ payload: { headers: [{ name: "From", value: "bare@example.com" }] } }),
      "personal",
    ),
  ).toMatchObject({ senderEmail: "bare@example.com", senderName: "" });
  expect(
    mapGmailMessage(
      gmailDetail({ payload: { headers: [{ name: "From", value: '"Doe, John" <john@example.com>' }] } }),
      "personal",
    ),
  ).toMatchObject({ senderEmail: "john@example.com", senderName: "Doe, John" });
});

test("an unparseable internalDate degrades to \"\" rather than throwing", () => {
  expect(mapGmailMessage(gmailDetail({ internalDate: "not-a-number" }), "personal").receivedDateTime).toBe("");
  expect(mapGmailMessage(gmailDetail({ internalDate: 1759999999000 }), "personal").receivedDateTime).toBe("");
});

test("the account id is carried through verbatim", () => {
  expect(mapGmailMessage(gmailDetail(), "work").accountId).toBe("work");
});
