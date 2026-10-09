import type {
  Config,
  ConfigPort,
  FetchOpts,
  IdempotencyPort,
  JsonSchema,
  LabelDef,
  LabelSet,
  LogContext,
  LogPort,
  MailPort,
  MessageDTO,
  ModelConfig,
  ModelPort,
  SchedulerPort,
  Taxonomy,
  TokenPort,
  TokenSet,
} from "../../src/core/index.js";

declare const tokens: TokenSet;
declare const mailPort: MailPort;
declare const tokenPort: TokenPort;

// Positive: accountId is accepted.
void tokenPort.get("m365", "account-name");

// Negative: accountId is required on every account-touching member (Story 1.2
// AC 3 and the spec's Always rule). Each call supplies the other arguments and
// passes `undefined` where `accountId` is omitted, so the ONLY error is
// `undefined` not assignable to `string`; `@ts-expect-error` is satisfied only
// by that error, so loosening `accountId` on any member fails `bun run typecheck`.
// @ts-expect-error accountId is required
void tokenPort.get("m365");
// @ts-expect-error accountId is required
void tokenPort.set("m365", undefined, tokens);
// @ts-expect-error accountId is required
void tokenPort.delete("m365", undefined);
// @ts-expect-error accountId is required
void mailPort.writeLabels(undefined, "msg-id", ["a"]);
// @ts-expect-error accountId is required
void mailPort.ensureCategories(undefined, []);
// @ts-expect-error accountId is required
const badOpts: FetchOpts = { source: "m365" };
void badOpts;

// Positive: the new taxonomy DTOs carry their declared shapes (Story 1.3
// AC 2–3). A drift to a non-array `Taxonomy` or non-array `labels` fails here.
declare const labelSet: LabelSet;
declare const taxonomy: Taxonomy;
const labels: string[] = labelSet.labels;
void labels;
const labelDefs: LabelDef[] = taxonomy;
void labelDefs;

// Positive: the core barrel re-exports every contract name (AC-4). If any
// re-export is dropped, this alias fails with "has no exported member".
type _BarrelContracts = [
  Config,
  ConfigPort,
  IdempotencyPort,
  JsonSchema,
  LabelDef,
  LabelSet,
  LogContext,
  LogPort,
  MessageDTO,
  ModelConfig,
  ModelPort,
  SchedulerPort,
  Taxonomy,
  TokenSet,
];

// Positive: JsonSchema.type is the JSON-Schema keyword union and
// `additionalProperties` accepts the boolean-or-schema form (Story 1.3 follow-up).
const _narrowedSchema: JsonSchema = {
  type: "object",
  properties: { name: { type: "string", enum: ["a", "b"] } },
  additionalProperties: { type: "string" },
};
void _narrowedSchema;
// @ts-expect-error `type` is narrowed to the keyword union, not any string
const _badType: JsonSchema = { type: "stringly" };
void _badType;
// @ts-expect-error `additionalProperties` must be a boolean or a schema, not a number
const _badAddl: JsonSchema = { type: "object", additionalProperties: 42 };
void _badAddl;
