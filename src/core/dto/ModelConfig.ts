export interface ModelConfig {
  /**
   * Ratified union (Story 1.3): `jev` and `openai` match AD-3's named
   * adapters; `anthropic` and `custom` are deliberate extras for
   * user-supplied providers, not planning drift.
   */
  provider: "jev" | "openai" | "anthropic" | "custom";
  model: string;
  apiKeyEnvVar: string;
  temperature: number;
  maxTokens: number;

  /**
   * The Jev multi-label cut (Story 6.3 decision 3): a taxonomy label joins the set iff
   * its `noul` probability is >= this threshold. A user-tunable product knob; the Jev
   * adapter applies the default (0.5) from `config.labelThreshold ?? 0.5`, the DTO does
   * not bake it in. Only the Jev adapter consumes it — OpenAI labels come from its own
   * structured output. `extraParams` cannot carry it: extra request fields are rejected
   * by the Jev API and `extraParams` route to the SDK client constructor.
   */
  labelThreshold?: number;
  extraParams?: Record<string, unknown>;
}
