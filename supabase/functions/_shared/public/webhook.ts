// POST /clover-webhook
// Clover notifies this endpoint when inventory changes. The notification carries only ids,
// so it is used purely as a signal to re-sync from the API.
import { timingSafeEqual } from "../crypto.ts";
import { json } from "../http.ts";
import { errorFields } from "../log.ts";
import { runSync } from "../sync.ts";
import type { Deps } from "../types.ts";

// I = item, IC = category, IG = modifier group, IM = modifier (Clover webhook event keys).
const INVENTORY_KEYS = ["I", "IC", "IG", "IM"];
const MAX_BODY_BYTES = 256 * 1024;

export async function handleCloverWebhook(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });

  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return json(413, { error: { code: "payload_too_large" } });
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
  if (typeof body.verificationCode === "string") {
    deps.log.info("clover_webhook_verification", { verification_value: body.verificationCode.slice(0, 80) });
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
