import type { ModelConfig } from "../dto/ModelConfig.js";

/** Minimal structural JSON Schema; core declares it here because core imports nothing. */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
}

export interface ModelPort {
  complete(prompt: string, schema: JsonSchema, config: ModelConfig): Promise<unknown>;
}
