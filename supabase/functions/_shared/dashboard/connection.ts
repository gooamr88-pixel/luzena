// Clover connection: status, connect (OAuth), disconnect, manual sync.
import {
  buildAuthorizeUrl, cloverWithToken, exchangeCode, openClover, requireClover, sealApiToken, sealTokens,
} from "../clover/auth.ts";
import { CloverError } from "../clover/errors.ts";
import { getMerchant } from "../clover/inventory.ts";
import { randomToken, sha256Hex } from "../crypto.ts";
import { ApiError, json } from "../http.ts";
import { runSync } from "../sync.ts";
import type { Deps, Session } from "../types.ts";
import { parseBody, v } from "../validate.ts";
import { audit, cloverApiError } from "./session.ts";

const STATE_TTL_SECONDS = 600;
const restaurantOf = (session: Session) => session.restaurant.restaurant_id;

export async function connectionStatus(deps: Deps, session: Session): Promise<Response> {
  const status = await deps.db.rpc<Record<string, unknown>>("clover_connection_status", {
    p_restaurant: restaurantOf(session),
  });
  return json(200, {
    connection: status,
    // Whether the platform operator has set the Clover app credentials at all.
    configured: deps.env.clover !== null && deps.env.tokenEncryptionKey !== null,
    // Whether a merchant's own API token can be entered instead (no Clover app needed).
    token_connect: deps.env.cloverEnvironment !== null && deps.env.tokenEncryptionKey !== null,
  });
}

const tokenSchema = v.object({
  merchant_id: v.string({ min: 13, max: 13, pattern: /^[A-Z0-9]{13}$/ }),
  token: v.string({ min: 16, max: 200, pattern: /^[A-Za-z0-9._~-]+$/ }),
});

// Connects with an API token the merchant created in their own Clover dashboard
// (Settings > View all settings > API tokens), instead of OAuth. Clover's guidance for an
// integration that serves one merchant and is not a public app. No Clover app is involved.
//
// The token is the owner's to give: it is typed once into the dashboard, sent here over
// TLS with the owner's session, checked against Clover, and stored encrypted. It is never
// logged, never written to the audit log, and never sent back to a browser.
export async function connectWithToken(deps: Deps, session: Session, body: unknown): Promise<Response> {
  const input = parseBody(tokenSchema, body);
  const restaurantId = restaurantOf(session);
  const environment = deps.env.cloverEnvironment;
  const key = deps.env.tokenEncryptionKey;
  if (!environment || !key) {
    throw cloverApiError(new CloverError("not_configured", "CLOVER_ENV or the encryption key is not set"), {
      cloverChanged: false, localChanged: false,
    });
  }

  const reject = async (code: string, message: string) => {
    deps.log.warn("clover_token_connect_rejected", { restaurant_id: restaurantId, reason: code });
    await audit(deps, session, { action: "CLOVER_CONNECT_FAILED", entityType: "clover_connection", newValues: { reason: code, method: "api_token" }, result: "failed" });
    return new ApiError(400, code, message);
  };

  // Prove the token before keeping it: one read of the inventory it will be used for.
  const probe = cloverWithToken(deps, environment, input.merchant_id, input.token, session.requestId);
  try {
    await probe.request({ method: "GET", path: `/v3/merchants/${input.merchant_id}/items`, query: { limit: "1" }, retry: "read" });
  } catch (error) {
    const kind = error instanceof CloverError ? error.kind : "unknown";
    if (kind === "unauthorized" || kind === "not_found") {
      throw await reject("clover_token_rejected", "Clover did not accept this merchant ID and token. Check both and try again.");
    }
    if (kind === "forbidden") {
      throw await reject("clover_token_no_inventory", "This token cannot read the inventory. In Clover, create a token with Inventory read and write.");
    }
    deps.log.error("clover_token_probe_failed", { restaurant_id: restaurantId, kind });
    throw cloverApiError(error, { cloverChanged: false, localChanged: false });
  }

  const sealed = await sealApiToken(input.token, key);
  const saved = await deps.db.rpc<{ ok: boolean; reason?: string; merchant_changed?: boolean }>("clover_connection_save", {
    p_restaurant: restaurantId,
    p_user: session.user.id,
    p_merchant_id: input.merchant_id,
    p_merchant_name: null,
    p_environment: environment,
    p_access_enc: sealed.accessEnc,
    p_refresh_enc: sealed.refreshEnc,
    p_access_exp: sealed.accessExp,
    p_refresh_exp: sealed.refreshExp,
  });
  if (!saved.ok) {
    throw await reject("merchant_in_use", "This Clover merchant is already connected to another restaurant.");
  }

  await audit(deps, session, {
    action: "CLOVER_CONNECTED", entityType: "clover_connection", entityId: input.merchant_id,
    newValues: { merchant_id: input.merchant_id, environment, method: "api_token", merchant_changed: saved.merchant_changed },
    result: "success",
  });

  deps.waitUntil((async () => {
    try {
      const api = await openClover(deps, restaurantId, session.requestId);
      const merchant = (await getMerchant(api)) as { name?: unknown } | null;
      if (merchant && typeof merchant.name === "string") {
        await deps.db.rpc("clover_set_merchant_name", { p_restaurant: restaurantId, p_name: merchant.name.slice(0, 120) });
      }
    } catch {
      // Name stays unknown: the token may not have the Merchant read permission.
    }
    await runSync(deps, restaurantId, "connect");
  })());

  return json(200, {
    result: "connected",
    connection: await deps.db.rpc("clover_connection_status", { p_restaurant: restaurantId }),
    message: "Clover connected. The menu is being imported. Imported items stay hidden from the website until you show them.",
  });
}

