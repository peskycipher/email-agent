import { expect, test } from "vitest";
import { classify } from "../../src/orch/classify.js";
import type { LabelDef } from "../../src/core/dto/LabelDef.js";
import type { MessageDTO } from "../../src/core/dto/MessageDTO.js";
import type { ModelConfig } from "../../src/core/dto/ModelConfig.js";
import type { LogContext, LogPort } from "../../src/core/ports/LogPort.js";
import type { ModelPort } from "../../src/core/ports/ModelPort.js";
import type { PromptParts } from "../../src/core/skill/prompt.js";

const TAXONOMY: LabelDef[] = [
  { name: "Crypto", description: "Coins, tokens, trading and market news.", m365Color: "preset4", gmailColor: "#3ECCE9" },
  { name: "Business", description: "Invoices, contracts and partner correspondence.", m365Color: "preset0", gmailColor: "#000000" },
  { name: "Noise", description: "Everything unimportant.", m365Color: "preset1", gmailColor: "#111111" },
];

const CONFIG: ModelConfig = {
  provider: "jev",
  model: "jev-latest",
  apiKeyEnvVar: "TYPESAFE_API_KEY",
  temperature: 0.1,
  maxTokens: 500,
};

const CONTEXT: LogContext = { accountId: "personal", internetMessageId: "<msg-1@example.com>" };

function message(subject: string, internetMessageId: string): MessageDTO {
  return {
    id: `m-${subject}`,
    internetMessageId,
    subject,
    bodyPreview: "A short body asking about coins.",
    senderEmail: "sender@example.com",
    senderName: "Sender",
    receivedDateTime: "2026-10-09T12:00:00Z",
    existingLabels: [],
    source: "m365",
    accountId: "personal",
  };
}

const MESSAGE = message("Coins are up", "<msg-1@example.com>");

interface ModelCall {
  prompt: PromptParts;
  taxonomy: LabelDef[];
  config: ModelConfig;
}

