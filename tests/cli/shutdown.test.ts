import { afterEach, expect, test, vi } from "vitest";
import {
  ShutdownError,
  abortableSleep,
  createShutdown,
  waitForAbort,
  type ShutdownTarget,
} from "../../src/cli/shutdown.js";

/** A `ShutdownTarget` recorder: it keeps the listeners so a test can fire a signal itself. */
function signalTarget(): {
  target: ShutdownTarget;
  fire: (signal: "SIGINT" | "SIGTERM") => void;
  registrations: string[];
} {
  const listeners = new Map<string, Array<() => void>>();
  const registrations: string[] = [];
  return {
    registrations,
    target: {
      on: (signal, listener) => {
        registrations.push(signal);
        const forSignal = listeners.get(signal) ?? [];
        forSignal.push(listener);
        listeners.set(signal, forSignal);
      },
    },
    fire: (signal) => {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test("nothing is registered until attach, and attach is idempotent (ATTACH)", () => {
  const { target, registrations } = signalTarget();
  const shutdown = createShutdown({ target, exit: () => {} });

  expect(registrations).toEqual([]);
  shutdown.attach();
  shutdown.attach();

  expect(registrations).toEqual(["SIGINT", "SIGTERM"]);
  expect(shutdown.handled).toBe(false);
  expect(shutdown.signal.aborted).toBe(false);
});

test("the first SIGINT aborts the shared signal and reads as handled (SIGINT)", () => {
  const { target, fire } = signalTarget();
  const shutdown = createShutdown({ target, exit: () => {} });
  shutdown.attach();

  fire("SIGINT");

  expect(shutdown.handled).toBe(true);
  expect(shutdown.signal.aborted).toBe(true);
});

test("a second SIGINT before exit stops immediately with exit 0 (SECOND_SIGNAL)", () => {
  const { target, fire } = signalTarget();
  const exits: number[] = [];
  const shutdown = createShutdown({ target, exit: (code) => exits.push(code) });
  shutdown.attach();

  fire("SIGINT");
  expect(exits).toEqual([]);
  fire("SIGINT");

  expect(exits).toEqual([0]);
});

test("the deadline is armed by beginShutdown, never by the signal, and forces exit 0 (DEADLINE)", () => {
  vi.useFakeTimers();
  const { target, fire } = signalTarget();
  const exits: number[] = [];
  const shutdown = createShutdown({ target, exit: (code) => exits.push(code), deadlineMs: 5_000 });
  shutdown.attach();

  fire("SIGINT");
  // The message already underway may legitimately overrun the budget: the signal arms no timer.
  vi.advanceTimersByTime(10_000);
  expect(exits).toEqual([]);

  shutdown.beginShutdown();
  vi.advanceTimersByTime(4_999);
  expect(exits).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(exits).toEqual([0]);
});

test("beginShutdown arms one deadline, not one per call (DEADLINE_ONCE)", () => {
  vi.useFakeTimers();
  const { target } = signalTarget();
  const exits: number[] = [];
  const shutdown = createShutdown({ target, exit: (code) => exits.push(code), deadlineMs: 5_000 });

  shutdown.beginShutdown();
  shutdown.beginShutdown();
  vi.advanceTimersByTime(5_000);

  expect(exits).toEqual([0]);
});

test("abortableSleep still runs the injected base wait, then rejects with ShutdownError on abort (SIGINT_IN_BACKOFF)", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  let releaseBase: () => void = () => {};
  const sleep = abortableSleep(controller.signal, (ms) => {
    waits.push(ms);
    return new Promise<void>((resolve) => {
      releaseBase = resolve;
    });
  });

  const pending = sleep(9_000);
  await Promise.resolve();
  // The seam is raced, not replaced: the recorder still sees the wait.
  expect(waits).toEqual([9_000]);

  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(ShutdownError);
  expect(waits).toEqual([9_000]);
  // The base wait that was interrupted never resolves here; the rejected race is what ends it.
  releaseBase();
});

test("abortableSleep rejects immediately when the signal is already aborted (SIGINT_IN_BACKOFF)", async () => {
  const controller = new AbortController();
  controller.abort();
  let waited = false;
  const sleep = abortableSleep(controller.signal, async () => {
    waited = true;
  });

  await expect(sleep(2_000)).rejects.toBeInstanceOf(ShutdownError);
  expect(waited).toBe(false);
});

test("a base wait that resolves cleanly resolves the abortable sleep (NO_ABORT)", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  const sleep = abortableSleep(controller.signal, async (ms) => {
    waits.push(ms);
  });

  await sleep(2_000);

  expect(waits).toEqual([2_000]);
});

test("a base wait fault is not swallowed as a shutdown (WIRING_FAULT)", async () => {
  const controller = new AbortController();
  const sleep = abortableSleep(controller.signal, async () => {
    throw new Error("sleep exploded");
  });

  await expect(sleep(2_000)).rejects.toThrow("sleep exploded");
});

test("waitForAbort resolves on the abort and immediately when already aborted (STOP_FLAG)", async () => {
  const controller = new AbortController();
  let resolved = false;
  const pending = waitForAbort(controller.signal).then(() => {
    resolved = true;
  });

  await Promise.resolve();
  expect(resolved).toBe(false);
  controller.abort();
  await pending;
  expect(resolved).toBe(true);

  controller.abort();
  await expect(waitForAbort(controller.signal)).resolves.toBeUndefined();
});
