import { afterEach, expect, test } from "vitest";
import {
  createModelAdapter,
  DEFAULT_MODEL_CONFIG,
  ModelAdapterError,
  resolveEnvApiKey,
} from "../../../src/adapters/model/modelAdapterFactory.js";
import type { ModelAdapterDeps } from "../../../src/adapters/model/modelAdapterFactory.js";
import type { LabelDef } from "../../../src/core/dto/LabelDef.js";
import type { ModelConfig } from "../../../src/core/dto/ModelConfig.js";
import type { Taxonomy } from "../../../src/core/dto/Taxonomy.js";
import type { LogContext, LogPort } from "../../../src/core/ports/LogPort.js";
import type { PromptParts } from "../../../src/core/skill/prompt.js";
import { JevAdapter } from "../../../src/adapters/model/JevAdapter.js";
import { OpenAIAdapter } from "../../../src/adapters/model/OpenAIAdapter.js";

const JEV_KEY_ENV = "EMAIL_CLASSIFY_TEST_FACTORY_JEV_KEY";
const OPENAI_KEY_ENV = "EMAIL_CLASSIFY_TEST_FACTORY_OPENAI_KEY";

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

const CONFIG: ModelConfig = { ...DEFAULT_MODEL_CONFIG, apiKeyEnvVar: JEV_KEY_ENV };

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