/**
 * A stub `ModelPort` — no real SDK — that replays `responses` in order and records each
 * call. The last response repeats, so a permanently invalid reply exhausts the budget
 * (same idiom as `tests/adapters/model/label-set-validation.test.ts`).
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

function classifyOptions(overrides: {
  message: MessageDTO;
  model: ModelPort;
  log: LogPort;
  context?: LogContext;
}) {
  return {
    message: overrides.message,
    taxonomy: TAXONOMY,
    model: overrides.model,
    config: CONFIG,
    log: overrides.log,
    context: overrides.context,
  };
}

test("HAPPY makes exactly one complete call and returns the above-threshold labels", async () => {
  // The Jev adapter's own cut (0.9/0.6 above the threshold, 0.01 below) arrives as the
  // validated reply shape the port resolves with.
  const { model, calls } = scriptedModel([{ labels: ["Crypto", "Business"] }]);
  const log = recordingLogPort();
  const messageSnapshot = structuredClone(MESSAGE);
  const taxonomySnapshot = structuredClone(TAXONOMY);

  const labels = await classify(classifyOptions({ message: MESSAGE, model, log: log.logPort, context: CONTEXT }));

  expect(labels).toEqual({ labels: ["Crypto", "Business"] });
  expect(calls).toHaveLength(1);
  // The prompt is 6.1's `buildPrompt` output for this message and taxonomy — built here,
  // not by the caller — and the conversation receives the frozen taxonomy and config unchanged.
  expect(calls[0].prompt.system).toContain("Crypto: Coins, tokens, trading and market news.");
  expect(calls[0].prompt.user).toContain("Subject: Coins are up");
  expect(calls[0].taxonomy).toBe(TAXONOMY);
  expect(calls[0].config).toBe(CONFIG);
  // Neither argument is mutated.
  expect(MESSAGE).toEqual(messageSnapshot);
  expect(TAXONOMY).toEqual(taxonomySnapshot);
  // The engine itself logs nothing on the happy path.
  expect(log.entries).toEqual([]);
});

test("EMPTY CLASSIFIED resolves to a valid empty set with no error log", async () => {
  const { model, calls } = scriptedModel([{ labels: [] }]);
  const log = recordingLogPort();

  const labels = await classify(classifyOptions({ message: MESSAGE, model, log: log.logPort, context: CONTEXT }));

  expect(labels).toEqual({ labels: [] });
  expect(calls).toHaveLength(1);
  expect(log.entries).toEqual([]);
});

test("MALFORMED REPLY is retried and the valid set is returned after exactly two calls", async () => {
  const { model, calls } = scriptedModel([{ labels: "x" }, { labels: ["Crypto"] }]);
  const log = recordingLogPort();

  const labels = await classify(classifyOptions({ message: MESSAGE, model, log: log.logPort, context: CONTEXT }));

  expect(labels).toEqual({ labels: ["Crypto"] });
  expect(calls).toHaveLength(2);
  expect(log.entries).toEqual([]);
});

test("EXHAUSTION within the ≤3 budget yields the empty set and one structured error carrying raw, reason and message context", async () => {
  const { model, calls } = scriptedModel([{ labels: "x" }]);
  const log = recordingLogPort();

  const labels = await classify(classifyOptions({ message: MESSAGE, model, log: log.logPort, context: CONTEXT }));

  expect(labels).toEqual({ labels: [] });
  expect(calls).toHaveLength(3);
  expect(log.entries).toHaveLength(1);
  const [entry] = log.entries;
  expect(entry.level).toBe("error");
  expect(entry.context?.raw).toEqual({ labels: "x" });
  expect(typeof entry.context?.reason).toBe("string");
  expect(entry.context?.reason).not.toBe("");
  expect(entry.context?.accountId).toBe("personal");
  expect(entry.context?.internetMessageId).toBe("<msg-1@example.com>");
});

test("TRANSPORT FAILURE propagates unwrapped with no empty-set fallback", async () => {
  const transportError = new Error("provider refused the connection");
  let attempted = 0;
  const model: ModelPort = {
    async complete() {
      attempted += 1;
      throw transportError;
    },
  };
  const log = recordingLogPort();

  const attempt = async () =>
    classify(classifyOptions({ message: MESSAGE, model, log: log.logPort, context: CONTEXT }));

  // PRD FR-1: the orchestrator re-queues — an outage must not read as a valid empty classification.
  await expect(attempt()).rejects.toBe(transportError);
  expect(attempted).toBe(1);
  expect(log.entries).toEqual([]);
});

test("PER-MESSAGE FLOW classifies messages 1 and 3 and continues the batch when message 2's model call rejects", async () => {
  const secondError = new Error("provider refused the connection");
  const model: ModelPort = {
    async complete(prompt) {
      if (prompt.user.includes("Subject: Invoices due")) throw secondError;
      return { labels: ["Business"] };
    },
  };
  const log = recordingLogPort();
  const messages = [
    message("Coins are up", "<msg-1@example.com>"),
    message("Invoices due", "<msg-2@example.com>"),
    message("Contract signed", "<msg-3@example.com>"),
  ];

  const results: Array<{ subject: string; labels?: string[]; error?: unknown }> = [];
  // The backfill-style loop an Epic 8 orchestrator runs — a per-message failure is caught
  // (and would be re-queued via FR-1), never a batch abort.
  for (const entry of messages) {
    try {
      const labels = await classify(classifyOptions({ message: entry, model, log: log.logPort, context: CONTEXT }));
      results.push({ subject: entry.subject, ...labels });
    } catch (error) {
      results.push({ subject: entry.subject, error });
    }
  }

  expect(results).toEqual([
    { subject: "Coins are up", labels: ["Business"] },
    { subject: "Invoices due", error: secondError },
    { subject: "Contract signed", labels: ["Business"] },
  ]);
});
