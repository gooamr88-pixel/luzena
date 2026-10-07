import type { Env } from "./types.ts";

// An error that is safe to show to the caller. Anything else becomes a generic 500.
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

export function errorBody(error: ApiError, requestId: string) {
  return { error: { code: error.code, message: error.message, ...error.extra, request_id: requestId } };
}

export function isAllowedOrigin(origin: string | null, env: Env): boolean {
  return origin !== null && env.allowedOrigins.includes(origin.replace(/\/$/, ""));
}

// CORS headers for an allowed origin; an empty object otherwise, so a disallowed origin
// simply cannot read the response.
export function corsHeaders(request: Request, env: Env, methods: string): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin as string,
    "access-control-allow-methods": methods,
    "access-control-allow-headers": "authorization, content-type, idempotency-key, x-restaurant-id",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function preflight(request: Request, env: Env, methods: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, env, methods) });
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "unknown";
}

// Reads a request body, stopping at a hard cap. The Content-Length header is the caller's
// own claim: it is looked at first only so that an honest oversized request is refused
// before any of it is read. What decides is the count of the bytes that actually arrive,
// and reading stops the moment that count passes the cap, so a caller who understates the
// length, or sends none, cannot make this function hold more than `maxBytes` in memory.
export async function readBytes(request: Request, maxBytes: number, tooLarge: () => Error): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) throw tooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// A multipart form, read under the same cap and then parsed from the bytes that were
// counted. Throws whatever `tooLarge` makes when the body is over the cap, and the parser's
// own error when the bytes are not a form.
export async function readForm(request: Request, maxBytes: number, tooLarge: () => Error): Promise<FormData> {
  const bytes = await readBytes(request, maxBytes, tooLarge);
  return new Response(bytes as BodyInit, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
}

// Reads a JSON body with a hard size cap, enforced on the bytes actually read.
export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Send the request as JSON.");
  }
  const bytes = await readBytes(request, maxBytes, () => new ApiError(413, "payload_too_large", "The request is too large."));
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}
