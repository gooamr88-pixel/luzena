// Small schema validators. Every request body and every Clover response passes through
// these before it is used. Unknown object keys are rejected, not ignored.
import { ApiError } from "./http.ts";

export type Validator<T> = (value: unknown, path: string) => T;

export class ValidationError extends Error {
  constructor(public path: string, message: string) {
    super(message);
  }
}

const fail = (path: string, message: string): never => {
  throw new ValidationError(path, message);
};

// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const v = {
  string(options: { min?: number; max: number; pattern?: RegExp; trim?: boolean } = { max: 500 }): Validator<string> {
    return (value, path) => {
      if (typeof value !== "string") return fail(path, "must be text");
      const text = options.trim === false ? value : value.trim();
      if (CONTROL_CHARS.test(text)) return fail(path, "contains characters that are not allowed");
      if (text.length < (options.min ?? 0)) {
        return fail(path, options.min === 1 ? "is required" : `must be at least ${options.min} characters`);
      }
      if (text.length > options.max) return fail(path, `must be at most ${options.max} characters`);
      if (options.pattern && !options.pattern.test(text)) return fail(path, "is not in a valid format");
      return text;
    };
  },

  int(options: { min: number; max: number }): Validator<number> {
    return (value, path) => {
      if (typeof value !== "number" || !Number.isInteger(value)) return fail(path, "must be a whole number");
      if (value < options.min || value > options.max) {
        return fail(path, `must be between ${options.min} and ${options.max}`);
      }
      return value;
    };
  },

  bool(): Validator<boolean> {
    return (value, path) => (typeof value === "boolean" ? value : fail(path, "must be true or false"));
  },

  oneOf<const T extends string>(allowed: readonly T[]): Validator<T> {
    return (value, path) =>
      typeof value === "string" && (allowed as readonly string[]).includes(value)
        ? (value as T)
        : fail(path, `must be one of: ${allowed.join(", ")}`);
  },

  array<T>(item: Validator<T>, options: { min?: number; max: number; unique?: boolean }): Validator<T[]> {
    return (value, path) => {
      if (!Array.isArray(value)) return fail(path, "must be a list");
      if (value.length < (options.min ?? 0)) return fail(path, `must have at least ${options.min} entries`);
      if (value.length > options.max) return fail(path, `must have at most ${options.max} entries`);
      const out = value.map((entry, index) => item(entry, `${path}[${index}]`));
      if (options.unique && new Set(out).size !== out.length) return fail(path, "must not contain duplicates");
      return out;
    };
  },

  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (value, path) => (value === undefined ? undefined : inner(value, path));
  },

  nullable<T>(inner: Validator<T>): Validator<T | null> {
    return (value, path) => (value === null ? null : inner(value, path));
  },

  object<S extends Record<string, Validator<unknown>>>(shape: S): Validator<{ [K in keyof S]: ReturnType<S[K]> }> {
    return (value, path) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return fail(path, "must be an object");
      }
      const input = value as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        if (!(key in shape)) return fail(path ? `${path}.${key}` : key, "is not a recognised field");
      }
      const out: Record<string, unknown> = {};
      for (const [key, validator] of Object.entries(shape)) {
        const result = validator(input[key], path ? `${path}.${key}` : key);
        if (result !== undefined) out[key] = result;
      }
      return out as { [K in keyof S]: ReturnType<S[K]> };
    };
  },
};

// Clover object ids are 13 uppercase letters and digits.
export const cloverId = v.string({ min: 13, max: 13, pattern: /^[A-Z0-9]{13}$/ });
export const uuid = v.string({
  min: 36,
  max: 36,
  pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
});

// Runs a validator on a request body and turns a failure into a 422 the UI can show inline.
export function parseBody<T>(validator: Validator<T>, body: unknown): T {
  try {
    return validator(body, "");
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ApiError(422, "validation_failed", "Some fields need attention.", {
        fields: { [error.path || "body"]: error.message },
      });
    }
    throw error;
  }
}
