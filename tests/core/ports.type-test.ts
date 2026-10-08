import type { FetchOpts } from "../../src/core/dto/FetchOpts.js";
import type { MailPort } from "../../src/core/ports/MailPort.js";
import type { TokenPort } from "../../src/core/ports/TokenPort.js";

declare const mailPort: MailPort;
declare const tokenPort: TokenPort;

// Positive: accountId is accepted.
void tokenPort.get("m365", "account-name");

// Negative: accountId is required on every account-touching member (Story 1.2
// AC 3 and the spec's Always rule). `@ts-expect-error` is only satisfied when
// the call is a type error, so each line below fails `bun run typecheck` if the
// parameter is ever loosened or dropped.
// @ts-expect-error accountId is required
void tokenPort.get("m365");
// @ts-expect-error accountId is required
void tokenPort.set("gmail", "account-name");
// @ts-expect-error accountId is required
void tokenPort.delete("m365");
// @ts-expect-error accountId is required
void mailPort.writeLabels("msg-id", ["a"]);
// @ts-expect-error accountId is required
void mailPort.ensureCategories([]);
// @ts-expect-error accountId is required
const badOpts: FetchOpts = { source: "m365" };
void badOpts;
