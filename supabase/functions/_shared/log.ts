import type { Logger, LogLevel } from "./types.ts";

// Any field whose name looks like a credential is replaced before it is written.
const SENSITIVE_KEY = /token|secret|authorization|password|cookie|api[-_]?key|^code$|nonce/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(entry, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}...`;
  return value;
}

export function createLogger(
  base: Record<string, unknown> = {},
  write: (line: string, level: LogLevel) => void = defaultWrite,
): Logger {
  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    const entry = { level, event, time: new Date().toISOString(), ...base, ...(redact(fields) as object) };
    write(JSON.stringify(entry), level);
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

function defaultWrite(line: string, level: LogLevel) {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Reduces an unknown error to fields that are safe to log.
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const extra = error as Error & { kind?: string; status?: number };
    return { error_name: error.name, error_message: error.message, kind: extra.kind, status: extra.status };
  }
  return { error_message: String(error) };
}
