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

// Reads a JSON body with a hard size cap. The cap is enforced on the bytes actually read,
// not on the Content-Length header, which a client controls.
export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Send the request as JSON.");
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new ApiError(413, "payload_too_large", "The request is too large.");
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}
