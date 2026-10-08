import { expect, test } from "vitest";
import {
  GMAIL_LABEL_COLORS,
  nearestGmailColor,
  textColorFor,
} from "../../../src/adapters/gmail/labelColors.js";

test("the palette is the documented set of unique #RRGGBB values", () => {
  expect(GMAIL_LABEL_COLORS.length).toBe(113);
  expect(new Set(GMAIL_LABEL_COLORS).size).toBe(113);
  expect(GMAIL_LABEL_COLORS.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
});

test("a palette colour maps to itself", () => {
  for (const color of GMAIL_LABEL_COLORS) {
    expect(nearestGmailColor(color)).toBe(color);
  }
});

test("a taxonomy hex outside the palette maps to its nearest documented colour (COLOUR)", () => {
  // Action Needed's #E67C73 is not an allowed value; #e07798 is the closest of the 113.
  expect(nearestGmailColor("#E67C73")).toBe("#e07798");
  // Case does not matter: the taxonomy writes uppercase hex.
  expect(nearestGmailColor("#E67c73")).toBe("#e07798");
});

test("a tie keeps the earlier palette entry, so the mapping is deterministic", () => {
  // #878787 is midway between #999999 and #757575; #999999 comes first in the palette.
  expect(nearestGmailColor("#878787")).toBe("#999999");
});

test("text colour is black on a light background and white on a dark one", () => {
  expect(textColorFor("#ffffff")).toBe("#000000");
  expect(textColorFor("#000000")).toBe("#ffffff");
  expect(textColorFor("#e07798")).toBe("#000000");
  expect(textColorFor("#083018")).toBe("#ffffff");
});

test("both text colours are members of the documented palette", () => {
  expect(GMAIL_LABEL_COLORS).toContain(textColorFor("#ffffff"));
  expect(GMAIL_LABEL_COLORS).toContain(textColorFor("#000000"));
});
