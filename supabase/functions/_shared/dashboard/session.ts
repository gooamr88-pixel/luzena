// Authentication, tenant resolution, authorisation, and helpers every dashboard handler uses.
import { CLOVER_MESSAGES, CloverError, RETRYABLE_KINDS } from "../clover/errors.ts";
import { sha256Hex } from "../crypto.ts";
import { ApiError, json } from "../http.ts";
import type { Deps, Membership, Role, Session } from "../types.ts";

export type Permission =
  | "menu.read" | "menu.write" | "clover.manage" | "activity.read"
  | "applications.read" | "applications.manage";

// Server-side role model. Only "owner" is assigned today; the other roles exist so adding
// staff later is a data change, not a code change. Job applications are personal data:
// the people who hire (owners and managers) may read them, staff may not.
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ["menu.read", "menu.write", "clover.manage", "activity.read", "applications.read", "applications.manage"],
  manager: ["menu.read", "menu.write", "activity.read", "applications.read", "applications.manage"],
  staff: ["menu.read"],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Identity comes from the verified JWT. The restaurant comes from the user's memberships in
// the database. The x-restaurant-id header only selects among restaurants the user already
// belongs to; it can never grant access.
export async function authenticate(request: Request, deps: Deps, requestId: string): Promise<Session> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new ApiError(401, "unauthenticated", "Sign in to continue.");

  const user = await deps.auth.getUser(token);
  if (!user) throw new ApiError(401, "unauthenticated", "Your session has expired. Sign in again.");

  const memberships = await deps.db.rpc<Membership[]>("user_memberships", { p_user: user.id });
  if (memberships.length === 0) {
    throw new ApiError(403, "no_restaurant", "This account is not linked to a restaurant.");
  }

  const requested = request.headers.get("x-restaurant-id");
  let restaurant: Membership | undefined;
  if (requested) {
    restaurant = UUID.test(requested) ? memberships.find((m) => m.restaurant_id === requested) : undefined;
    // Same answer whether the restaurant does not exist or belongs to someone else.
    if (!restaurant) throw new ApiError(403, "forbidden", "You do not have access to this restaurant.");
  } else if (memberships.length === 1) {
    restaurant = memberships[0];
  } else {
    throw new ApiError(400, "restaurant_required", "Choose a restaurant.", {
      restaurants: memberships.map((m) => ({ id: m.restaurant_id, name: m.name })),
    });
  }

  return { user, restaurant, requestId };
}

export function requirePermission(session: Session, permission: Permission): void {
  if (!ROLE_PERMISSIONS[session.restaurant.role]?.includes(permission)) {
    throw new ApiError(403, "forbidden", "Your role does not allow this action.");
  }
}

export const permissionsOf = (role: Role): Permission[] => ROLE_PERMISSIONS[role] ?? [];

export async function rateLimit(deps: Deps, key: string, max: number, windowSeconds: number): Promise<void> {
  const allowed = await deps.db.rpc<boolean>("rate_limit_hit", {
    p_key: key, p_max: max, p_window_seconds: windowSeconds,
  });
  if (!allowed) {
    throw new ApiError(429, "rate_limited", "Too many requests. Wait a moment and try again.", { retryable: true });
  }
}

export type AuditResult = "success" | "failed" | "partial" | "conflict";

// Audit writes never fail a request: the owner's change has already happened by the time
// this runs. A failed audit write is logged so it can be noticed.
export async function audit(
  deps: Deps,
  session: Session,
  entry: {
    action: string;
    entityType: string;
    entityId?: string | null;
    oldValues?: unknown;
    newValues?: unknown;
    result: AuditResult;
    syncStatus?: string | null;
  },
): Promise<void> {
  try {
    await deps.db.rpc("audit_write", {
      p_restaurant: session.restaurant.restaurant_id,
      p_user: session.user.id,
      p_actor_email: session.user.email,
      p_action: entry.action,
      p_entity_type: entry.entityType,
      p_entity_id: entry.entityId ?? null,
      p_old: entry.oldValues ?? null,
      p_new: entry.newValues ?? null,
      p_result: entry.result,
      p_sync_status: entry.syncStatus ?? null,
      p_request_id: session.requestId,
    });
  } catch (error) {
    deps.log.error("audit_write_failed", { action: entry.action, error_message: String(error) });
  }
}

