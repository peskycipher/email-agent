import { afterEach, expect, test, vi } from "vitest";
import { createScheduler } from "../../../src/adapters/scheduler/scheduler.js";
import type { SchedulerPort } from "../../../src/core/ports/SchedulerPort.js";

afterEach(() => {
  vi.useRealTimers();
});

test("runOnce awaits the fn to completion before resolving", async () => {
  const scheduler = createScheduler();
  let finished = false;

  await scheduler.runOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    finished = true;
  });

  expect(finished).toBe(true);
});

test("runInterval fires the fn once per interval and the controller stops the loop (INTERVAL)", async () => {
  vi.useFakeTimers();
  const scheduler = createScheduler();
  const ticks: number[] = [];

  const controller = await scheduler.runInterval(async () => {
    ticks.push(ticks.length);
  }, 60_000);
  expect(ticks).toEqual([]);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(ticks).toEqual([0]);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(ticks).toEqual([0, 1, 2]);

  controller.abort();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(ticks).toEqual([0, 1, 2]);
});

test("a tick that fires while the fn is still running is skipped, never overlapped (NO_SELF_OVERLAP)", async () => {
  vi.useFakeTimers();
  const scheduler: SchedulerPort = createScheduler();
  let running = false;
  const overlaps: boolean[] = [];

  await scheduler.runInterval(async () => {
    if (running) overlaps.push(true);
    running = true;
    // A cycle longer than the interval: the next tick fires before this one settles.
    await vi.advanceTimersByTimeAsync(90_000);
    running = false;
  }, 60_000);

  await vi.advanceTimersByTimeAsync(300_000);

  expect(overlaps).toEqual([]);
});