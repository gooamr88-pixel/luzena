// POST /clover-webhook
// Clover notifies this endpoint when inventory changes. The notification carries only ids,
// so it is used purely as a signal to re-sync from the API.
import { timingSafeEqual } from "../crypto.ts";
import { json, readBytes } from "../http.ts";
import { errorFields } from "../log.ts";
import { runSync } from "../sync.ts";
import type { Deps } from "../types.ts";

// I = item, IC = category, IG = modifier group, IM = modifier (Clover webhook event keys).
const INVENTORY_KEYS = ["I", "IC", "IG", "IM"];
const MAX_BODY_BYTES = 256 * 1024;
const MAX_VERIFICATIONS_PER_HOUR = 5;

export async function handleCloverWebhook(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });

  // This endpoint is open to the internet. The body is read under a cap on the bytes that
  // actually arrive, before anything is known about who is sending it.
  class TooLarge extends Error {}
  let raw: Uint8Array;
  try {
    raw = await readBytes(request, MAX_BODY_BYTES, () => new TooLarge());
  } catch (error) {
    if (error instanceof TooLarge) return json(413, { error: { code: "payload_too_large" } });
    return json(400, { error: { code: "invalid_json" } });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json(400, { error: { code: "invalid_json" } });
  }
  if (body === null || typeof body !== "object") return json(400, { error: { code: "invalid_json" } });

  // One-time setup: Clover posts a verification code that the operator pastes into the
  // Clover developer dashboard. It is written to the function log for that purpose. The
  // field name is chosen so the log redaction does not hide it.
  //
  // Clover sends this before it has told the operator the shared secret, so it cannot be
  // asked for one. Anyone can therefore send it; it changes nothing, and only a few an hour
  // are written down, so the log cannot be filled this way. The answer is the same either
  // way, and a failure to count is not a reason to lose Clover's own code.
  if (typeof body.verificationCode === "string") {
    const noted = await deps.db.rpc<boolean>("rate_limit_hit", {
      p_key: "webhook-verification", p_max: MAX_VERIFICATIONS_PER_HOUR, p_window_seconds: 3600,
    }).catch(() => true);
    if (noted) deps.log.info("clover_webhook_verification", { verification_value: body.verificationCode.slice(0, 80) });
    return json(200, { ok: true });
  }

  const expected = deps.env.clover?.webhookAuth ?? "";
  const provided = request.headers.get("x-clover-auth") ?? "";
  if (expected === "" || !(await timingSafeEqual(provided, expected))) {
    deps.log.warn("clover_webhook_rejected", { reason: expected === "" ? "not_configured" : "bad_auth" });
    return json(401, { error: { code: "unauthorized" } });
  }

  try {
    const merchants = body.merchants && typeof body.merchants === "object"
      ? (body.merchants as Record<string, unknown>)
      : {};
    for (const [merchantId, events] of Object.entries(merchants)) {
      if (!/^[A-Z0-9]{13}$/.test(merchantId) || !Array.isArray(events)) continue;
      const touchesInventory = events.some((event) => {
        const objectId = (event as { objectId?: unknown } | null)?.objectId;
        return typeof objectId === "string" && INVENTORY_KEYS.includes(objectId.split(":")[0]);
      });
      if (!touchesInventory) continue;

      const restaurants = await deps.db.rpc<string[]>("restaurants_by_merchant", { p_merchant_id: merchantId });
      for (const restaurantId of restaurants) {
        // Record the request first, so a sync that cannot start now (one is already
        // running) is picked up by the next public menu read.
        await deps.db.rpc("sync_request", { p_restaurant: restaurantId });
        deps.waitUntil(runSync(deps, restaurantId, "webhook"));
      }
    }
  } catch (error) {
    deps.log.error("clover_webhook_failed", errorFields(error));
  }
  // Always acknowledge an authenticated notification; Clover expects a 200.
  return json(200, { ok: true });
}
