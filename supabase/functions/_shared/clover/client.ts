import type { Deps } from "../types.ts";
import { USER_AGENT } from "./config.ts";
import { CloverError } from "./errors.ts";

// How a call may be retried:
//   read        GET. Safe to repeat on any failure.
//   idempotent  A write that sets values (update, association). Repeating it gives the same
//               result, so it is retried on 429, 5xx, timeouts and network errors.
//   create      A write that makes a new object. Clover has no idempotency key for
//               inventory, so it is retried ONLY on 429, where Clover states the request
//               was not processed. Any other failure is reported, never repeated.
export type RetryPolicy = "read" | "idempotent" | "create";

export interface CloverCall {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  retry: RetryPolicy;
}

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;
const MAX_WAIT_MS = 8_000;

function backoffMs(attempt: number, random: () => number): number {
  return Math.min(MAX_WAIT_MS, 1000 * 2 ** (attempt - 1) + Math.floor(random() * 400));
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(MAX_WAIT_MS, seconds * 1000) : null;
}

export function buildUrl(baseUrl: string, call: Pick<CloverCall, "path" | "query">): string {
  const url = new URL(call.path, baseUrl);
  for (const [key, value] of Object.entries(call.query ?? {})) {
    for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, entry);
  }
  return url.toString();
}

export async function cloverFetch(
  deps: Pick<Deps, "fetch" | "sleep" | "log" | "random">,
  baseUrl: string,
  token: string,
  call: CloverCall,
  correlationId: string,
): Promise<unknown> {
  const url = buildUrl(baseUrl, call);
  const isWrite = call.method !== "GET";

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: call.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      const kind = timedOut ? "timeout" : "network";
      deps.log.warn("clover_request_failed", { correlation_id: correlationId, path: call.path, kind, attempt });
      if (call.retry !== "create" && attempt < MAX_ATTEMPTS) {
        await deps.sleep(backoffMs(attempt, deps.random));
        continue;
      }
      throw new CloverError(kind, `Clover request ${kind}`, { outcomeUnknown: isWrite });
    }

    if (response.ok) {
      const text = await response.text();
      if (text.trim() === "") return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new CloverError("invalid_response", "Clover returned a body that is not JSON", {
          status: response.status,
          // The write itself succeeded; only the confirmation was unreadable.
          outcomeUnknown: isWrite,
        });
      }
    }

    const status = response.status;
    await response.body?.cancel().catch(() => {});
    deps.log.warn("clover_http_error", { correlation_id: correlationId, path: call.path, status, attempt });

    if (status === 429) {
      if (attempt < MAX_ATTEMPTS) {
        await deps.sleep(retryAfterMs(response) ?? backoffMs(attempt, deps.random));
        continue;
      }
      throw new CloverError("rate_limited", "Clover rate limit reached", { status });
    }
    if (status >= 500) {
      if (call.retry !== "create" && attempt < MAX_ATTEMPTS) {
        await deps.sleep(backoffMs(attempt, deps.random));
        continue;
      }
      throw new CloverError("unavailable", "Clover server error", { status, outcomeUnknown: isWrite });
    }
    if (status === 401) throw new CloverError("unauthorized", "Clover rejected the access token", { status });
    if (status === 403) throw new CloverError("forbidden", "Clover denied the request", { status });
    if (status === 404) throw new CloverError("not_found", "Clover object not found", { status });
    throw new CloverError("bad_request", "Clover rejected the request", { status });
  }
}
