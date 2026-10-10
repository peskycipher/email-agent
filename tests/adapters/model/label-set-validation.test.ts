import { expect, test } from "vitest";
import {
  completeWithRetry,
  labelSetSchema,
  validateLabelSet,
} from "../../../src/adapters/index.js";
import type { LabelDef } from "../../../src/core/dto/LabelDef.js";
import type { ModelConfig } from "../../../src/core/dto/ModelConfig.js";
import type { LogContext, LogPort } from "../../../src/core/ports/LogPort.js";
import type { ModelPort } from "../../../src/core/ports/ModelPort.js";
import type { PromptParts } from "../../../src/core/skill/prompt.js";

/** A frozen-taxonomy label; membership is checked against `name` only. */
function label(name: string, description: string): LabelDef {
  return { name, description, m365Color: "preset0", gmailColor: "#000000" };
}

const TAXONOMY: LabelDef[] = [
  label("Invoices", "A bill or receipt that needs paying or filing."),
  label("Action Needed", "The sender expects a reply or a task from the reader."),
];

const CONFIG: ModelConfig = {
  provider: "jev",
  model: "jev-latest",
  apiKeyEnvVar: "TYPESAFE_API_KEY",
  temperature: 0.1,
  maxTokens: 500,
};

const PROMPT: PromptParts = {
  system: "You classify an email against a fixed label taxonomy.",
  user: "Subject: Quarterly invoice\n\nBody: Please find the invoice attached.",
};

const CONTEXT: LogContext = { accountId: "personal", internetMessageId: "<msg-1@example.com>" };

interface ModelCall {
  prompt: PromptParts;
  taxonomy: LabelDef[];
  config: ModelConfig;
}

/**
 * A stub `ModelPort` — no real SDK — that replays `responses` in order and records each
 * call. The last response repeats, so a permanently invalid reply exhausts the budget.
 */
