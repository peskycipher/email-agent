export interface ModelConfig {
  provider: "jev" | "openai" | "anthropic" | "custom";
  model: string;
  apiKeyEnvVar: string;
  temperature: number;
  maxTokens: number;
  extraParams?: Record<string, unknown>;
}
