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
  extraParams?: Record<string, unknown>;
}
