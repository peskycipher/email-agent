import test from "node:test";
import assert from "node:assert/strict";

import type { MailboxMessage } from "../src/adapter.ts";
import { classifyMessagesForDryRun } from "../src/classify/pipeline.ts";
import type { SecondPassClassifier } from "../src/classify/ollama.ts";
import type { ClassifierSystem1 } from "../src/classify/system1.ts";

function createMessage(id: string, subject: string, body?: string): MailboxMessage {
  return {
    id,
    from: "sender@example.com",
    subject,
    date: "2026-01-01T00:00:00.000Z",
    unread: true,
    flagged: false,
    categories: [],
    ...(body === undefined ? {} : { body })
  };
}

test("no-touch policy classifications are not overridden by model calls", async () => {
  let system1Calls = 0;
  let secondPassCalls = 0;

  const system1: ClassifierSystem1 = {
    async classify() {
      system1Calls += 1;
      return {
        category: "FYI/Reference",
        confidence: 0.2,
        rationale: "should-not-run"
      };
    }
  };

  const secondPass: SecondPassClassifier = {
    async classify() {
      secondPassCalls += 1;
      return {
        category: "Bulk/Archive",
        rationale: "should-not-run",
        model: "deepseek-4.1-flash"
      };
    }
  };

  const message = createMessage("msg-protected", "any subject");
  const result = await classifyMessagesForDryRun(
    [message],
    new Map([[message.id, ["vip-sender"]]]),
    {
      system1,
      secondPass
    }
  );

  const classified = result.get(message.id);
  assert.ok(classified);
  if (!classified) {
    throw new Error("missing classification");
  }

  assert.equal(classified.category, "Action Needed");
  assert.deepEqual(classified.rationale.policy, ["no-touch:vip-sender"]);
  assert.deepEqual(classified.rationale.model, []);
  assert.equal(system1Calls, 0);
  assert.equal(secondPassCalls, 0);
});

test("system1 handles majority pass and second pass only runs for low-confidence items", async () => {
  const messages = [
    createMessage("msg-1", "alpha"),
    createMessage("msg-2", "beta"),
    createMessage("msg-3", "gamma")
  ];

  let system1Calls = 0;
  let secondPassCalls = 0;

  const system1ById: Record<string, { category: "FYI/Reference" | "Waiting/Follow-up"; confidence: number; rationale: string }> = {
    "msg-1": { category: "FYI/Reference", confidence: 0.9, rationale: "clear-signal" },
    "msg-2": { category: "Waiting/Follow-up", confidence: 0.8, rationale: "clear-signal" },
    "msg-3": { category: "FYI/Reference", confidence: 0.4, rationale: "ambiguous" }
  };

  const system1: ClassifierSystem1 = {
    async classify(message) {
      system1Calls += 1;
      return system1ById[message.id];
    }
  };

  const secondPass: SecondPassClassifier = {
    async classify(message) {
      secondPassCalls += 1;
      assert.equal(message.id, "msg-3");
      return {
        category: "Action Needed",
        rationale: "resolved by ollama",
        model: "deepseek-4.1-flash"
      };
    }
  };

  const results = await classifyMessagesForDryRun(messages, new Map(), {
    system1,
    secondPass,
    confidenceThreshold: 0.7
  });

  assert.equal(system1Calls, 3);
  assert.equal(secondPassCalls, 1);

  assert.equal(results.get("msg-1")?.category, "FYI/Reference");
  assert.equal(results.get("msg-2")?.category, "Waiting/Follow-up");
  assert.equal(results.get("msg-3")?.category, "Action Needed");

  for (const message of messages) {
    const result = results.get(message.id);
    assert.ok(result);
    if (!result) {
      throw new Error(`missing classification for ${message.id}`);
    }

    assert.ok(Array.isArray(result.rationale.policy));
    assert.ok(Array.isArray(result.rationale.rule));
    assert.ok(Array.isArray(result.rationale.model));
  }
});

test("pipeline falls back after system1 error and still escalates to second pass", async () => {
  const message = createMessage("msg-fallback", "Contract attached for review");

  const system1: ClassifierSystem1 = {
    async classify() {
      throw new Error("system1-down");
    }
  };

  let secondPassCalls = 0;
  const secondPass: SecondPassClassifier = {
    async classify(received) {
      secondPassCalls += 1;
      assert.equal(received.id, message.id);
      return {
        category: "Waiting/Follow-up",
        rationale: "resolved by ollama",
        model: "deepseek-4.1-flash"
      };
    }
  };

  const result = await classifyMessagesForDryRun([message], new Map(), {
    system1,
    secondPass,
    confidenceThreshold: 0.7
  });

  const classified = result.get(message.id);
  assert.ok(classified);
  if (!classified) {
    throw new Error("missing classification");
  }

  assert.equal(secondPassCalls, 1);
  assert.equal(classified.category, "Waiting/Follow-up");
  assert.ok(classified.rationale.model.some((entry) => entry.startsWith("system1-error:system1-down")));
  assert.ok(classified.rationale.model.some((entry) => entry.startsWith("system1-fallback:keyword 'contract':confidence=")));
  assert.ok(classified.rationale.model.some((entry) => entry === "ollama:deepseek-4.1-flash:resolved by ollama"));
});

test("keyword rules read the body when the subject has no match", async () => {
  let modelCalls = 0;

  const system1: ClassifierSystem1 = {
    async classify() {
      modelCalls += 1;
      return { category: "FYI/Reference", confidence: 0.99, rationale: "should-not-be-asked" };
    }
  };

  const secondPass: SecondPassClassifier = {
    async classify() {
      modelCalls += 1;
      return { category: "FYI/Reference", rationale: "should-not-be-asked", model: "stub" };
    }
  };

  const byBody = createMessage("msg-body", "Quick note", "Please unsubscribe me from this digest.");
  const bySubject = createMessage("msg-subject", "Newsletter digest", undefined);

  const results = await classifyMessagesForDryRun([byBody, bySubject], new Map(), { system1, secondPass });

  // Both resolve deterministically from rules; the model is never asked.
  assert.equal(modelCalls, 0);
  assert.equal(results.get("msg-body")?.category, "Bulk/Archive");
  assert.ok(results.get("msg-body")?.rationale.rule.some((entry) => entry.includes("keyword rule") && entry.includes("body")));
  assert.equal(results.get("msg-subject")?.category, "Bulk/Archive");
  assert.ok(results.get("msg-subject")?.rationale.rule.some((entry) => entry.includes("keyword rule") && entry.includes("subject")));
});
