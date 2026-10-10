export interface LogContext {
  accountId?: string;
  [key: string]: unknown;
}

export interface LogPort {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /**
   * Drains buffered records; a graceful shutdown awaits it before exiting (Story 9.2). Optional
   * because only a buffering logger needs one: the console adapter no-ops it, and Epic 10's file
   * logger is what actually flushes.
   */
  flush?(): Promise<void>;
}
