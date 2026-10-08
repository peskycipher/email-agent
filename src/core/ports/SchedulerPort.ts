export interface SchedulerPort {
  runOnce(fn: () => Promise<void>): Promise<void>;
  runInterval(fn: () => Promise<void>, intervalMs: number): Promise<AbortController>;
}
