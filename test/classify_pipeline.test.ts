import test from "node:test";
import assert from "node:assert/strict";

import type { MailboxMessage } from "../src/adapter.ts";
import { classifyMessagesForDryRun } from "../src/classify/pipeline.ts";
import type { SecondPassClassifier } from "../src/classify/ollama.ts";
import type { ClassifierSystem1 } from "../src/classify/system1.ts";

function createMessage(id: string, subject: string): MailboxMessage {
  return {
    id,
    from: "sender@example.com",
    subject,
    date: "2026-01-01T00:00:00.000Z",
    unread: true,
    flagged: false,
    categories: []
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