// Step 1. Creates a one-time nonce, stores only its hash bound to this user and restaurant,
// and returns the Clover authorize URL. The dashboard keeps the nonce in sessionStorage and
// sends the owner to Clover.
export async function startConnect(deps: Deps, session: Session): Promise<Response> {
  let config;
  try {
    config = requireClover(deps.env);
  } catch (error) {
    throw cloverApiError(error, { cloverChanged: false, localChanged: false });
  }
  const nonce = randomToken(32);
  await deps.db.rpc("oauth_state_create", {
    p_restaurant: restaurantOf(session),
    p_user: session.user.id,
    p_nonce_hash: await sha256Hex(nonce),
    p_ttl_seconds: STATE_TTL_SECONDS,
  });
  return json(200, { authorize_url: buildAuthorizeUrl(config.clover, nonce), nonce });
}

const completeSchema = v.object({
  code: v.string({ min: 1, max: 500 }),
  merchant_id: v.string({ min: 13, max: 13, pattern: /^[A-Z0-9]{13}$/ }),
  // `nonce` is what this browser stored at step 1. `state` is what Clover sent back.
  nonce: v.string({ min: 20, max: 200 }),
  state: v.optional(v.nullable(v.string({ max: 200 }))),
  client_id: v.optional(v.nullable(v.string({ max: 100 }))),
});

