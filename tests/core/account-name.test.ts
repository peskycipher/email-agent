import { test, expect } from "vitest";
import { ACCOUNT_NAME_PATTERN } from "../../src/core/dto/accountName.js";

test("accepts lowercase slugs", () => {
  expect(ACCOUNT_NAME_PATTERN.test("personal")).toBe(true);
  expect(ACCOUNT_NAME_PATTERN.test("a-b_1")).toBe(true);
});

test("accepts the boundary lengths (1 and 32 chars)", () => {
  expect(ACCOUNT_NAME_PATTERN.test("a")).toBe(true);
  expect(ACCOUNT_NAME_PATTERN.test("a".repeat(32))).toBe(true);
});

test("rejects the empty string and accepts a trailing separator", () => {
  expect(ACCOUNT_NAME_PATTERN.test("")).toBe(false);
  expect(ACCOUNT_NAME_PATTERN.test("a-")).toBe(true);
});

test("rejects names that are uppercase or start with a separator", () => {
  expect(ACCOUNT_NAME_PATTERN.test("Personal")).toBe(false);
  expect(ACCOUNT_NAME_PATTERN.test("-bad")).toBe(false);
  expect(ACCOUNT_NAME_PATTERN.test("_bad")).toBe(false);
});

test("rejects a 33-character name", () => {
  expect(ACCOUNT_NAME_PATTERN.test("a".repeat(33))).toBe(false);
});
