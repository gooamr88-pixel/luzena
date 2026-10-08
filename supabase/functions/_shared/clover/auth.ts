// Clover OAuth v2 (high-trust authorization code flow) and access-token management.
import { decryptSecret, encryptSecret } from "../crypto.ts";
import type { Deps, Env } from "../types.ts";
import { type CloverCall, cloverFetch } from "./client.ts";
import { CLOVER_HOSTS, USER_AGENT } from "./config.ts";
import { CloverError } from "./errors.ts";

export interface CloverTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // epoch milliseconds
  refreshExpiresAt: number | null;
}

export interface CloverApi {
  merchantId: string;
  request(call: CloverCall): Promise<unknown>;
}

type CloverConfig = NonNullable<Env["clover"]>;

// Refresh this long before the access token expires, so a request never starts with a
// token that dies mid-flight.
const REFRESH_MARGIN_MS = 120_000;
const REFRESH_LOCK_SECONDS = 30;

// What "unauthorized" from Clover costs.
//
// One such answer is not proof that a token is dead: Clover has been seen to give it for a
// token that worked a moment later. So the request is tried once more, after a short wait.
// If Clover says it again, that is one failed attempt, and it is counted. The connection is
// marked as needing a new token only when Clover has gone on saying it: this many attempts
// in a row, spread over at least this long. Bounded on every side: one extra request per
// attempt, visitors cannot set off an attempt more often than every two minutes while it
// lasts (sync_due in the database), and after the mark nothing is sent to Clover at all.
const UNAUTHORIZED_RETRY_WAIT_MS = 1500;
const AUTH_FAILURES_BEFORE_REAUTH = 3;
const AUTH_FAILING_SECONDS_BEFORE_REAUTH = 600;

export function requireClover(env: Env): { clover: CloverConfig; key: string } {
  if (!env.clover || !env.tokenEncryptionKey) {
    throw new CloverError("not_configured", "Clover app credentials or encryption key are missing");
  }
  return { clover: env.clover, key: env.tokenEncryptionKey };
}

// The key alone: all that a stored connection needs in order to be used. A connection made
// with a merchant's own API token works without any Clover app being configured.
function requireKey(env: Env): string {
  if (!env.tokenEncryptionKey) throw new CloverError("not_configured", "The token encryption key is missing");
  return env.tokenEncryptionKey;
}

// A connection made with a merchant-generated API token (Clover merchant dashboard > API
// tokens) instead of OAuth. Such a token does not expire and has no refresh token, so the
// refresh slot holds this marker and the expiry is set far in the future. When Clover
// rejects the token the only remedy is a new one from the merchant: see getCredentials.
export const API_TOKEN_MARKER = "merchant-api-token:no-refresh";
const API_TOKEN_EXPIRY = "9999-12-31T00:00:00.000Z";

export async function sealApiToken(token: string, key: string) {
  return {
    accessEnc: await encryptSecret(token, key),
    refreshEnc: await encryptSecret(API_TOKEN_MARKER, key),
    accessExp: API_TOKEN_EXPIRY,
    refreshExp: null,
  };
}

// An API handle for a token that is not stored yet, used to check it before saving it.
export function cloverWithToken(
  deps: Deps, environment: keyof typeof CLOVER_HOSTS, merchantId: string, token: string, correlationId: string,
): CloverApi {
  return {
    merchantId,
    request: (call: CloverCall) => cloverFetch(deps, CLOVER_HOSTS[environment].api, token, call, correlationId),
  };
}

export function buildAuthorizeUrl(clover: CloverConfig, state: string): string {
  const url = new URL("/oauth/v2/authorize", CLOVER_HOSTS[clover.environment].web);
  url.searchParams.set("client_id", clover.appId);
  url.searchParams.set("redirect_uri", clover.redirectUri);
  url.searchParams.set("response_type", "code");
  // Clover's v2 guides do not document `state`. It is sent anyway; see completeConnection
  // for how its absence on return is handled.
  url.searchParams.set("state", state);
  return url.toString();
}

// Clover documents expirations as Unix timestamps. Seconds and milliseconds are both
// accepted so a format change cannot silently produce a token that "expired in 1970".
function toEpochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

export function parseTokenResponse(body: unknown): CloverTokens {
  const data = (body ?? {}) as Record<string, unknown>;
  const accessExpiresAt = toEpochMs(data.access_token_expiration);
  if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || accessExpiresAt === null) {
    throw new CloverError("invalid_response", "Clover token response is missing required fields");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt,
    refreshExpiresAt: toEpochMs(data.refresh_token_expiration),
  };
}