// Step 2. Clover redirected the owner back to the dashboard with ?code and ?merchant_id.
// The dashboard posts them here with the owner's session.
//
// Protection against a forged callback (an attacker trying to attach THEIR Clover merchant
// to the victim's restaurant):
//   1. The caller must be signed in as an owner of the restaurant.
//   2. The nonce must match an unexpired, unused attempt started by this same user for this
//      same restaurant, and it is consumed here, so a callback URL cannot be replayed.
//   3. If Clover returned `state`, it must equal the nonce.
//   4. If Clover did not return `state`, the request is refused unless the operator has set
//      CLOVER_REQUIRE_STATE=false. Clover's v2 guides do not document `state`, so whether it
//      is echoed has to be confirmed in the sandbox first (see CLOVER_INTEGRATION.md).
export async function completeConnect(deps: Deps, session: Session, body: unknown): Promise<Response> {
  const input = parseBody(completeSchema, body);
  const restaurantId = restaurantOf(session);
  let config;
  try {
    config = requireClover(deps.env);
  } catch (error) {
    throw cloverApiError(error, { cloverChanged: false, localChanged: false });
  }

  const reject = async (code: string, message: string) => {
    deps.log.warn("clover_oauth_rejected", { restaurant_id: restaurantId, reason: code });
    await audit(deps, session, { action: "CLOVER_CONNECT_FAILED", entityType: "clover_connection", newValues: { reason: code }, result: "failed" });
    return new ApiError(400, code, message);
  };

  if (input.client_id && input.client_id !== config.clover.appId) {
    throw await reject("oauth_client_mismatch", "This Clover authorisation was issued for a different app.");
  }
  const stateReturned = typeof input.state === "string" && input.state !== "";
  if (stateReturned && input.state !== input.nonce) {
    throw await reject("oauth_state_mismatch", "The Clover authorisation could not be verified. Start the connection again.");
  }
  if (!stateReturned && config.clover.requireState) {
    throw await reject("oauth_state_missing", "Clover did not return the verification value. Start the connection again.");
  }
  const consumed = await deps.db.rpc<boolean>("oauth_state_consume", {
    p_restaurant: restaurantId, p_user: session.user.id, p_nonce_hash: await sha256Hex(input.nonce),
  });
  if (!consumed) {
    throw await reject("oauth_state_invalid", "This connection attempt has expired. Start the connection again.");
  }

  let tokens;
  try {
    tokens = await exchangeCode(deps, input.code);
  } catch (error) {
    deps.log.error("clover_oauth_exchange_failed", { restaurant_id: restaurantId, kind: error instanceof CloverError ? error.kind : "unknown" });
    await audit(deps, session, { action: "CLOVER_CONNECT_FAILED", entityType: "clover_connection", newValues: { reason: "exchange_failed" }, result: "failed" });
    throw new ApiError(502, "oauth_exchange_failed", "Clover did not complete the authorisation. Start the connection again.", { retryable: false });
  }

  const sealed = await sealTokens(tokens, config.key);
  const saved = await deps.db.rpc<{ ok: boolean; reason?: string; merchant_changed?: boolean }>("clover_connection_save", {
    p_restaurant: restaurantId,
    p_user: session.user.id,
    p_merchant_id: input.merchant_id,
    p_merchant_name: null,
    p_environment: config.clover.environment,
    p_access_enc: sealed.accessEnc,
    p_refresh_enc: sealed.refreshEnc,
    p_access_exp: sealed.accessExp,
    p_refresh_exp: sealed.refreshExp,
  });
  if (!saved.ok) {
    throw await reject("merchant_in_use", "This Clover merchant is already connected to another restaurant.");
  }

  await audit(deps, session, {
    action: "CLOVER_CONNECTED", entityType: "clover_connection", entityId: input.merchant_id,
    newValues: { merchant_id: input.merchant_id, environment: config.clover.environment, merchant_changed: saved.merchant_changed },
    result: "success",
  });

  // The merchant's name is cosmetic and needs a permission the app may not have.
  deps.waitUntil((async () => {
    try {
      const api = await openClover(deps, restaurantId, session.requestId);
      const merchant = (await getMerchant(api)) as { name?: unknown } | null;
      if (merchant && typeof merchant.name === "string") {
        await deps.db.rpc("clover_set_merchant_name", {
          p_restaurant: restaurantId, p_name: merchant.name.slice(0, 120),
        });
      }
    } catch {
      // Name stays unknown.
    }
    await runSync(deps, restaurantId, "connect");
  })());

  return json(200, {
    result: "connected",
    connection: await deps.db.rpc("clover_connection_status", { p_restaurant: restaurantId }),
    message: "Clover connected. The menu is being imported. Imported items stay hidden from the website until you show them.",
  });
}

// Deletes the stored tokens. The mirrored menu and all website data stay; the public menu
// keeps showing the last synced state. The Clover app itself stays installed on the
// merchant until the merchant removes it in Clover.
export async function disconnect(deps: Deps, session: Session): Promise<Response> {
  const restaurantId = restaurantOf(session);
  const removed = await deps.db.rpc<boolean>("clover_disconnect", { p_restaurant: restaurantId });
  await audit(deps, session, { action: "CLOVER_DISCONNECTED", entityType: "clover_connection", result: "success" });
  return json(200, {
    result: removed ? "disconnected" : "not_connected",
    connection: await deps.db.rpc("clover_connection_status", { p_restaurant: restaurantId }),
    message: "Clover disconnected. The website keeps showing the last synced menu.",
  });
}

export async function manualSync(deps: Deps, session: Session): Promise<Response> {
  const restaurantId = restaurantOf(session);
  await audit(deps, session, { action: "SYNC_STARTED", entityType: "sync", result: "success", syncStatus: "SYNCING" });
  const result = await runSync(deps, restaurantId, "manual");
  const connection = await deps.db.rpc("clover_connection_status", { p_restaurant: restaurantId });

  if (result.status === "succeeded") {
    await audit(deps, session, { action: "SYNC_COMPLETED", entityType: "sync", newValues: result.stats, result: "success", syncStatus: "SYNCED" });
    return json(200, { result: "synced", stats: result.stats, connection, message: "Menu synchronised with Clover." });
  }
  if (result.status === "busy") {
    return json(200, { result: "syncing", connection, message: "A synchronisation is already running." });
  }
  if (result.status === "not_connected") {
    throw new ApiError(409, "clover_not_connected", "Connect Clover before synchronising.", { retryable: false });
  }
  await audit(deps, session, { action: "SYNC_FAILED", entityType: "sync", newValues: { error_code: result.error_code }, result: "failed", syncStatus: "FAILED" });
  throw new ApiError(502, result.error_code, "Synchronisation failed. The website still shows the last synced menu.", {
    retryable: true, connection, clover_changed: false, local_changed: false,
  });
}
