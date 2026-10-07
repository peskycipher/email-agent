import test from "node:test";
import assert from "node:assert/strict";

import { OllamaCloudClassifier } from "../src/classify/ollama.ts";
import type { MailboxMessage } from "../src/adapter.ts";

test("OllamaCloudClassifier uses locked primary model and falls back to backup model on API failure", async () => {
  const calledModels: string[] = [];
  const prompts: string[] = [];

  const responses = [
    {
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: "unavailable" })
    },
    {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  category: "FYI/Reference",
                  rationale: "backup model classification"
                })
              }
            }
          ]
        })
    }
  ];

  const classifier = new OllamaCloudClassifier({
    apiKey: "test-key",
    fetchFn: async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calledModels.push(body.model);
      prompts.push(String(body.messages?.[0]?.content ?? ""));
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected request");
      }
      return response as Response;
    }
  });

  const message: MailboxMessage = {
    id: "msg-1",
    from: "sender@example.com",
    subject: "Need details",
    date: "2026-01-01T00:00:00.000Z",
    unread: true,
    flagged: false,
    categories: [],
    body: "Could you send the delivery address for order A-104?"
  };

  const result = await classifier.classify(message);

  assert.deepEqual(calledModels, ["deepseek-4.1-flash", "glm-5.3-flash"]);
  assert.equal(result.category, "FYI/Reference");
  assert.equal(result.model, "glm-5.3-flash");
  // The body reaches the model when the adapter provides it.
  assert.match(prompts[0], /Could you send the delivery address for order A-104\?/);
});
