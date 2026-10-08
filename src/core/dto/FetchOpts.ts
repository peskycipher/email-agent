export interface FetchOpts {
  source: "m365" | "gmail";
  accountId: string;
  since?: Date;
  batchSize?: number;
  folder?: string;
}
