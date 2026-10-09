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

test("--backfill --source gmail selects the Gmail path, defaulting --account to all (CLI_SOURCE)", () => {
  expect(resolveCliCommand({ backfill: true, source: "gmail" })).toEqual({
    kind: "backfill",
    source: "gmail",
    account: "all",
  });
});

test("--backfill --source gmail --account personal targets that one account", () => {
  expect(resolveCliCommand({ backfill: true, source: "gmail", account: "personal" })).toEqual({
    kind: "backfill",
    source: "gmail",
    account: "personal",
  });
});

test("--backfill --source all is rejected, since a backfill names one provider", () => {
  const command = resolveCliCommand({ backfill: true, source: "all" });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("--source all is not supported");
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

test("--cron without --source defaults to m365 and --account to all", () => {
  expect(resolveCliCommand({ cron: true })).toEqual({ kind: "cron", account: "all" });
});

test("--cron --source m365 --account work targets that one account", () => {
  expect(resolveCliCommand({ cron: true, source: "m365", account: "work" })).toEqual({
    kind: "cron",
    account: "work",
  });
});

test("--cron --source gmail names Story 5.4 and never fetches (CLI_PROVIDER)", () => {
  const command = resolveCliCommand({ cron: true, source: "gmail" });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("Story 5.4");
});

test("--cron --source all is rejected with the Story 5.4 line", () => {
  const command = resolveCliCommand({ cron: true, source: "all" });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("Story 5.4");
});

test("--cron --source outlook is rejected as an unknown source", () => {
  const command = resolveCliCommand({ cron: true, source: "outlook" });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain('Unknown --source "outlook"');
});

test("--cron --backfill is rejected, never silently ignored", () => {
  const command = resolveCliCommand({ cron: true, backfill: true });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("--backfill and --cron");
});

test("--cron --auth is rejected, never silently ignored", () => {
  const command = resolveCliCommand({ cron: true, auth: "m365", account: "work" });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("--cron and --auth");
});

test("--cron --sync-categories is rejected", () => {
  const command = resolveCliCommand({ cron: true, syncCategories: true });

  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("--cron and --sync-categories");
});