// Token calls are never retried automatically: an authorization code and a refresh token
// are both single use.
async function tokenCall(deps: Deps, path: string, body: Record<string, string>): Promise<CloverTokens> {
  const { clover } = requireClover(deps.env);
  let response: Response;
  try {
    response = await deps.fetch(new URL(path, CLOVER_HOSTS[clover.environment].api).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CloverError("network", "Clover token endpoint unreachable", { outcomeUnknown: true });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const kind = response.status >= 500 ? "unavailable" : response.status === 429 ? "rate_limited" : "bad_request";
    throw new CloverError(kind, "Clover token endpoint returned an error", { status: response.status });
  }
  return parseTokenResponse(await response.json().catch(() => null));
}

export function exchangeCode(deps: Deps, code: string): Promise<CloverTokens> {
  const { clover } = requireClover(deps.env);
  return tokenCall(deps, "/oauth/v2/token", {
    client_id: clover.appId,
    client_secret: clover.appSecret,
    code,
  });
}

function refreshTokens(deps: Deps, refreshToken: string): Promise<CloverTokens> {
  const { clover } = requireClover(deps.env);
  return tokenCall(deps, "/oauth/v2/refresh", { client_id: clover.appId, refresh_token: refreshToken });
}

export async function sealTokens(tokens: CloverTokens, key: string) {
  return {
    accessEnc: await encryptSecret(tokens.accessToken, key),
    refreshEnc: await encryptSecret(tokens.refreshToken, key),
    accessExp: new Date(tokens.accessExpiresAt).toISOString(),
    refreshExp: tokens.refreshExpiresAt ? new Date(tokens.refreshExpiresAt).toISOString() : null,
  };
}

interface ConnectionSecret {
  merchant_id: string;
  environment: keyof typeof CLOVER_HOSTS;
  status: "active" | "needs_reauth";
  access_token_enc: string;
  refresh_token_enc: string;
  access_token_expires_at: string;
  auth_failures?: number;
}

interface Credentials {
  token: string;
  merchantId: string;
  baseUrl: string;
  // Clover has rejected this connection on earlier attempts and none has succeeded since.
  failing: boolean;
  // The token Clover just rejected, handed back because there is no other: a merchant's
  // API token cannot be refreshed.
  sameToken?: boolean;
}

const readSecret = (deps: Deps, restaurantId: string) =>
  deps.db.rpc<ConnectionSecret | null>("clover_connection_secret", { p_restaurant: restaurantId });

// Returns a usable access token, refreshing it when it is close to expiry.
//
// Clover refresh tokens are single use: the moment one is exchanged, it is dead. Two
// function instances refreshing at once would therefore invalidate each other and lock the
// restaurant out. A database lock makes exactly one instance refresh; the others wait and
// pick up the rotated token.
async function getCredentials(deps: Deps, restaurantId: string, rejectedToken: string | null): Promise<Credentials> {
  const key = requireKey(deps.env);

  const usable = async (row: ConnectionSecret): Promise<Credentials | null> => {
    const expiresAt = Date.parse(row.access_token_expires_at);
    if (expiresAt - deps.now() <= REFRESH_MARGIN_MS) return null;
    const token = await decryptSecret(row.access_token_enc, key);
    // A token Clover just rejected is not usable even if its expiry looks fine.
    if (token === rejectedToken) return null;
    return { token, merchantId: row.merchant_id, baseUrl: CLOVER_HOSTS[row.environment].api, failing: (row.auth_failures ?? 0) > 0 };
  };

  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await readSecret(deps, restaurantId);
    if (!row) throw new CloverError("not_connected", "No Clover connection for this restaurant");
    if (row.status === "needs_reauth") throw new CloverError("needs_reauth", "Clover connection needs re-authorisation");

    const ready = await usable(row);
    if (ready) return ready;

    const claimed = await deps.db.rpc<boolean>("clover_refresh_claim", {
      p_restaurant: restaurantId,
      p_lock_seconds: REFRESH_LOCK_SECONDS,
    });
    if (!claimed) {
      await deps.sleep(600);
      continue;
    }

    // Holding the lock. Another instance may have rotated between our read and our claim.
    const current = await readSecret(deps, restaurantId);
    if (!current) throw new CloverError("not_connected", "No Clover connection for this restaurant");
    const rotated = await usable(current);
    if (rotated) {
      await deps.db.rpc("clover_refresh_release", { p_restaurant: restaurantId });
      return rotated;
    }

    const refreshToken = await decryptSecret(current.refresh_token_enc, key);
    if (refreshToken === API_TOKEN_MARKER) {
      // A merchant API token cannot be refreshed, so there is no newer token to try. Getting
      // here means Clover rejected this one, once. It is handed back for one more try of
      // the same request; openClover counts the rejection if Clover repeats it.
      await deps.db.rpc("clover_refresh_release", { p_restaurant: restaurantId });
      return {
        token: await decryptSecret(current.access_token_enc, key), merchantId: current.merchant_id,
        baseUrl: CLOVER_HOSTS[current.environment].api, failing: (current.auth_failures ?? 0) > 0, sameToken: true,
      };
    }

    try {
      const tokens = await refreshTokens(deps, refreshToken);
      const sealed = await sealTokens(tokens, key);
      await deps.db.rpc("clover_tokens_rotate", {
        p_restaurant: restaurantId,
        p_access_enc: sealed.accessEnc,
        p_refresh_enc: sealed.refreshEnc,
        p_access_exp: sealed.accessExp,
        p_refresh_exp: sealed.refreshExp,
      });
      deps.log.info("clover_token_refreshed", { restaurant_id: restaurantId });
      return {
        token: tokens.accessToken, merchantId: current.merchant_id, baseUrl: CLOVER_HOSTS[current.environment].api,
        failing: (current.auth_failures ?? 0) > 0,
      };
    } catch (error) {
      const kind = error instanceof CloverError ? error.kind : "unavailable";
      deps.log.error("clover_token_refresh_failed", { restaurant_id: restaurantId, kind });
      if (kind === "bad_request" || kind === "invalid_response") {
        // Clover refused the refresh token. Only the owner re-authorising can fix this.
        await deps.db.rpc("clover_mark_needs_reauth", { p_restaurant: restaurantId, p_error_code: "refresh_rejected" });
        throw new CloverError("needs_reauth", "Clover refused the refresh token");
      }
      await deps.db.rpc("clover_refresh_release", { p_restaurant: restaurantId });
      throw error;
    }
  }
  throw new CloverError("unavailable", "Timed out waiting for a Clover token refresh");
}

