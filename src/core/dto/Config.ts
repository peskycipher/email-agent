import type { LabelDef } from "./LabelDef.js";

export interface Config {
  m365: { accounts: string[] };
  gmail: { accounts: string[] };
  taxonomyOverrides?: (Pick<LabelDef, "name"> & Partial<Omit<LabelDef, "name">>)[];
  tokenFallback: { passphraseEnvVar: string };
}
