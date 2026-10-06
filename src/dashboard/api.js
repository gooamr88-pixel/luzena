// Talks to the dashboard API. Every request carries the Supabase session's access token;
// the server derives the user and the restaurant from it.
import { state } from "./state.js";

export class ApiFailure extends Error {
  constructor(status, error) {
    super(error?.message ?? "The request failed.");
    this.status = status;
    this.code = error?.code ?? "unknown";
    this.details = error ?? {};
  }
}

async function send(method, path, body, headers, token) {
  const init = { method, headers: { authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout(45_000) };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(`${state.apiBase}/dashboard-api${path}`, init);
}

export async function api(method, path, body, headers = {}) {
  // Demo builds only (see demo.js). `state.demo` is never set in a production bundle.
  if (state.demo) return state.demo(method, path, body);
  if (!navigator.onLine) {
    throw new ApiFailure(0, { code: "offline", message: "You are offline. Nothing was sent. Reconnect and try again.", retryable: true, clover_changed: false, local_changed: false });
  }
  let response;
  try {
    const { data } = await state.supabase.auth.getSession();
    if (!data.session) throw new ApiFailure(401, { code: "unauthenticated", message: "Your session has expired. Sign in again." });
    response = await send(method, path, body, headers, data.session.access_token);
    if (response.status === 401) {
      // The access token may have just expired. Refresh once and repeat the request.
      const refreshed = await state.supabase.auth.refreshSession();
      if (refreshed.data.session) response = await send(method, path, body, headers, refreshed.data.session.access_token);
    }
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    // The request may or may not have reached the server.
    throw new ApiFailure(0, {
      code: "network",
      message: "The server could not be reached or took too long to answer.",
      retryable: true,
      clover_changed: method === "GET" ? false : "unknown",
    });
  }

  const payload = await response.json().catch(() => null);
  if (response.status === 401) {
    await state.supabase.auth.signOut();
    throw new ApiFailure(401, payload?.error ?? { code: "unauthenticated", message: "Your session has expired. Sign in again." });
  }
  if (!response.ok) throw new ApiFailure(response.status, payload?.error);
  return payload;
}

// One plain-language account of a failure: what failed, and what did or did not change.
export function explain(failure) {
  const details = failure.details ?? {};
  const lines = [failure.message];
  if (details.clover_changed === false) lines.push("Nothing was changed in Clover.");
  if (details.clover_changed === true) lines.push("Part of the change reached Clover.");
  if (details.clover_changed === "unknown") {
    lines.push("It is not known whether the change reached Clover. Check the current values before trying again.");
  }
  if (details.local_changed === false && details.clover_changed !== undefined) lines.push("Nothing was saved on the website.");
  return lines.join(" ");
}

export const newIdempotencyKey = () => crypto.randomUUID();
