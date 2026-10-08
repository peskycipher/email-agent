import type {
  Config,
  ConfigPort,
  FetchOpts,
  IdempotencyPort,
  JsonSchema,
  LabelDef,
  LogContext,
  LogPort,
  MailPort,
  MessageDTO,
  ModelConfig,
  ModelPort,
  SchedulerPort,
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

// Positive: the core barrel re-exports every contract name (AC-4). If any
// re-export is dropped, this alias fails with "has no exported member".
type _BarrelContracts = [
  Config,
  ConfigPort,
  IdempotencyPort,
  JsonSchema,
  LabelDef,
  LogContext,
  LogPort,
  MessageDTO,
  ModelConfig,
  ModelPort,
  SchedulerPort,
  TokenSet,
];
