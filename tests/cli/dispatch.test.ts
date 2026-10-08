import { expect, test } from "vitest";
import { resolveCliCommand } from "../../src/cli/dispatch.js";

test("--sync-categories without --account defaults to every enabled account", () => {
  expect(resolveCliCommand({ syncCategories: true })).toEqual({ kind: "sync", account: "all" });
});

test("--sync-categories --account work targets that one account", () => {
  expect(resolveCliCommand({ syncCategories: true, account: "work" })).toEqual({
    kind: "sync",
    account: "work",
  });
});

test("--auth with --account selects the auth command", () => {
  expect(resolveCliCommand({ auth: "gmail", account: "personal" })).toEqual({
    kind: "auth",
    provider: "gmail",
    account: "personal",
  });
});

test("--auth combined with --sync-categories is rejected, never silently ignored", () => {
  const command = resolveCliCommand({ auth: "m365", account: "work", syncCategories: true });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("--auth and --sync-categories");
});

test("no flags reports the required flags", () => {
  const command = resolveCliCommand({});

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("both required");
});

test("--account without --auth reports the required flags", () => {
  const command = resolveCliCommand({ account: "work" });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("both required");
});
