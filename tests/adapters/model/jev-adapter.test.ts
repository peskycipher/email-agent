import { afterEach, expect, test } from "vitest";
import { JevAdapter } from "../../../src/adapters/model/JevAdapter.js";
import type {
  JevClient,
  JevClientOptions,
  JevSystemOneRequest,
} from "../../../src/adapters/model/JevAdapter.js";
import type { LabelDef } from "../../../src/core/dto/LabelDef.js";
import type { ModelConfig } from "../../../src/core/dto/ModelConfig.js";
import type { Taxonomy } from "../../../src/core/dto/Taxonomy.js";
import type { LogContext, LogPort } from "../../../src/core/ports/LogPort.js";
import type { PromptParts } from "../../../src/core/skill/prompt.js";

const KEY_ENV = "EMAIL_CLASSIFY_TEST_JEV_KEY";

/** A frozen-taxonomy label; the adapter reads `name` and `description` (decision 3). */
function label(name: string, description: string): LabelDef {
  return { name, description, m365Color: "preset0", gmailColor: "#000000" };
}

const TAXONOMY: Taxonomy = [
  label("Invoices", "A bill or receipt that needs paying or filing."),
  label("Action Needed", "The sender expects a reply or a task from the reader."),
];

const PROMPT: PromptParts = {
  system: "You classify an email against a fixed label taxonomy.",
  user: "Subject: Quarterly invoice\n\nBody: Please find the invoice attached.",
};

const CONFIG: ModelConfig = {
  provider: "jev",
  model: "jev-latest",
  apiKeyEnvVar: KEY_ENV,
  temperature: 0.1,
  maxTokens: 500,
};

interface JevClientOptionsRecord {
  options: JevClientOptions;
}

/**
 * A stdlib-only stub client (per-adapter tests never import a real SDK): replays
 * named `noul` probabilities without ordering assumptions and records every request.
 */
function stubJevClient(
  answers: Record<string, number>,
  usage = { input_tokens: 42, output_tokens: 7 },
): JevClient & { requests: JevSystemOneRequest[] } {
  const requests: JevSystemOneRequest[] = [];
  return {
    requests,
    async systemOne(request) {
      requests.push(request);
      return {
        model: "jev-latest",
        answers: Object.fromEntries(
          Object.entries(answers).map(([name, noul]) => [name, { type: "noul", noul }]),
        ),
        usage,
      };
    },
  };
}

interface LogEntry {
  level: string;
  message: string;
  context: LogContext | undefined;
}

/** A stdlib-only recording `LogPort` — no logger adapter. */
function recordingLogPort(): { logPort: LogPort; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record = (level: string) => (message: string, context?: LogContext) => {
    entries.push({ level, message, context });
  };
  return {
    entries,
    logPort: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
  };
}

function makeAdapter(client: JevClient, logPort: LogPort, clientOptions?: JevClientOptionsRecord[]): JevAdapter {
  return new JevAdapter({
    log: logPort,
    createJevClient(options) {
      clientOptions?.push({ options });
      return client;
    },
  });
}

function infoEntries(entries: LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.level === "info");
}

function debugEntries(entries: LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.level === "debug");
}

afterEach(() => {
  delete process.env[KEY_ENV];
});

test("JEV HAPPY: one systemOne request, thresholded labels, one info usage log, one debug distribution log", async () => {
  const client = stubJevClient({ Invoices: 0.98, "Action Needed": 0.01 });
  const { logPort, entries } = recordingLogPort();
  const adapter = makeAdapter(client, logPort);

  process.env[KEY_ENV] = "key";
  const reply = await adapter.complete(PROMPT, TAXONOMY, CONFIG);

  expect(reply).toEqual({ labels: ["Invoices"] });
  // Exactly one client construction and one transport call.
  expect(client.requests).toHaveLength(1);
  expect(infoEntries(entries)).toHaveLength(1);
  const [usageEntry] = infoEntries(entries);
  expect(usageEntry.context).toMatchObject({
    provider: "jev",
    model: "jev-latest",
    inputTokens: 42,
    outputTokens: 7,
  });
  expect(debugEntries(entries)).toHaveLength(1);
});

test("JEV HAPPY request shape: joined state, both noul questions with descriptions, config model", async () => {
  const client = stubJevClient({ Invoices: 0.98, "Action Needed": 0.01 });
  const { logPort } = recordingLogPort();
  const adapter = makeAdapter(client, logPort);

  process.env[KEY_ENV] = "key";
  await adapter.complete(PROMPT, TAXONOMY, CONFIG);

  expect(client.requests).toHaveLength(1);
  const [request] = client.requests;
  // One joined `state` string: system half then user half (decision 1).
  expect(request.state).toBe(`${PROMPT.system}\n\n${PROMPT.user}`);
  expect(request.model).toBe("jev-latest");
  expect(Object.keys(request.questions).sort()).toEqual(["Action Needed", "Invoices"]);
  expect(request.questions.Invoices).toEqual({
    type: "noul",
    instructions: 'Does this email match the label "Invoices"?',
    criteria: { true: "A bill or receipt that needs paying or filing." },
  });
  expect(request.questions["Action Needed"]).toEqual({
    type: "noul",
    instructions: 'Does this email match the label "Action Needed"?',
    criteria: { true: "The sender expects a reply or a task from the reader." },
  });
  // `temperature`/`maxTokens` are not sent to Jev — the API rejects unknown fields.
  expect(request).not.toHaveProperty("temperature");
  expect(request).not.toHaveProperty("max_tokens");
  expect(request).not.toHaveProperty("maxTokens");
});

