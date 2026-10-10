/**
 * Graceful shutdown (Story 9.2): the one `AbortController` a command's work reads, the
 * SIGINT/SIGTERM registration, the 5s shutdown-step deadline and the exit seam. It lives in
 * `cli` because neither the orchestration nor the adapters may know about process signals
 * (AD-10). Only `--cron` and `--backfill` opt in, by calling `attach()`.
 */

/** The exit code of a handled shutdown — always 0, even one forced by a second signal or the deadline. */
export const SHUTDOWN_EXIT_CODE = 0;

/**
 * The shutdown step's budget (the Decisions). `beginShutdown()` — never the signal handler — arms
 * it, so a message that legitimately overruns 5s is not cut mid-write.
 */
export const SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * The process surface the coordinator registers on, narrowed so a test can inject a recorder.
 * `process` itself is the shipped target.
 */
export interface ShutdownTarget {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** The coordinator's injectable seams; both default to the real process in production. */
export interface ShutdownOptions {
  target?: ShutdownTarget;
  exit?: (code: number) => void;
  /** The shutdown-step budget; defaults to `SHUTDOWN_DEADLINE_MS`. */
  deadlineMs?: number;
}

/**
 * What `index.ts` creates once for a real entry-point run. `signal` is handed to the running
 * command, `attach()` registers the process handlers (only the signal-handling routes call it),
 * `beginShutdown()` arms the deadline once the run has drained, and `handled` says whether a
 * signal has been seen — the entry pins `process.exitCode = 0` off it.
 */
export interface ShutdownCoordinator {
  readonly signal: AbortSignal;
  attach(): void;
  beginShutdown(): void;
  readonly handled: boolean;
}

/**
 * The CLI-local abort error: a raced wait surfaces as this throw. `orch` never imports it — an
 * interrupted module reads `signal.aborted`, so the error type stays on the CLI side.
 */
export class ShutdownError extends Error {
  constructor() {
    super("Shutdown requested — the run was interrupted.");
    this.name = "ShutdownError";
  }
}

/**
 * The wall-clock base of an `abortableSleep` when no test seam was injected.
 */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Races the injected base sleep against the signal, so an interrupt during a 9.1 backoff rung (or
 * the cron cycle's flat retry) ends the wait instead of outlasting it. The base seam is raced, not
 * replaced, so a recorder still sees the wait. An abort rejects with the CLI-local `ShutdownError`.
 */
export function abortableSleep(
  signal: AbortSignal,
  base: ((ms: number) => Promise<void>) | undefined,
): (ms: number) => Promise<void> {
  const wait = base ?? realSleep;
  return (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new ShutdownError());
        return;
      }
      const onAbort = (): void => reject(new ShutdownError());
      signal.addEventListener("abort", onAbort, { once: true });
      wait(ms).then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error: unknown) => {
          // A fault from the base sleep itself keeps escaping; only a real abort becomes a shutdown.
          signal.removeEventListener("abort", onAbort);
          reject(signal.aborted ? new ShutdownError() : error);
        },
      );
    });
}

/**
 * Resolves once `signal` is aborted (immediately when it already is). The cron loop's stop flag:
 * the scheduler's `runInterval` resolves long before the loop ends, so the command awaits this to
 * stay alive until a signal, then drains.
 */
export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Creates the process shutdown coordinator (Story 9.2). The first signal aborts the shared
 * `AbortController`; the second — or the deadline armed by `beginShutdown()` — forces `exit(0)`.
 */
export function createShutdown(options: ShutdownOptions = {}): ShutdownCoordinator {
  const target = options.target ?? (process as unknown as ShutdownTarget);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const controller = new AbortController();
  let handled = false;
  let attached = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const onSignal = (): void => {
    if (handled) {
      // A second signal (or one after the deadline was armed) stops immediately.
      exit(SHUTDOWN_EXIT_CODE);
      return;
    }
    handled = true;
    controller.abort();
  };

  return {
    signal: controller.signal,
    get handled(): boolean {
      return handled;
    },
    attach(): void {
      if (attached) return;
      attached = true;
      target.on("SIGINT", onSignal);
      target.on("SIGTERM", onSignal);
    },
    beginShutdown(): void {
      if (deadline !== undefined) return;
      deadline = setTimeout(() => exit(SHUTDOWN_EXIT_CODE), deadlineMs);
      // The deadline must not be the only thing keeping the process alive: a shutdown step that
      // hangs on a live handle still fires it, while a clean process is free to exit at once.
      deadline.unref?.();
    },
  };
}
