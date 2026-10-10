import type { SchedulerPort } from "../../core/ports/SchedulerPort.js";

/**
 * The shipped `SchedulerPort` (Story 8.3's first consumer): `runInterval` is `setInterval` plus
 * the `AbortController` the port declares — the controller is all Epic 9's graceful shutdown
 * needs. Deliberately minimal: no drift correction, no missed-tick catch-up, no jitter (all Epic
 * 9/10 scope). The interval keeps the process alive, which is the cron loop's lifetime; `abort()`
 * clears the timer and hands control back.
 *
 * A tick that fires while the previous `fn` is still running is skipped, never overlapped: the
 * cron cycle takes the 8.2 run lock per cycle, and a cycle racing itself could only lose that
 * lock. `fn` owns its own failure reporting — the port carries no logger — so a rejection is
 * settled (the in-flight flag must clear either way), never surfaced here.
 */
export function createScheduler(): SchedulerPort {
  return {
    async runOnce(fn) {
      await fn();
    },
    async runInterval(fn, intervalMs) {
      const controller = new AbortController();
      let inFlight = false;
      const timer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        void fn().then(
          () => {
            inFlight = false;
          },
          () => {
            inFlight = false;
          },
        );
      }, intervalMs);
      controller.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
      return controller;
    },
  };
}