function scriptedModel(responses: unknown[]): { model: ModelPort; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const model: ModelPort = {
    async complete(prompt, taxonomy, config) {
      calls.push({ prompt, taxonomy, config });
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  };
  return { model, calls };
}

interface LogEntry {
  level: string;
  message: string;
  context: LogContext | undefined;
}

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

test("HAPPY accepts a reply whose labels are all in the active taxonomy", () => {
  const verdict = validateLabelSet({ labels: ["Invoices"] }, TAXONOMY);

  expect(verdict.ok).toBe(true);
  expect(verdict.labels).toEqual(["Invoices"]);
  expect(verdict.reason).toBeUndefined();
  // The exported schema is the same strict contract.
  expect(labelSetSchema(TAXONOMY).safeParse({ labels: ["Action Needed"] }).success).toBe(true);
});

test("EMPTY VALID accepts an empty label array", () => {
  const verdict = validateLabelSet({ labels: [] }, TAXONOMY);

  expect(verdict.ok).toBe(true);
  expect(verdict.labels).toEqual([]);
});

test("MALFORMED rejects every non-{labels: string[]} reply with a reason", () => {
  const malformed: unknown[] = [
    "Invoices",
    null,
    {},
    { labels: "Invoices" },
    { labels: ["Invoices", 1] },
    { labels: ["Invoices"], extra: true },
  ];

  for (const raw of malformed) {
    const verdict = validateLabelSet(raw, TAXONOMY);
    expect(verdict.ok, JSON.stringify(raw)).toBe(false);
    expect(verdict.labels, JSON.stringify(raw)).toEqual([]);
    expect(typeof verdict.reason, JSON.stringify(raw)).toBe("string");
    expect(verdict.reason, JSON.stringify(raw)).not.toBe("");
  }
});

test("LABEL NOT IN TAXONOMY rejects a name the active taxonomy does not contain", () => {
  const verdict = validateLabelSet({ labels: ["Nope"] }, TAXONOMY);

  expect(verdict.ok).toBe(false);
  expect(verdict.labels).toEqual([]);
  expect(verdict.reason).toMatch(/not in the active taxonomy/);
});

test("DUPLICATE LABELS rejects repeated names in the label set", () => {
  const verdict = validateLabelSet({ labels: ["Invoices", "Invoices"] }, TAXONOMY);

  expect(verdict.ok).toBe(false);
  expect(verdict.labels).toEqual([]);
  expect(verdict.reason).toMatch(/duplicate/);
});

test("DETERMINISM yields the same verdict twice and mutates neither argument", () => {
  const raw = { labels: ["Invoices", "Nope"] };
  const taxonomy = TAXONOMY.map((entry) => ({ ...entry }));
  const rawSnapshot = structuredClone(raw);
  const taxonomySnapshot = structuredClone(taxonomy);

  const first = validateLabelSet(raw, taxonomy);
  const second = validateLabelSet(raw, taxonomy);

  expect(second).toEqual(first);
  expect(raw).toEqual(rawSnapshot);
  expect(taxonomy).toEqual(taxonomySnapshot);
});

test("HAPPY is accepted on the first call and is never retried", async () => {
  const { model, calls } = scriptedModel([{ labels: ["Invoices"] }]);
  const log = recordingLogPort();

  const labels = await completeWithRetry({
    model,
    prompt: PROMPT,
    config: CONFIG,
    taxonomy: TAXONOMY,
    log: log.logPort,
    context: CONTEXT,
  });

  expect(labels).toEqual({ labels: ["Invoices"] });
  expect(calls).toHaveLength(1);
  expect(log.entries).toEqual([]);
});

test("EMPTY VALID is accepted with no retry and no error log", async () => {
  const { model, calls } = scriptedModel([{ labels: [] }]);
  const log = recordingLogPort();

  const labels = await completeWithRetry({
    model,
    prompt: PROMPT,
    config: CONFIG,
    taxonomy: TAXONOMY,
    log: log.logPort,
  });

  expect(labels).toEqual({ labels: [] });
  expect(calls).toHaveLength(1);
  expect(log.entries).toEqual([]);
});

test("MALFORMED is retried to the budget and falls back to an empty set with one error log", async () => {
  const { model, calls } = scriptedModel([{ labels: "Invoices" }]);
  const log = recordingLogPort();

  const labels = await completeWithRetry({
    model,
    prompt: PROMPT,
    config: CONFIG,
    taxonomy: TAXONOMY,
    log: log.logPort,
    context: CONTEXT,
  });

  // Initial call plus at most two retries.
  expect(calls).toHaveLength(3);
  expect(labels).toEqual({ labels: [] });
  expect(log.entries).toHaveLength(1);
  const [entry] = log.entries;
  expect(entry.level).toBe("error");
  expect(entry.context?.raw).toEqual({ labels: "Invoices" });
  expect(typeof entry.context?.reason).toBe("string");
  expect(entry.context?.reason).not.toBe("");
  // The per-message log context survives the exhaustion path.
  expect(entry.context?.accountId).toBe("personal");
  expect(entry.context?.internetMessageId).toBe("<msg-1@example.com>");
});

test("LABEL NOT IN TAXONOMY is retried and falls back with the rejection reason logged", async () => {
  const { model, calls } = scriptedModel([{ labels: ["Nope"] }]);
  const log = recordingLogPort();

  const labels = await completeWithRetry({
    model,
    prompt: PROMPT,
    config: CONFIG,
    taxonomy: TAXONOMY,
    log: log.logPort,
  });

  expect(calls).toHaveLength(3);
  expect(labels).toEqual({ labels: [] });
  expect(log.entries).toHaveLength(1);
  expect(log.entries[0].context?.reason).toMatch(/not in the active taxonomy/);
});

test("LATE RECOVERY accepts a valid second attempt and logs nothing", async () => {
  const { model, calls } = scriptedModel([{ labels: ["Nope"] }, { labels: ["Action Needed"] }]);
  const log = recordingLogPort();

  const labels = await completeWithRetry({
    model,
    prompt: PROMPT,
    config: CONFIG,
    taxonomy: TAXONOMY,
    log: log.logPort,
  });

  expect(labels).toEqual({ labels: ["Action Needed"] });
  expect(calls).toHaveLength(2);
  expect(log.entries).toEqual([]);
});

test("LATE RECOVERY accepts a valid reply on the third and final attempt", async () => {
  const { model, calls } = scriptedModel([
    { labels: ["Nope"] },
    { labels: "bad" },
    { labels: ["Action Needed"] },
  ]);
  const log = recordingLogPort();

  const labels = await completeWithRetry({
    model,
    prompt: PROMPT,
    config: CONFIG,
    taxonomy: TAXONOMY,
    log: log.logPort,
  });

  expect(labels).toEqual({ labels: ["Action Needed"] });
  expect(calls).toHaveLength(3);
  expect(log.entries).toEqual([]);
});

test("PROVIDER ERROR re-throws to the caller instead of returning an empty set", async () => {
  const providerError = new Error("provider refused");
  const calls: ModelCall[] = [];
  const model: ModelPort = {
    async complete(prompt, taxonomy, config) {
      calls.push({ prompt, taxonomy, config });
      throw providerError;
    },
  };
  const log = recordingLogPort();

  const attempt = async () =>
    completeWithRetry({
      model,
      prompt: PROMPT,
      config: CONFIG,
      taxonomy: TAXONOMY,
      log: log.logPort,
      context: CONTEXT,
    });

  // PRD FR-1: a Jev/API transient error must reach the orchestrator, which retries
  // with backoff and re-queues the message — no retries here, no empty-set fallback.
  await expect(attempt()).rejects.toBe(providerError);
  expect(calls).toHaveLength(1);
  expect(log.entries).toEqual([]);
});

test("every attempt carries the unchanged PromptParts and configured temperature", async () => {
  const config: ModelConfig = { ...CONFIG, temperature: 0.42 };
  const { model, calls } = scriptedModel([{ labels: "nope" }]);
  const log = recordingLogPort();

  await completeWithRetry({
    model,
    prompt: PROMPT,
    config,
    taxonomy: TAXONOMY,
    log: log.logPort,
  });

  expect(calls).toHaveLength(3);
  for (const call of calls) {
    expect(call.prompt).toBe(PROMPT);
    expect(call.taxonomy).toBe(TAXONOMY);
    expect(call.config).toBe(config);
    expect(call.config.temperature).toBe(0.42);
  }
});
