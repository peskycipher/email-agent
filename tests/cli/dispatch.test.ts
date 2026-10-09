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

test("--backfill without --source defaults to m365 and --account to all", () => {
  expect(resolveCliCommand({ backfill: true })).toEqual({ kind: "backfill", source: "m365", account: "all" });
});

test("--backfill --source m365 --account work targets that one account", () => {
  expect(resolveCliCommand({ backfill: true, source: "m365", account: "work" })).toEqual({
    kind: "backfill",
    source: "m365",
    account: "work",
  });
});

test("--backfill --source gmail names Story 5.3 and never fetches (CLI_SOURCE)", () => {
  const command = resolveCliCommand({ backfill: true, source: "gmail" });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("Story 5.3");
});

test("--backfill --source all is rejected with the Story 5.3 line", () => {
  const command = resolveCliCommand({ backfill: true, source: "all" });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("Story 5.3");
});

test("--backfill --source outlook is rejected as an unknown source", () => {
  const command = resolveCliCommand({ backfill: true, source: "outlook" });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain('Unknown --source "outlook"');
});

test("--source without --backfill is rejected, never silently ignored", () => {
  const command = resolveCliCommand({ source: "m365", syncCategories: true });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("--source requires --backfill");
});

test("--backfill --auth is rejected, never silently ignored", () => {
  const command = resolveCliCommand({ backfill: true, auth: "m365", account: "work" });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("--backfill and --auth");
});

test("--backfill combined with --sync-categories is rejected", () => {
  const command = resolveCliCommand({ backfill: true, syncCategories: true });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("--backfill and --sync-categories");
});
