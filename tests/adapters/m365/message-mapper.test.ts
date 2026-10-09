import { expect, test } from "vitest";
import { mapGraphMessage } from "../../../src/adapters/m365/messageMapper.js";

test("maps a full Graph entry onto the canonical MessageDTO (FULL)", () => {
  const dto = mapGraphMessage(
    {
      id: "AAMkAD",
      internetMessageId: "<invoice@example.com>",
      subject: "Your invoice",
      bodyPreview: "Your invoice is attached.",
      receivedDateTime: "2026-10-09T12:34:56Z",
      categories: ["Action Needed", "Crypto"],
      isRead: true,
      from: { emailAddress: { address: "billing@example.com", name: "Billing" } },
    },
    "work",
  );

  expect(dto).toEqual({
    id: "AAMkAD",
    internetMessageId: "<invoice@example.com>",
    subject: "Your invoice",
    bodyPreview: "Your invoice is attached.",
    senderEmail: "billing@example.com",
    senderName: "Billing",
    receivedDateTime: "2026-10-09T12:34:56Z",
    existingLabels: ["Action Needed", "Crypto"],
    source: "m365",
    accountId: "work",
    isRead: true,
  });
});

test("a missing subject, bodyPreview, categories and from degrade to empty values (MISSING_FIELDS)", () => {
  const dto = mapGraphMessage({ id: "AAMkAD", receivedDateTime: "2026-10-09T12:34:56Z" }, "home");

  expect(dto).toEqual({
    id: "AAMkAD",
    internetMessageId: "",
    subject: "",
    bodyPreview: "",
    senderEmail: "",
    senderName: "",
    receivedDateTime: "2026-10-09T12:34:56Z",
    existingLabels: [],
    source: "m365",
    accountId: "home",
  });
  expect(dto.isRead).toBeUndefined();
});

test("a non-boolean isRead is omitted rather than coerced", () => {
  const dto = mapGraphMessage({ id: "m1", isRead: "true" }, "work");

  expect(dto.isRead).toBeUndefined();
  expect("isRead" in dto).toBe(false);
});

test("isRead false is preserved", () => {
  expect(mapGraphMessage({ id: "m1", isRead: false }, "work").isRead).toBe(false);
});

test("mistyped fields degrade instead of throwing or dropping the entry", () => {
  const dto = mapGraphMessage(
    {
      id: 42,
      subject: null,
      categories: "Action Needed",
      from: { emailAddress: { address: 7, name: 8 } },
    },
    "work",
  );

  expect(dto).toEqual({
    id: "",
    internetMessageId: "",
    subject: "",
    bodyPreview: "",
    senderEmail: "",
    senderName: "",
    receivedDateTime: "",
    existingLabels: [],
    source: "m365",
    accountId: "work",
  });
});

test("non-string members of categories are dropped, not kept as junk", () => {
  const dto = mapGraphMessage({ id: "m1", categories: ["Crypto", 7, null, "Action Needed"] }, "work");

  expect(dto.existingLabels).toEqual(["Crypto", "Action Needed"]);
});

test("a non-object entry still yields a valid DTO", () => {
  expect(mapGraphMessage(null, "work")).toEqual({
    id: "",
    internetMessageId: "",
    subject: "",
    bodyPreview: "",
    senderEmail: "",
    senderName: "",
    receivedDateTime: "",
    existingLabels: [],
    source: "m365",
    accountId: "work",
  });
});
