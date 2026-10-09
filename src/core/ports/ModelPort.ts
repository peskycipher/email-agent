import type { ModelConfig } from "../dto/ModelConfig.js";

/** The JSON-Schema `type` keyword values (draft 2020-12). */
export type JsonSchemaType =
  | "null"
  | "boolean"
  | "object"
  | "array"
  | "number"
  | "string"
  | "integer";

/** Minimal structural JSON Schema; core declares it here because core imports nothing. */
export interface JsonSchema {
  type: JsonSchemaType;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
}

export interface ModelPort {
  complete(prompt: string, schema: JsonSchema, config: ModelConfig): Promise<unknown>;
}
