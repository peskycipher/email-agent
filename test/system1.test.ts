import test from "node:test";
import assert from "node:assert/strict";

import type { MailboxMessage } from "../src/adapter.ts";
import { JevSystem1Classifier } from "../src/classify/system1.ts";

function createMessage(subject: string): MailboxMessage {
  return {
    id: "msg-1",
    from: "alice@example.com",
    subject,
    date: "2026-01-01T00:00:00.000Z",
    unread: true,
    flagged: false,
    categories: []
  };
}

test("JevSystem1Classifier sends locked System1 request shape", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const classifier = new JevSystem1Classifier({
    apiKey: "test-key",
    fetchFn: async (input, init) => {
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

  const result = await classifier.classify(createMessage("Invoice approval required"));

  assert.equal(capturedUrl, "https://api.typesafe.ai/v1/systemone");
  assert.equal(capturedInit?.method, "POST");

  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-key");
  assert.equal(headers["content-type"], "application/json");

  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.model, "jev-latest");
  assert.equal(body.state.conversation_excerpt, null);
  assert.deepEqual(body.state.environment, {
    cwd: null,
    active_model: null,
    context_tokens_used: null
  });
  assert.deepEqual(body.state.budget, {
    spent_today_usd: 0,
    spent_this_month_usd: 0,
    daily_cap_usd: null,
    monthly_cap_usd: null,
    fraction_of_budget_used: 0
  });
  assert.equal(body.questions.email_category.type, "choice");
  assert.equal(body.questions.email_category.instructions, "Classify the email in `request` into exactly one of the four categories.");
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
