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
  expect(resolveCliCommand({ cron: true })).toEqual({
    kind: "cron",
    source: "m365",
    account: "all",
    intervalMinutes: 15,
  });
});

test("--cron --source m365 --account work targets that one account", () => {
  expect(resolveCliCommand({ cron: true, source: "m365", account: "work" })).toEqual({
    kind: "cron",
    source: "m365",
    account: "work",
    intervalMinutes: 15,
  });
});

test("--cron --source gmail selects the Gmail path, defaulting --account to all (CLI_SOURCE)", () => {
  expect(resolveCliCommand({ cron: true, source: "gmail" })).toEqual({
    kind: "cron",
    source: "gmail",
    account: "all",
    intervalMinutes: 15,
  });
});

test("--cron --source gmail --account personal targets that one account", () => {
  expect(resolveCliCommand({ cron: true, source: "gmail", account: "personal" })).toEqual({
    kind: "cron",
    source: "gmail",
    account: "personal",
    intervalMinutes: 15,
  });
});

test("--cron --source all runs both providers in the one loop (SOURCE_ALL)", () => {
  expect(resolveCliCommand({ cron: true, source: "all" })).toEqual({
    kind: "cron",
    source: "all",
    account: "all",
    intervalMinutes: 15,
  });
});

test("--interval defaults --cron to 15 minutes and parses a whole number in bounds (INTERVAL)", () => {
  const command = resolveCliCommand({ cron: true, source: "m365", interval: "1" });
  expect(command.kind === "cron" ? command.intervalMinutes : undefined).toBe(1);
  const max = resolveCliCommand({ cron: true, source: "gmail", interval: "1440" });
  expect(max.kind === "cron" ? max.intervalMinutes : undefined).toBe(1440);
});

test("--interval 0, 1441 and abc are rejected with one line naming the flag and its bounds (INTERVAL_BOUNDS)", () => {
  for (const raw of ["0", "1441", "abc"]) {
    const command = resolveCliCommand({ cron: true, source: "m365", interval: raw });
    expect(command.kind).toBe("error");
    expect(command.kind === "error" ? command.message : "").toContain(`--interval "${raw}"`);
    expect(command.kind === "error" ? command.message : "").toContain("between 1 and 1440");
  }
});

test("--interval without --cron is rejected, never silently ignored", () => {
  const command = resolveCliCommand({ interval: "15" });
  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("--interval requires --cron");
  const onBackfill = resolveCliCommand({ backfill: true, interval: "15" });
  expect(onBackfill.kind).toBe("error");
  expect(onBackfill.kind === "error" ? onBackfill.message : "").toContain("--interval requires --cron");
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

test("--since parses a date and --batch-size drives the plan", () => {
  const since = new Date("2026-01-01");
  const command = resolveCliCommand({ backfill: true, since: "2026-01-01", batchSize: "100" });
  expect(command.kind).toBe("backfill");
  expect(command.kind === "backfill" ? command.since : undefined).toEqual(since);
  expect(command.kind === "backfill" ? command.batchSize : undefined).toBe(100);
});

test("--since rejects a non-ISO value", () => {
  const command = resolveCliCommand({ backfill: true, since: "garbage" });
  expect(command.kind).toBe("error");
  const nonIso = resolveCliCommand({ backfill: true, since: "Feb 1 2026" });
  expect(nonIso.kind).toBe("error");
});

test("--since rejects a nonexistent calendar date", () => {
  const command = resolveCliCommand({ backfill: true, since: "2026-02-30" });
  expect(command.kind).toBe("error");
});

test("--batch-size rejects a non-integer and non-positive value", () => {
  const command = resolveCliCommand({ backfill: true, batchSize: "abc" });
  expect(command.kind).toBe("error");
  const commandZero = resolveCliCommand({ backfill: true, batchSize: "0" });
  expect(commandZero.kind).toBe("error");
});

test("--since and --batch-size require --backfill", () => {
  const command = resolveCliCommand({ cron: true, since: "2026-01-01", batchSize: "50" });
  expect(command.kind).toBe("error");
  expect(command.kind === "error" ? command.message : "").toContain("--since/--batch-size require --backfill");
});