// What the dashboard needs to explain a Clover failure honestly:
//   clover_changed  false | true | "unknown"
//   local_changed   whether anything was saved in this system
//   retryable       whether pressing Retry can help
export function cloverApiError(
  error: unknown,
  state: { cloverChanged: boolean | "unknown"; localChanged: boolean },
): ApiError {
  if (!(error instanceof CloverError)) throw error;
  const status =
    error.kind === "not_connected" || error.kind === "needs_reauth" ? 409
    : error.kind === "not_configured" ? 503
    : error.kind === "timeout" ? 504
    : 502;
  return new ApiError(status, `clover_${error.kind}`, CLOVER_MESSAGES[error.kind], {
    clover_changed: state.cloverChanged,
    local_changed: state.localChanged,
    retryable: RETRYABLE_KINDS.includes(error.kind),
  });
}

export interface IdempotentOutcome {
  status: number;
  body: unknown;
}

// Wraps a create. The client sends an Idempotency-Key and reuses it when it retries.
//   - A finished request is replayed from storage: no second Clover call.
//   - After an unknown outcome, `run` receives the time of the first attempt so it can look
//     in Clover for what that attempt may have created before creating anything.
export async function idempotent(
  deps: Deps,
  session: Session,
  request: Request,
  scope: string,
  payload: unknown,
  run: (reconcileSince: number | null) => Promise<IdempotentOutcome>,
): Promise<Response> {
  const key = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
    throw new ApiError(400, "idempotency_key_required", "This request needs an Idempotency-Key header.");
  }
  const restaurantId = session.restaurant.restaurant_id;
  const hash = await sha256Hex(`${scope}:${JSON.stringify(payload)}`);
  const begin = await deps.db.rpc<{ state: string; since?: string; response_status?: number; response_body?: unknown }>(
    "idem_begin",
    { p_restaurant: restaurantId, p_key: key, p_hash: hash },
  );

  if (begin.state === "replay") return json(begin.response_status ?? 200, begin.response_body);
  if (begin.state === "in_progress") {
    throw new ApiError(409, "request_in_progress", "This request is still being processed.", { retryable: true });
  }
  if (begin.state === "mismatch") {
    throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was used for a different request.");
  }

  const finish = (status: string, outcome: IdempotentOutcome | null) =>
    deps.db.rpc("idem_finish", {
      p_restaurant: restaurantId, p_key: key, p_status: status,
      p_response_status: outcome?.status ?? null, p_response_body: outcome?.body ?? null,
    });

  try {
    const outcome = await run(begin.state === "reconcile" && begin.since ? Date.parse(begin.since) : null);
    await finish("completed", outcome);
    return json(outcome.status, outcome.body);
  } catch (error) {
    // Leave the key in a state where a retry re-checks Clover instead of blindly creating.
    await finish("unknown", null).catch(() => {});
    throw error;
  }
}

// Rejects ids that are not this restaurant's before any Clover call is made.
export async function assertOwned(
  deps: Deps,
  session: Session,
  kind: "item" | "category" | "modifier_group" | "modifier",
  ids: string[] | undefined,
  field: string,
): Promise<void> {
  if (!ids || ids.length === 0) return;
  const known = await deps.db.rpc<string[]>("menu_known_ids", {
    p_restaurant: session.restaurant.restaurant_id, p_kind: kind, p_ids: ids,
  });
  if (known.length !== new Set(ids).size) {
    throw new ApiError(422, "validation_failed", "Some fields need attention.", {
      fields: { [field]: "contains an entry that does not exist" },
    });
  }
}

export const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
