import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike, FetchResponseLike } from "../../src/adapters/m365/M365AuthAdapter.js";
import { runCron } from "../../src/cli/commands/cron.js";
import type { TokenSet } from "../../src/core/dto/TokenSet.js";
import type { TokenPort } from "../../src/core/ports/TokenPort.js";

const FOLDER_MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/mailFolders";
const STORED_ISO = "2026-10-08T08:00:00.000Z";
const STORED_ENCODED = "2026-10-08T08%3A00%3A00.000Z";
const CYCLE_START = new Date("2026-10-09T12:00:00.000Z");

interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | undefined;
}

function jsonResponse(body: unknown, ok = true, status = 200): FetchResponseLike {
  return { ok, status, json: async () => body };
}

function graphPage(ids: string[]): FetchResponseLike {
  return jsonResponse({
    value: ids.map((id) => ({
      id,
      internetMessageId: `<${id}@example.com>`,
      subject: `Subject ${id}`,
      bodyPreview: `Preview ${id}`,
      receivedDateTime: "2026-10-09T12:34:56Z",
      categories: [],
      isRead: false,
      from: { emailAddress: { address: `${id}@example.com`, name: `Sender ${id}` } },
    })),
  });
}

function recordingFetch(responses: FetchResponseLike[]): {
  fetchFn: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, authorization: init.headers["authorization"] });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetchFn, requests };
}

function cachedToken(accountId: string): TokenSet {
  return {
    accessToken: `access-m365-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 3_600_000,
    scopes: ["Mail.ReadWrite", "MailboxSettings.ReadWrite"],
  };
}

function memoryTokenStore(tokens: Record<string, TokenSet>): TokenPort {
  return {
    async get(provider, accountId) {
      const token = tokens[`${provider}:${accountId}`];
      if (token) return token;
      const error = new Error(`No stored token for account "${accountId}".`) as Error & { code: string };
      error.name = "TokenStoreError";
      error.code = "TOKEN_NOT_FOUND";
      throw error;
    },
    async set() {},
    async delete() {},
  };
}

function capturedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

async function writeAccount(name: string, extra = ""): Promise<void> {
  const body = `name: ${name}\nenabled: true\ntenantId: tenant-1\nclientId: client-1\n${extra}`;
  await writeFile(join(configDir, "accounts", "m365", `${name}.yaml`), body, "utf8");
}

function statePath(name: string): string {
  return join(configDir, "state", `${name}.json`);
}

async function writeState(name: string, state: Record<string, unknown>): Promise<void> {
  await mkdir(join(configDir, "state"), { recursive: true, mode: 0o700 });
  await writeFile(statePath(name), `${JSON.stringify(state)}\n`, "utf8");
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "cli-cron-"));
  await mkdir(join(configDir, "accounts", "m365"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
});

test("--cron fetches only messages since the stored timestamp and advances the state (HAPPY)", async () => {
  await writeAccount("work");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([graphPage(["m1", "m2"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(0);
  expect(capturedLines(stderr)).toHaveLength(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url.startsWith(`${FOLDER_MESSAGES_URL}/Inbox/messages?`)).toBe(true);
  expect(requests[0]?.url).toContain(`$filter=receivedDateTime ge ${STORED_ENCODED}`);
  expect(requests[0]?.url).toContain("$orderby=receivedDateTime asc");
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
  // The persisted timestamp is the cycle start, not the newest message.
  expect(JSON.parse(await readFile(statePath("work"), "utf8"))).toEqual({
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("Fetched 2 message(s) from 1 account(s).");
});

test("--cron without a state file sends no filter and creates the state on success (NO_STATE)", async () => {
  await writeAccount("work");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runCron(
    { account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(0);
  expect(requests[0]?.url).not.toContain("$filter");
  expect(requests[0]?.url).not.toContain("$orderby");
  expect(JSON.parse(await readFile(statePath("work"), "utf8"))).toEqual({
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
});

test("--cron --account all keeps going after an account fails and exits 1 with a counted line (ACCOUNT_FAILURE)", async () => {
  await writeAccount("alpha");
  await writeAccount("beta");
  await writeState("alpha", { lastRunTimestamp: "2026-10-07T07:00:00.000Z" });
  await writeState("beta", { lastRunTimestamp: STORED_ISO });
  const alphaBefore = await readFile(statePath("alpha"), "utf8");
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { account: "all" },
    {
      fetchFn,
      // alpha has no token, so its fetch fails before any request; beta fetches.
      tokenStore: memoryTokenStore({ "m365:beta": cachedToken("beta") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("alpha: ");
  expect(errors).toContain("1 of 2 m365 account(s) failed.");
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-beta");
  // The failed account's stored state is byte-for-byte untouched; the healthy one advanced.
  expect(await readFile(statePath("alpha"), "utf8")).toBe(alphaBefore);
  expect(JSON.parse(await readFile(statePath("beta"), "utf8"))).toEqual({
    lastRunTimestamp: CYCLE_START.toISOString(),
  });
});

test("--cron --account all with no enabled m365 account exits 1 with the setup hint (NO_ACCOUNTS)", async () => {
  const { fetchFn, requests } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron({ account: "all" }, { fetchFn, configDir });

  expect(code).toBe(1);
  expect(requests).toHaveLength(0);
  expect(capturedLines(stdout)).toHaveLength(0);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("No enabled m365 accounts found");
  expect(errors).toContain("~/.config/email-classify/accounts/m365/<name>.yaml");
  // A failed setup must not leave a state file behind.
  await expect(readFile(statePath("work"), "utf8")).rejects.toThrow();
});

test("--cron --account <name> targets that one account only", async () => {
  await writeAccount("work");
  await writeAccount("other");
  await writeState("work", { lastRunTimestamp: STORED_ISO });
  const { fetchFn, requests } = recordingFetch([graphPage(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const code = await runCron(
    { account: "work" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.authorization).toBe("Bearer access-m365-work");
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
  await expect(readFile(statePath("other"), "utf8")).rejects.toThrow();
});

test("--cron --account all counts an account with malformed settings as a failure (ACCOUNT_FAILURE)", async () => {
  await writeAccount("work");
  await writeFile(join(configDir, "accounts", "m365", "broken.yaml"), "name: [unclosed\n", "utf8");
  const { fetchFn } = recordingFetch([graphPage(["m1"])]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron(
    { account: "all" },
    {
      fetchFn,
      tokenStore: memoryTokenStore({ "m365:work": cachedToken("work") }),
      configDir,
      now: () => CYCLE_START,
    },
  );

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("m365 broken: ");
  expect(errors).toContain("1 of 2 m365 account(s) failed.");
  expect(capturedLines(stdout).join("")).toContain("Fetched 1 message(s) from 1 account(s).");
});

test("--cron --account all with only malformed settings reports invalid settings, not the setup hint", async () => {
  await writeFile(join(configDir, "accounts", "m365", "broken.yaml"), "name: [unclosed\n", "utf8");
  const { fetchFn } = recordingFetch([]);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const code = await runCron({ account: "all" }, { fetchFn, configDir });

  expect(code).toBe(1);
  const errors = capturedLines(stderr).join("");
  expect(errors).toContain("1 m365 account(s) have invalid settings");
  expect(errors).not.toContain("No enabled m365 accounts found");
  expect(capturedLines(stdout)).toHaveLength(0);
});
