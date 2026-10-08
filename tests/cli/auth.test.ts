import { expect, test } from "vitest";
import { authenticateAccounts, type AccountAuthOutcome } from "../../src/cli/commands/auth.js";

test("a failing account does not abort a multi-account run (I/O matrix row 8)", async () => {
  const attempted: string[] = [];
  const adapter = {
    async authenticate(account: string) {
      attempted.push(account);
      if (account === "b") throw new Error("token store unavailable");
      return { scopes: ["Mail.ReadWrite", "MailboxSettings.ReadWrite"] };
    },
  };
  const outcomes: AccountAuthOutcome[] = [];

  const failures = await authenticateAccounts(adapter, ["a", "b", "c"], (outcome) => outcomes.push(outcome));

  expect(attempted).toEqual(["a", "b", "c"]);
  expect(failures).toBe(1);
  expect(outcomes).toHaveLength(3);
  expect(outcomes.map((outcome) => [outcome.account, outcome.ok])).toEqual([
    ["a", true],
    ["b", false],
    ["c", true],
  ]);
  expect(outcomes[1]?.line).toContain("FAILED");
});