// Clover has rejected the same request twice. That is one failed attempt: it is counted,
// and the connection is marked as needing a new token only when the count and the time say
// Clover means it. Returns the error to throw. No token is logged: only how many attempts.
async function unauthorizedAgain(deps: Deps, restaurantId: string, correlationId: string): Promise<CloverError> {
  let outcome: { failures: number; needs_reauth: boolean } | null = null;
  try {
    outcome = await deps.db.rpc<{ failures: number; needs_reauth: boolean } | null>("clover_auth_failed", {
      p_restaurant: restaurantId, p_threshold: AUTH_FAILURES_BEFORE_REAUTH, p_min_seconds: AUTH_FAILING_SECONDS_BEFORE_REAUTH,
    });
  } catch (error) {
    // The rejection could not be counted. It is still only one failed attempt.
    deps.log.error("clover_auth_failure_not_recorded", { restaurant_id: restaurantId, error_message: String(error) });
  }
  if (outcome?.needs_reauth) {
    deps.log.error("clover_token_rejected", { restaurant_id: restaurantId, correlation_id: correlationId, consecutive_failures: outcome.failures });
    return new CloverError("needs_reauth", "Clover kept rejecting the token", { status: 401 });
  }
  deps.log.warn("clover_unauthorized", {
    restaurant_id: restaurantId, correlation_id: correlationId, consecutive_failures: outcome?.failures ?? null,
    marks_after: AUTH_FAILURES_BEFORE_REAUTH, over_seconds: AUTH_FAILING_SECONDS_BEFORE_REAUTH,
  });
  return new CloverError("unauthorized", "Clover rejected the access token", { status: 401 });
}

// An API handle bound to one restaurant.
//
// A 401 leads to one repeat of that single request: with a refreshed token where there is
// one to refresh, otherwise with the same token after a short wait. Clover did not process
// a request it answered with 401, so repeating it cannot duplicate a write. A second 401
// is a failed attempt (see unauthorizedAgain); the first request Clover accepts afterwards
// clears the count.
export async function openClover(deps: Deps, restaurantId: string, correlationId: string): Promise<CloverApi> {
  let credentials = await getCredentials(deps, restaurantId, null);
  let failing = credentials.failing;
  const accepted = async () => {
    if (!failing) return;
    failing = false;
    await deps.db.rpc("clover_auth_ok", { p_restaurant: restaurantId })
      .catch((error) => deps.log.error("clover_auth_ok_not_recorded", { restaurant_id: restaurantId, error_message: String(error) }));
    deps.log.info("clover_accepted_again", { restaurant_id: restaurantId, correlation_id: correlationId });
  };
  return {
    merchantId: credentials.merchantId,
    async request(call: CloverCall) {
      let result: unknown;
      try {
        result = await cloverFetch(deps, credentials.baseUrl, credentials.token, call, correlationId);
      } catch (error) {
        if (!(error instanceof CloverError) || error.kind !== "unauthorized") throw error;
        // Throws "needs_reauth" by itself when Clover refuses to refresh an OAuth token:
        // that is Clover saying outright that the authorisation is gone.
        credentials = await getCredentials(deps, restaurantId, credentials.token);
        if (credentials.sameToken) await deps.sleep(UNAUTHORIZED_RETRY_WAIT_MS);
        try {
          result = await cloverFetch(deps, credentials.baseUrl, credentials.token, call, correlationId);
        } catch (again) {
          if (!(again instanceof CloverError) || again.kind !== "unauthorized") throw again;
          failing = true;
          throw await unauthorizedAgain(deps, restaurantId, correlationId);
        }
      }
      await accepted();
      return result;
    },
  };
}
