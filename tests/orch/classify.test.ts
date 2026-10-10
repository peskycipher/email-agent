import { afterEach, expect, test } from "vitest";
import { JevAdapter } from "../../src/adapters/model/JevAdapter.js";
import type {
  JevClient,
  JevSystemOneRequest,
} from "../../src/adapters/model/JevAdapter.js";
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

const JEV_KEY_ENV = "EMAIL_CLASSIFY_TEST_JEV_KEY";

afterEach(() => {
  delete process.env[JEV_KEY_ENV];
});

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
  logPort: LogPort;
  context?: LogContext;
}) {
  return {
    message: overrides.message,
    taxonomy: TAXONOMY,
    model: overrides.model,
    config: CONFIG,
    logPort: overrides.logPort,
    context: overrides.context,
  };
}

test("HAPPY drives the real JevAdapter over 0.9/0.6/0.01 noul probabilities to one complete call and the above-threshold labels", async () => {
  process.env[JEV_KEY_ENV] = "key";
  const jevConfig: ModelConfig = { ...CONFIG, apiKeyEnvVar: JEV_KEY_ENV };
  // The adapter's own thresholding (0.9/0.6 above 0.5, 0.01 below) — same stdlib-only
  // stub-client idiom as tests/adapters/model/jev-adapter.test.ts.
  const requests: JevSystemOneRequest[] = [];
  const client: JevClient = {
    async systemOne(request) {
      requests.push(request);
      return {
        model: "jev-latest",
        answers: Object.fromEntries(
          Object.entries({ Crypto: 0.9, Business: 0.6, Noise: 0.01 }).map(([name, noul]) => [name, { type: "noul", noul }]),
        ),
        usage: { input_tokens: 42, output_tokens: 7 },
      };
    },
  };
  const log = recordingLogPort();
  const jev = new JevAdapter({ log: log.logPort, createJevClient() { return client; } });
  let completeCalls = 0;
  const model: ModelPort = {
    async complete(prompt, taxonomy, config) {
      completeCalls += 1;
      return jev.complete(prompt, taxonomy, config);
    },
  };
  const messageSnapshot = structuredClone(MESSAGE);
  const taxonomySnapshot = structuredClone(TAXONOMY);

  const labels = await classify(classifyOptions({ message: MESSAGE, model, logPort: log.logPort, context: CONTEXT }));

  expect(labels).toEqual({ labels: ["Crypto", "Business"] });
  expect(completeCalls).toBe(1);
  // The prompt is 6.1's `buildPrompt` output for this message and taxonomy — built here,
  // not by the caller — and the conversation receives the frozen taxonomy and config unchanged.
  expect(requests).toHaveLength(1);
  expect(requests[0].state).toContain("Crypto: Coins, tokens, trading and market news.");
  expect(requests[0].state).toContain("Subject: Coins are up");
  expect(Object.keys(requests[0].questions)).toEqual(["Crypto", "Business", "Noise"]);
  expect(requests[0].model).toBe(jevConfig.model);
  expect(log.entries.filter((entry) => entry.level === "info")).toHaveLength(1);
  // Neither argument is mutated.
  expect(MESSAGE).toEqual(messageSnapshot);
  expect(TAXONOMY).toEqual(taxonomySnapshot);
});

test("EMPTY CLASSIFIED resolves to a valid empty set with no error log", async () => {
  const { model, calls } = scriptedModel([{ labels: [] }]);
  const log = recordingLogPort();

  const labels = await classify(classifyOptions({ message: MESSAGE, model, logPort: log.logPort, context: CONTEXT }));

  expect(labels).toEqual({ labels: [] });
  expect(calls).toHaveLength(1);
  expect(log.entries).toEqual([]);
});

test("MALFORMED REPLY is retried and the valid set is returned after exactly two calls", async () => {
  const { model, calls } = scriptedModel([{ labels: "x" }, { labels: ["Crypto"] }]);
  const log = recordingLogPort();

  const labels = await classify(classifyOptions({ message: MESSAGE, model, logPort: log.logPort, context: CONTEXT }));

  expect(labels).toEqual({ labels: ["Crypto"] });
  expect(calls).toHaveLength(2);
  expect(log.entries).toEqual([]);
});

test("EXHAUSTION within the ≤3 budget yields the empty set and one structured error carrying raw, reason and message context", async () => {
  const { model, calls } = scriptedModel([{ labels: "x" }]);
  const log = recordingLogPort();

  const labels = await classify(classifyOptions({ message: MESSAGE, model, logPort: log.logPort, context: CONTEXT }));

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

test("A port resolving undefined exhausts the ≤3 budget to the empty set with one structured no-message error", async () => {
  const { model, calls } = scriptedModel([undefined]);
  const log = recordingLogPort();

  const labels = await classify(classifyOptions({ message: MESSAGE, model, logPort: log.logPort, context: CONTEXT }));

  expect(labels).toEqual({ labels: [] });
  expect(calls).toHaveLength(3);
  expect(log.entries).toHaveLength(1);
  const [entry] = log.entries;
  expect(entry.level).toBe("error");
  expect(entry.context?.reason).toBe("(root): Invalid input: expected object, received undefined");
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
    classify(classifyOptions({ message: MESSAGE, model, logPort: log.logPort, context: CONTEXT }));

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
      const labels = await classify(classifyOptions({ message: entry, model, logPort: log.logPort, context: CONTEXT }));
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
