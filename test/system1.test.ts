import test from "node:test";
import assert from "node:assert/strict";

import type { MailboxMessage } from "../src/adapter.ts";
import { JevSystem1Classifier } from "../src/classify/system1.ts";

function createMessage(subject: string, body?: string): MailboxMessage {
  return {
    id: "msg-1",
    from: "alice@example.com",
    subject,
    date: "2026-01-01T00:00:00.000Z",
    unread: true,
    flagged: false,
    categories: [],
    ...(body === undefined ? {} : { body })
  };
}

test("JevSystem1Classifier sends locked System1 request shape", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  let calls = 0;

  const classifier = new JevSystem1Classifier({
    apiKey: "test-key",
    fetchFn: async (input, init) => {
      calls += 1;
      capturedUrl = input;
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            answers: {
              email_category: {
                choice: "Action Needed",
                confidence: 0.81,
                probabilities: {
                  "Action Needed": 0.81,
                  "Waiting/Follow-up": 0.09,
                  "FYI/Reference": 0.07,
                  "Bulk/Archive": 0.03
                }
              }
            }
          })
      } as Response;
    }
  });

  const result = await classifier.classify(createMessage("Invoice approval required", "Please approve the attached invoice by Friday."));

  assert.equal(capturedUrl, "https://api.typesafe.ai/v1/systemone");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(calls, 1); // success: no retry

  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-key");
  assert.equal(headers["content-type"], "application/json");

  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.model, "jev-latest");
  // State is the email material only — no coding-agent fields (conversation_excerpt,
  // environment, budget), per docs/typesafe-jev.skill.md "State".
  assert.deepEqual(body.state, {
    subject: "Invoice approval required",
    from: "alice@example.com",
    received_at: "2026-01-01T00:00:00.000Z",
    unread: true,
    flagged: false,
    existing_categories: [],
    body: "Please approve the attached invoice by Friday."
  });
  assert.equal(body.questions.email_category.type, "choice");
  assert.equal(
    body.questions.email_category.instructions,
    "Classify the email described by this state into exactly one of the four categories."
  );
  assert.deepEqual(Object.keys(body.questions.email_category.criteria), ["Action Needed", "Waiting/Follow-up", "FYI/Reference", "Bulk/Archive"]);

  assert.equal(result.category, "Action Needed");
  assert.equal(result.confidence, 0.81);
  assert.equal(result.rationale, "jev:category=Action Needed:confidence=0.81");
});

test("JevSystem1Classifier parses category/confidence and honors TYPESAFE_API_URL", async () => {
  const previousUrl = process.env.TYPESAFE_API_URL;
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_URL = "https://system1.example.test";
  process.env.TYPESAFE_API_KEY = "env-key";

  let capturedUrl = "";

  try {
    const classifier = new JevSystem1Classifier({
      fetchFn: async (input) => {
        capturedUrl = input;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              answers: {
                email_category: {
                  choice: "Waiting/Follow-up",
                  confidence: 0.66,
                  probabilities: {
                    "Waiting/Follow-up": 0.66
                  }
                }
              }
            })
        } as Response;
      }
    });

    const result = await classifier.classify(createMessage("Waiting on vendor follow-up"));

    assert.equal(capturedUrl, "https://system1.example.test/v1/systemone");
    assert.equal(result.category, "Waiting/Follow-up");
    assert.equal(result.confidence, 0.66);
    assert.equal(result.rationale, "jev:category=Waiting/Follow-up:confidence=0.66");
  } finally {
    process.env.TYPESAFE_API_URL = previousUrl;
    process.env.TYPESAFE_API_KEY = previousKey;
  }
});

test("JevSystem1Classifier omits the body field as null when the message has no body", async () => {
  let capturedInit: RequestInit | undefined;

  const classifier = new JevSystem1Classifier({
    apiKey: "test-key",
    fetchFn: async (_input, init) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            answers: { email_category: { choice: "FYI/Reference", confidence: 0.8, probabilities: { "FYI/Reference": 0.8 } } }
          })
      } as Response;
    }
  });

  await classifier.classify(createMessage("Status update"));

  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.state.body, null);
});

test("JevSystem1Classifier retries once on 429 and succeeds", async () => {
  let calls = 0;

  const classifier = new JevSystem1Classifier({
    apiKey: "test-key",
    retryDelayMs: 0,
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 429, text: async () => JSON.stringify({ error: "rate limited" }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            answers: { email_category: { choice: "Bulk/Archive", confidence: 0.9, probabilities: { "Bulk/Archive": 0.9 } } }
          })
      } as Response;
    }
  });

  const result = await classifier.classify(createMessage("Newsletter digest"));

  assert.equal(calls, 2);
  assert.equal(result.category, "Bulk/Archive");
});

test("JevSystem1Classifier does not retry non-rate-limit failures", async () => {
  let calls = 0;

  const classifier = new JevSystem1Classifier({
    apiKey: "test-key",
    retryDelayMs: 0,
    fetchFn: async () => {
      calls += 1;
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: "missing key" }) } as Response;
    }
  });

  await assert.rejects(classifier.classify(createMessage("Hello")), /missing key/);
  assert.equal(calls, 1);
});
