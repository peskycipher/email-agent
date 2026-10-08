export interface LogContext {
  accountId?: string;
  [key: string]: unknown;
}

export interface LogPort {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}
