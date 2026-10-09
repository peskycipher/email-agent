export interface FetchOpts {
  source: "m365" | "gmail";
  accountId: string;
  /**
   * The incremental lower bound (Stories 5.2/5.4). Each provider applies it its own way at the
   * wire: m365 uses an **inclusive** `$filter=receivedDateTime ge <ISO>`; Gmail's list path uses
   * an **exclusive** `after:`, stepped back one second so the boundary message is never dropped.
   */
  since?: Date;
  batchSize?: number;
  folder?: string;
}
