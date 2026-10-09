import type {
  Config,
  ConfigPort,
  FetchOpts,
  IdempotencyPort,
  LabelDef,
  LabelSet,
  LogContext,
  LogPort,
  MailPort,
  MessageDTO,
  ModelConfig,
  ModelPort,
  PromptParts,
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
  LabelDef,
  LabelSet,
  LogContext,
  LogPort,
  MessageDTO,
  ModelConfig,
  ModelPort,
  PromptParts,
  SchedulerPort,
  Taxonomy,
  TokenSet,
];

// Positive: `ModelPort` is the classification seam (Story 6.3 decision 1). A drift to
// the superseded `(prompt, schema, config)` shape fails here — no schema crosses the port.
declare const modelPort: ModelPort;
declare const promptParts: PromptParts;
declare const modelConfig: ModelConfig;
const pendingReply: Promise<unknown> = modelPort.complete(promptParts, taxonomy, modelConfig);
void pendingReply;
// @ts-expect-error `complete` requires the taxonomy argument
void modelPort.complete(promptParts, modelConfig);
// @ts-expect-error `prompt` is `PromptParts`, not a flattened string
void modelPort.complete("Subject: hi", taxonomy, modelConfig);

// Positive: `labelThreshold` is the user-tunable Jev cut (Story 6.3 decision 3).
const thresholdConfig: ModelConfig = { ...modelConfig, labelThreshold: 0.7 };
void thresholdConfig;
// @ts-expect-error `labelThreshold` must be a number
const badThreshold: ModelConfig = { ...modelConfig, labelThreshold: "0.7" };
void badThreshold;
