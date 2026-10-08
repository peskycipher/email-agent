import { test, expect } from "vitest";
import * as core from "../../src/core/index";

test("core barrel loads and is empty", () => {
  expect(core).toBeDefined();
  expect(Object.keys(core)).toHaveLength(0);
});