/** Stub client factories that record construction and never import a real SDK. */
function stubDeps(): {
  deps: ModelAdapterDeps;
  observed: { jevConstructions: number; openAIConstructions: Array<Record<string, unknown>> };
} {
  const { logPort } = recordingLogPort();
  const observed: { jevConstructions: number; openAIConstructions: Array<Record<string, unknown>> } = {
    jevConstructions: 0,
    openAIConstructions: [],
  };
  const client = {
    chat: {
      completions: {
        async create() {
          return { choices: [{ message: { content: '{"labels":[]}' } }] };
        },
      },
    },
  };
  const deps: ModelAdapterDeps = {
    log: logPort,
    createJevClient() {
      observed.jevConstructions += 1;
      return {
        async systemOne() {
          return {
            model: "jev-latest",
            answers: { Invoices: { type: "noul", noul: 0.98 }, "Action Needed": { type: "noul", noul: 0.01 } },
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    },
    createOpenAIClient(options) {
      observed.openAIConstructions.push(options);
      return client;
    },
  };
  return { deps, observed };
}

afterEach(() => {
  delete process.env[JEV_KEY_ENV];
  delete process.env[OPENAI_KEY_ENV];
});

test("DEFAULT_MODEL_CONFIG carries the ratified Story 6.3 defaults", () => {
  expect(DEFAULT_MODEL_CONFIG).toEqual({
    provider: "jev",
    // `system1` is a model-class name the live API rejects; only this id exists.
    model: "jev-latest",
    apiKeyEnvVar: "TYPESAFE_API_KEY",
    temperature: 0.1,
    maxTokens: 500,
  });
});

test("PROVIDER ROUTING: provider jev returns the JevAdapter", () => {
  process.env[JEV_KEY_ENV] = "key";
  const { deps } = stubDeps();
  const adapter = createModelAdapter(CONFIG, deps);
  expect(adapter).toBeInstanceOf(JevAdapter);
});

test("PROVIDER ROUTING: provider openai returns the OpenAIAdapter", () => {
  process.env[OPENAI_KEY_ENV] = "key";
  const { deps } = stubDeps();
  const adapter = createModelAdapter(
    { ...DEFAULT_MODEL_CONFIG, provider: "openai", apiKeyEnvVar: OPENAI_KEY_ENV },
    deps,
  );
  expect(adapter).toBeInstanceOf(OpenAIAdapter);
});

test("PROVIDER ROUTING: provider custom selects the OpenAI adapter and passes extraParams as client options", async () => {
  const { deps, observed } = stubDeps();
  process.env[OPENAI_KEY_ENV] = "key";
  const config: ModelConfig = {
    ...DEFAULT_MODEL_CONFIG,
    provider: "custom",
    apiKeyEnvVar: OPENAI_KEY_ENV,
    extraParams: { baseURL: "https://self-hosted.example.com/v1" },
  };

  const adapter = createModelAdapter(config, deps);

  expect(adapter).toBeInstanceOf(OpenAIAdapter);
  expect(observed.jevConstructions).toBe(0);
  await adapter.complete(PROMPT, TAXONOMY, config);
  expect(observed.openAIConstructions[0]).toEqual({
    baseURL: "https://self-hosted.example.com/v1",
    apiKey: "key",
  });
});

test("UNSUPPORTED PROVIDER: provider anthropic throws at wiring time, naming the remedy, before any client is built", () => {
  const { deps, observed } = stubDeps();
  process.env[JEV_KEY_ENV] = "key";

  const attempt = () =>
    createModelAdapter({ ...CONFIG, provider: "anthropic" }, deps);

  expect(attempt).toThrow(ModelAdapterError);
  expect(attempt).toThrow(/provider "anthropic" has no adapter/);
  // The remedy line names the OpenAI-compatible path.
  expect(attempt).toThrow(/provider: "custom" with extraParams\.baseURL/);
  expect(observed.jevConstructions).toBe(0);
  expect(observed.openAIConstructions).toEqual([]);
});

test("MISSING KEY: an unset apiKeyEnvVar throws MISSING_API_KEY at wiring time", () => {
  const { deps } = stubDeps();
  delete process.env[JEV_KEY_ENV];
  const attempt = () => createModelAdapter(CONFIG, deps);

  expect(attempt).toThrow(ModelAdapterError);
  expect(attempt).toThrow(/EMAIL_CLASSIFY_TEST_FACTORY_JEV_KEY/);
});

test("CALL-TIME RE-CHECK: an env var set at construction and removed before the call still errors per call", async () => {
  const { deps, observed } = stubDeps();
  process.env[JEV_KEY_ENV] = "key";
  const adapter = createModelAdapter(CONFIG, deps);

  // The same config still resolves while the var is set.
  await adapter.complete(PROMPT, TAXONOMY, CONFIG);
  expect(observed.jevConstructions).toBe(1);

  delete process.env[JEV_KEY_ENV];
  await expect(adapter.complete(PROMPT, TAXONOMY, CONFIG)).rejects.toMatchObject({
    name: "ModelAdapterError",
    code: "MISSING_API_KEY",
  });
  // No transport call — the per-call client is never constructed for the faulted attempt.
  expect(observed.jevConstructions).toBe(1);
});

test("RUNTIME GUARD: a provider outside the ratified union throws UNSUPPORTED_PROVIDER, not a mis-routing", () => {
  const { deps, observed } = stubDeps();
  process.env[JEV_KEY_ENV] = "key";
  // Simulates an unvalidated (e.g. YAML-parsed) provider value.
  const config = { ...CONFIG, provider: "gemini" } as unknown as ModelConfig;

  const attempt = () => createModelAdapter(config, deps);

  expect(attempt).toThrow(ModelAdapterError);
  expect(attempt).toThrow(/UNSUPPORTED_PROVIDER|not one of/);
  expect(observed.jevConstructions).toBe(0);
  expect(observed.openAIConstructions).toEqual([]);
});

test("resolveEnvApiKey treats unset and whitespace-only values as unresolvable", () => {
  const config = { apiKeyEnvVar: JEV_KEY_ENV } as ModelConfig;
  delete process.env[JEV_KEY_ENV];
  expect(resolveEnvApiKey(config)).toBeUndefined();
  process.env[JEV_KEY_ENV] = "   ";
  expect(resolveEnvApiKey(config)).toBeUndefined();
  process.env[JEV_KEY_ENV] = "secret";
  expect(resolveEnvApiKey(config)).toBe("secret");
});