import { expect, test } from "vitest";
import {
  OpenAIAdapter,
  buildLabelSetResponseSchema,
} from "../../../src/adapters/model/OpenAIAdapter.js";
import type {
  OpenAIChatClient,
  OpenAIChatCompletion,
  OpenAIChatParams,
  OpenAIClientOptions,
} from "../../../src/adapters/model/OpenAIAdapter.js";
import type { LabelDef } from "../../../src/core/dto/LabelDef.js";
import type { ModelConfig } from "../../../src/core/dto/ModelConfig.js";
import type { Taxonomy } from "../../../src/core/dto/Taxonomy.js";
import type { LogContext, LogPort } from "../../../src/core/ports/LogPort.js";
import type { PromptParts } from "../../../src/core/skill/prompt.js";

const KEY_ENV = "EMAIL_CLASSIFY_TEST_OPENAI_KEY";

/** A frozen-taxonomy label; the adapter reads `name` only (for the schema enum). */
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
  provider: "openai",
  model: "gpt-4o-mini",
  apiKeyEnvVar: KEY_ENV,
  temperature: 0.1,
  maxTokens: 500,
};

interface OpenAICallRecord {
  params: OpenAIChatParams;
  options: OpenAIClientOptions;
}

/** A stdlib-only stub chat client: returns the scripted completion and records the params. */
function stubOpenAIClient(completion: OpenAIChatCompletion): OpenAIChatClient & { calls: OpenAICallRecord[] } {
  const calls: OpenAICallRecord[] = [];
  return {
    calls,
    chat: {
      completions: {
        async create(params) {
          calls.push({ params });
          return completion;
        },
      },
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

function makeAdapter(client: OpenAIChatClient, logPort: LogPort, clientOptions?: OpenAICallRecord[]): OpenAIAdapter {
  return new OpenAIAdapter({
    log: logPort,
    createOpenAIClient(options) {
      clientOptions?.push({ options });
      return client;
    },
  });
}

const HAPPY_COMPLETION: OpenAIChatCompletion = {
  choices: [{ message: { content: '{"labels":["Invoices"]}' } }],
  usage: { prompt_tokens: 42, completion_tokens: 7 },
};

test("SCHEMA: the internal strict schema covers the taxonomy's names", () => {
  const schema = buildLabelSetResponseSchema(TAXONOMY) as {
    properties: { labels: { items: { enum: string[] } } };
  };

  expect(schema.properties.labels.items.enum).toEqual(["Invoices", "Action Needed"]);
});

test("OPENAI HAPPY: messages from PromptParts, strict schema, temperature/max_tokens, parsed reply out, usage info log", async () => {
  const client = stubOpenAIClient(HAPPY_COMPLETION);
  const { logPort, entries } = recordingLogPort();
  const adapter = makeAdapter(client, logPort);

  process.env[KEY_ENV] = "key";
  const reply = await adapter.complete(PROMPT, TAXONOMY, CONFIG);

  expect(reply).toEqual({ labels: ["Invoices"] });
  expect(client.calls).toHaveLength(1);
  const [call] = client.calls;
  expect(call.params.model).toBe("gpt-4o-mini");
  expect(call.params.messages).toEqual([
    { role: "system", content: PROMPT.system },
    { role: "user", content: PROMPT.user },
  ]);
  expect(call.params.temperature).toBe(0.1);
  expect(call.params.max_tokens).toBe(500);
  expect(call.params.response_format.type).toBe("json_schema");
  expect(call.params.response_format.json_schema.strict).toBe(true);
  const schema = call.params.response_format.json_schema.schema as {
    properties: { labels: { items: { enum: string[] } } };
  };
  expect(schema.properties.labels.items.enum).toEqual(["Invoices", "Action Needed"]);

  const info = entries.filter((entry) => entry.level === "info");
  expect(info).toHaveLength(1);
  expect(info[0].context).toMatchObject({
    provider: "openai",
    model: "gpt-4o-mini",
    inputTokens: 42,
    outputTokens: 7,
  });
});

test("OPENAI MISSING KEY at call time: typed MISSING_API_KEY thrown before any transport call", async () => {
  const client = stubOpenAIClient(HAPPY_COMPLETION);
  const { logPort } = recordingLogPort();
  const adapter = makeAdapter(client, logPort);

  delete process.env[KEY_ENV];
  await expect(adapter.complete(PROMPT, TAXONOMY, CONFIG)).rejects.toMatchObject({
    name: "ModelAdapterError",
    code: "MISSING_API_KEY",
  });
  expect(client.calls).toEqual([]);
});

test("EXTRAPARAMS: extraParams.baseURL reaches the client constructor (custom providers)", async () => {
  const client = stubOpenAIClient(HAPPY_COMPLETION);
  const { logPort } = recordingLogPort();
  const clientOptions: OpenAICallRecord[] = [];
  const adapter = makeAdapter(client, logPort, clientOptions);

  process.env[KEY_ENV] = "env-key";
  const config: ModelConfig = {
    ...CONFIG,
    provider: "custom",
    extraParams: { baseURL: "https://self-hosted.example.com/v1" },
  };
  await adapter.complete(PROMPT, TAXONOMY, config);

  expect(clientOptions).toHaveLength(1);
  expect(clientOptions[0].options).toEqual({
    baseURL: "https://self-hosted.example.com/v1",
    apiKey: "env-key",
  });
});

test("TRANSPORT FAILURE: a rejecting client propagates unwrapped", async () => {
  const providerError = new Error("429 from the provider");
  const failing: OpenAIChatClient = {
    chat: {
      completions: {
        async create() {
          throw providerError;
        },
      },
    },
  };
  const { logPort } = recordingLogPort();
  const adapter = makeAdapter(failing, logPort);

  process.env[KEY_ENV] = "key";
  // PRD FR-1: no retries here, no wrapping — the orchestrator retries and re-queues.
  await expect(adapter.complete(PROMPT, TAXONOMY, CONFIG)).rejects.toBe(providerError);
});