test("JEV ALL-BELOW-THRESHOLD: empty label set resolves, no error/warn log, distribution at debug", async () => {
  const client = stubJevClient({ Invoices: 0.6, "Action Needed": 0.01 });
  const { logPort, entries } = recordingLogPort();
  const adapter = makeAdapter(client, logPort);

  process.env[KEY_ENV] = "key";
  const config: ModelConfig = { ...CONFIG, labelThreshold: 0.7 };
  const reply = await adapter.complete(PROMPT, TAXONOMY, config);

  expect(reply).toEqual({ labels: [] });
  expect(entries.filter((entry) => entry.level === "error")).toEqual([]);
  expect(entries.filter((entry) => entry.level === "warn")).toEqual([]);
  expect(debugEntries(entries)).toHaveLength(1);
  expect(debugEntries(entries)[0].context?.labelProbs).toEqual({ Invoices: 0.6, "Action Needed": 0.01 });
});

test("JEV THRESHOLD BOUNDARY: a probability exactly at the threshold joins the set (>= semantics)", async () => {
  const client = stubJevClient({ Invoices: 0.5, "Action Needed": 0.01 });
  const { logPort, entries } = recordingLogPort();
  const adapter = makeAdapter(client, logPort);

  process.env[KEY_ENV] = "key";
  const reply = await adapter.complete(PROMPT, TAXONOMY, CONFIG);

  expect(reply).toEqual({ labels: ["Invoices"] });
  expect(debugEntries(entries)[0].context?.labelProbs).toEqual({ Invoices: 0.5, "Action Needed": 0.01 });
});

test("UNTRUSTED ANSWERS: an omitted or non-numeric noul is null in labelProbs and never joins the set", async () => {
  const requests: JevSystemOneRequest[] = [];
  const client: JevClient = {
    async systemOne(request) {
      requests.push(request);
      return {
        model: "jev-latest",
        // "Action Needed" is omitted entirely; "Invoices" carries a string noul.
        answers: { Invoices: { type: "noul", noul: "0.98" } },
        usage: { input_tokens: 42, output_tokens: 7 },
      };
    },
  };
  const { logPort, entries } = recordingLogPort();
  const adapter = makeAdapter(client, logPort);

  process.env[KEY_ENV] = "key";
  const reply = await adapter.complete(PROMPT, TAXONOMY, CONFIG);

  expect(reply).toEqual({ labels: [] });
  expect(requests).toHaveLength(1);
  expect(debugEntries(entries)[0].context?.labelProbs).toEqual({
    Invoices: null,
    "Action Needed": null,
  });
  // The degraded reply still usage-logs exactly once.
  expect(infoEntries(entries)).toHaveLength(1);
});

test("UNTRUSTED ANSWERS: a non-object answers member degrades to nulls, not a TypeError", async () => {
  const client: JevClient = {
    async systemOne() {
      return {
        model: "jev-latest",
        answers: undefined as unknown as Readonly<Record<string, unknown>>,
        usage: undefined as unknown as Readonly<{ input_tokens: number; output_tokens: number }>,
      };
    },
  };
  const { logPort, entries } = recordingLogPort();
  const adapter = makeAdapter(client, logPort);

  process.env[KEY_ENV] = "key";
  const reply = await adapter.complete(PROMPT, TAXONOMY, CONFIG);

  expect(reply).toEqual({ labels: [] });
  expect(debugEntries(entries)[0].context?.labelProbs).toEqual({ Invoices: null, "Action Needed": null });
  expect(infoEntries(entries)[0].context).toMatchObject({
    provider: "jev",
    inputTokens: 0,
    outputTokens: 0,
  });
});

test("MISSING KEY at call time: typed MISSING_API_KEY thrown before any client construction", async () => {
  const clientOptions: JevClientOptionsRecord[] = [];
  const client = stubJevClient({ Invoices: 0.98 });
  const { logPort } = recordingLogPort();
  const adapter = new JevAdapter({
    log: logPort,
    createJevClient(options) {
      clientOptions.push({ options });
      return client;
    },
  });

  // The env var is unset: the wiring-time check would have failed earlier, but the
  // call-time re-check (decision 5) must still throw before any transport call.
  delete process.env[KEY_ENV];
  await expect(adapter.complete(PROMPT, TAXONOMY, CONFIG)).rejects.toMatchObject({
    name: "ModelAdapterError",
    code: "MISSING_API_KEY",
  });
  expect(clientOptions).toEqual([]);
});

test("EXTRAPARAMS route to the client constructor with the validated env key re-applied", async () => {
  const client = stubJevClient({ Invoices: 0.98, "Action Needed": 0.01 });
  const { logPort } = recordingLogPort();
  const clientOptions: JevClientOptionsRecord[] = [];
  const adapter = makeAdapter(client, logPort, clientOptions);

  process.env[KEY_ENV] = "env-key";
  const config: ModelConfig = {
    ...CONFIG,
    extraParams: { baseURL: "https://proxy.example.com", timeout: 2500 },
  };
  await adapter.complete(PROMPT, TAXONOMY, config);

  expect(clientOptions).toHaveLength(1);
  expect(clientOptions[0].options).toEqual({
    baseURL: "https://proxy.example.com",
    timeout: 2500,
    apiKey: "env-key",
  });
});
