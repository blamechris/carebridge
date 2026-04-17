/**
 * Lightweight structured JSON logger for CareBridge services.
 *
 * Outputs one JSON object per line (newline-delimited JSON) so log
 * aggregators (Datadog, Loki, CloudWatch Insights) can parse fields
 * without regex extraction.
 *
 * No external dependencies — wraps Node's console with structured output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Create a structured logger scoped to a service name.
 *
 * Every call emits a single JSON line to stdout (info/debug) or
 * stderr (warn/error), matching the convention that structured log
 * shippers expect.
 */
export function createLogger(service: string): Logger {
  function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ...meta,
      timestamp: new Date().toISOString(),
      level,
      service,
      msg,
    };

    const line = JSON.stringify(entry);

    if (level === "error" || level === "warn") {
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
  };
}
