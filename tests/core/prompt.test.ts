import { test, expect } from "vitest";
import { buildPrompt } from "../../src/core/skill/prompt.js";

/** A frozen-taxonomy label; the prompt uses only `name` and `description`. */
function label(name: string, description: string) {
  return { name, description, m365Color: "preset0", gmailColor: "#000000" };
}

/** A fully populated `MessageDTO`; override a field to exercise an edge case. */
function message(overrides = {}) {
  return {
    id: "msg-1",
    internetMessageId: "<msg-1@example.com>",
    subject: "Quarterly invoice",
    bodyPreview: "Please find the invoice attached.",
    senderEmail: "billing@vendor.example",
    senderName: "Vendor Billing",
    receivedDateTime: "2026-10-09T12:00:00Z",
    existingLabels: [],
    source: "m365",
    accountId: "personal",
    ...overrides,
  };
}

const FIVE_LABELS = [
  label("Invoice", "A bill or receipt that needs paying or filing."),
  label("Action Needed", "The sender expects a reply or a task from the reader."),
  label("Newsletter", "A recurring bulk mailing with articles or updates."),
  label("Family", "Personal mail from relatives and close friends."),
  label("Promotions", "Marketing offers and discount announcements."),
];

function exampleBlocks(system: string): string[] {
  return system
    .split(/\n(?=Example \d+:)/)
    .filter((block) => /^Example \d+:/.test(block));
}

test("SYSTEM presents every label name and description plus the output contract", () => {
  const taxonomy = [label("Invoice", "A bill that needs paying."), label("Family", "Personal mail.")];
  const { system } = buildPrompt(message(), taxonomy);

  // The taxonomy list itself — not the few-shot example bodies that repeat these strings.
  expect(system).toContain("- Invoice: A bill that needs paying.");
  expect(system).toContain("- Family: Personal mail.");
  // The exact JSON shape and the instruction to return only JSON.
  expect(system).toContain('{"labels":["<label>"]}');
  expect(system).toMatch(/only valid JSON/i);
  // An empty answer is explicitly valid.
  expect(system).toContain('{"labels":[]}');
  expect(system).toMatch(/empty array is valid/i);
  // The precision-over-recall guardrail.
  expect(system).toMatch(/precision beats recall/i);
});

test("SYSTEM lists every label, including those past the example window", () => {
  const taxonomy = Array.from({ length: 7 }, (_, index) =>
    label(`Label ${index + 1}`, `Description number ${index + 1}.`),
  );
  const { system } = buildPrompt(message(), taxonomy);

  for (const entry of taxonomy) {
    expect(system).toContain(`- ${entry.name}: ${entry.description}`);
  }
  // Only the first five labels can be illustrated, so the list is not merely the examples.
  expect(exampleBlocks(system)).toHaveLength(5);
  expect(system).toContain("- Label 6: Description number 6.");
  expect(system).toContain("- Label 7: Description number 7.");
});

test("a multi-line label description collapses to a single line", () => {
  const { system } = buildPrompt(message(), [label("Invoice", "A bill\nthat needs\n  paying.")]);

  expect(system).toContain("- Invoice: A bill that needs paying.");
  expect(system).toContain("Body: A bill that needs paying.");
  // The block layout holds: subject, one body line, answer.
  expect(system).toMatch(/^Subject: Invoice\nBody: A bill that needs paying\.\nAnswer: /m);
});

test("FEW-SHOT gives 3-5 examples and every named label belongs to the taxonomy", () => {
  const { system } = buildPrompt(message(), FIVE_LABELS);
  const names = FIVE_LABELS.map((l) => l.name);

  const blocks = exampleBlocks(system);
  expect(blocks.length).toBeGreaterThanOrEqual(3);
  expect(blocks.length).toBeLessThanOrEqual(5);

  // Answers are parseable JSON whose labels all come from the taxonomy.
  const answers = [...system.matchAll(/^Answer: (.+)$/gm)].map((m) => JSON.parse(m[1]));
  expect(answers.length).toBe(blocks.length);
  for (const answer of answers) {
    for (const name of answer.labels) {
      expect(names).toContain(name);
    }
  }
  // Example subjects, too, only ever name a taxonomy label.
  for (const subject of [...system.matchAll(/^Subject: (.+)$/gm)].map((m) => m[1])) {
    expect(names).toContain(subject);
  }
  // Each example's body is that label's own description — that is what teaches its meaning.
  for (const example of FIVE_LABELS) {
    const block = blocks.find((candidate) => candidate.includes(`Subject: ${example.name}\n`));
    expect(block, `no example block for ${example.name}`).toBeDefined();
    expect(block).toContain(`Body: ${example.description}`);
  }
});

test("TAXONOMY SMALLER THAN THE EXAMPLE COUNT yields one example per label, none absent", () => {
  const one = buildPrompt(message(), [label("Invoice", "A bill that needs paying.")]);
  expect(exampleBlocks(one.system)).toHaveLength(1);
  expect(one.system).not.toContain("Family");

  const two = buildPrompt(message(), [
    label("Invoice", "A bill that needs paying."),
    label("Family", "Personal mail."),
  ]);
  expect(exampleBlocks(two.system)).toHaveLength(2);
  expect(two.system).not.toContain("Promotions");
});

test("USER carries subject, sender name and email, receivedDateTime and existing labels", () => {
  const { user } = buildPrompt(
    message({ existingLabels: ["Invoice", "Action Needed"] }),
    FIVE_LABELS,
  );

  expect(user).toContain("Quarterly invoice");
  expect(user).toContain("Vendor Billing");
  expect(user).toContain("billing@vendor.example");
  expect(user).toContain("2026-10-09T12:00:00Z");
  expect(user).toContain("Invoice, Action Needed");
});

test("BODY AT THE BOUNDARY keeps all 2000 characters with no truncation marker", () => {
  const body = "a".repeat(2000);
  const { user } = buildPrompt(message({ bodyPreview: body }), FIVE_LABELS);

  expect(user.endsWith(body)).toBe(true);
  expect(user).not.toMatch(/\[truncated\]|…|\.\.\./i);
});

test("BODY OVER THE BOUNDARY keeps exactly the first 2000 characters", () => {
  const { user } = buildPrompt(
    message({ bodyPreview: "a".repeat(2000) + "TAIL" }),
    FIVE_LABELS,
  );

  expect(user).toContain("a".repeat(2000));
  expect(user).not.toContain("TAIL");
});

test("EMPTY EXISTING LABELS renders an explicit none marker", () => {
  const { user } = buildPrompt(message({ existingLabels: [] }), FIVE_LABELS);

  expect(user).toMatch(/^Existing labels: none$/m);
});

test("PURITY yields identical output and leaves message and taxonomy unmodified", () => {
  const input = message({ existingLabels: ["Invoice"] });
  const taxonomy = FIVE_LABELS.map((l) => ({ ...l }));
  const messageSnapshot = structuredClone(input);
  const taxonomySnapshot = structuredClone(taxonomy);

  const first = buildPrompt(input, taxonomy);
  const second = buildPrompt(input, taxonomy);

  expect(second).toEqual(first);
  expect(input).toEqual(messageSnapshot);
  expect(taxonomy).toEqual(taxonomySnapshot);
});
