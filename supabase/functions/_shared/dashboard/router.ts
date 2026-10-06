// The dashboard API. One Edge Function, one router. Every route runs, in this order:
// CORS -> authentication -> tenant resolution -> permission -> rate limit -> validation.
import { CloverError } from "../clover/errors.ts";
import { ApiError, corsHeaders, errorBody, json, newRequestId, preflight, readJson } from "../http.ts";
import { errorFields } from "../log.ts";
import { purgeExpiredApplications } from "../public/retention.ts";
import type { Deps, Session } from "../types.ts";
import { applicationsSummary, downloadCv, getApplication, listApplications, updateApplication } from "./applications.ts";
import {
  createCategoryHandler, createModifierGroupHandler, createModifierHandler, listCategoriesHandler,
  listModifierGroupsHandler, reorderCategories, reorderCategoryItems, updateCategoryHandler,
  updateModifierGroupHandler, updateModifierHandler,
} from "./catalog.ts";
import { completeConnect, connectionStatus, connectWithToken, disconnect, manualSync, startConnect } from "./connection.ts";
import { removeItemImage, uploadItemImage } from "./images.ts";
import { bulkItems, createItemHandler, DIETARY_TAGS, getItemDetail, listItems, updateItemHandler } from "./items.ts";
import { authenticate, cloverApiError, type Permission, permissionsOf, rateLimit, requirePermission } from "./session.ts";

const METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const ID = "([A-Z0-9]{13})";
// Applications are identified by a UUID, in lower case as the database prints it.
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

interface RouteContext {
  deps: Deps;
  session: Session;
  request: Request;
  url: URL;
  params: string[];
}

interface Route {
  method: string;
  pattern: RegExp;
  permission: Permission;
  // [bucket, max requests, window in seconds]. Limits are per user and generous enough
  // for a busy service; they exist to stop runaway scripts, not people.
  limit: [string, number, number];
  handle(context: RouteContext): Promise<Response>;
}

const READ: [string, number, number] = ["read", 600, 300];
const WRITE: [string, number, number] = ["write", 240, 300];
const body = (context: RouteContext) => readJson(context.request);

const ROUTES: Route[] = [
  {
    method: "GET", pattern: /^\/me$/, permission: "menu.read", limit: READ,
    handle: ({ session }) => Promise.resolve(json(200, {
      user: { email: session.user.email },
      restaurant: {
        id: session.restaurant.restaurant_id, name: session.restaurant.name,
        slug: session.restaurant.slug, currency: session.restaurant.currency,
      },
      role: session.restaurant.role,
      permissions: permissionsOf(session.restaurant.role),
      dietary_tags: DIETARY_TAGS,
    })),
  },
  {
    method: "GET", pattern: /^\/overview$/, permission: "menu.read", limit: READ,
    handle: async ({ deps, session }) => {
      // The overview is opened often, which makes it a dependable place to run the
      // retention clean-up when no new application has arrived for a while.
      deps.waitUntil(purgeExpiredApplications(deps));
      return json(200, await deps.db.rpc("dash_overview", { p_restaurant: session.restaurant.restaurant_id }));
    },
  },

  { method: "GET", pattern: /^\/items$/, permission: "menu.read", limit: READ,
    handle: ({ deps, session, url }) => listItems(deps, session, url) },
  { method: "POST", pattern: /^\/items$/, permission: "menu.write", limit: ["create", 120, 300],
    handle: async (c) => createItemHandler(c.deps, c.session, c.request, await body(c)) },
  { method: "POST", pattern: /^\/items\/bulk$/, permission: "menu.write", limit: ["bulk", 30, 300],
    handle: async (c) => bulkItems(c.deps, c.session, await body(c)) },
  { method: "GET", pattern: new RegExp(`^/items/${ID}$`), permission: "menu.read", limit: READ,
    handle: ({ deps, session, params }) => getItemDetail(deps, session, params[0]) },
  { method: "PATCH", pattern: new RegExp(`^/items/${ID}$`), permission: "menu.write", limit: WRITE,
    handle: async (c) => updateItemHandler(c.deps, c.session, c.params[0], await body(c)) },
  { method: "POST", pattern: new RegExp(`^/items/${ID}/image$`), permission: "menu.write", limit: ["upload", 60, 600],
    handle: ({ deps, session, params, request }) => uploadItemImage(deps, session, params[0], request) },
  { method: "DELETE", pattern: new RegExp(`^/items/${ID}/image$`), permission: "menu.write", limit: WRITE,
    handle: ({ deps, session, params }) => removeItemImage(deps, session, params[0]) },

  { method: "GET", pattern: /^\/categories$/, permission: "menu.read", limit: READ,
    handle: ({ deps, session }) => listCategoriesHandler(deps, session) },
  { method: "POST", pattern: /^\/categories$/, permission: "menu.write", limit: ["create", 120, 300],
    handle: async (c) => createCategoryHandler(c.deps, c.session, c.request, await body(c)) },
  { method: "POST", pattern: /^\/categories\/reorder$/, permission: "menu.write", limit: ["bulk", 30, 300],
    handle: async (c) => reorderCategories(c.deps, c.session, await body(c)) },
  { method: "PATCH", pattern: new RegExp(`^/categories/${ID}$`), permission: "menu.write", limit: WRITE,
    handle: async (c) => updateCategoryHandler(c.deps, c.session, c.params[0], await body(c)) },
  { method: "POST", pattern: new RegExp(`^/categories/${ID}/items/reorder$`), permission: "menu.write", limit: WRITE,
    handle: async (c) => reorderCategoryItems(c.deps, c.session, c.params[0], await body(c)) },

  { method: "GET", pattern: /^\/modifier-groups$/, permission: "menu.read", limit: READ,
    handle: ({ deps, session }) => listModifierGroupsHandler(deps, session) },
  { method: "POST", pattern: /^\/modifier-groups$/, permission: "menu.write", limit: ["create", 120, 300],
    handle: async (c) => createModifierGroupHandler(c.deps, c.session, c.request, await body(c)) },
  { method: "PATCH", pattern: new RegExp(`^/modifier-groups/${ID}$`), permission: "menu.write", limit: WRITE,
    handle: async (c) => updateModifierGroupHandler(c.deps, c.session, c.params[0], await body(c)) },
  { method: "POST", pattern: new RegExp(`^/modifier-groups/${ID}/modifiers$`), permission: "menu.write", limit: ["create", 120, 300],
    handle: async (c) => createModifierHandler(c.deps, c.session, c.request, c.params[0], await body(c)) },
  { method: "PATCH", pattern: new RegExp(`^/modifier-groups/${ID}/modifiers/${ID}$`), permission: "menu.write", limit: WRITE,
    handle: async (c) => updateModifierHandler(c.deps, c.session, c.params[0], c.params[1], await body(c)) },

  { method: "GET", pattern: /^\/clover$/, permission: "menu.read", limit: READ,
    handle: ({ deps, session }) => connectionStatus(deps, session) },
  { method: "POST", pattern: /^\/clover\/connect$/, permission: "clover.manage", limit: ["oauth", 10, 900],
    handle: ({ deps, session }) => startConnect(deps, session) },
  { method: "POST", pattern: /^\/clover\/complete$/, permission: "clover.manage", limit: ["oauth", 10, 900],
    handle: async (c) => completeConnect(c.deps, c.session, await body(c)) },
  { method: "POST", pattern: /^\/clover\/connect-token$/, permission: "clover.manage", limit: ["oauth", 10, 900],
    handle: async (c) => connectWithToken(c.deps, c.session, await body(c)) },
  { method: "POST", pattern: /^\/clover\/disconnect$/, permission: "clover.manage", limit: ["oauth", 10, 900],
    handle: ({ deps, session }) => disconnect(deps, session) },
  { method: "POST", pattern: /^\/clover\/sync$/, permission: "menu.write", limit: ["sync", 12, 300],
    handle: ({ deps, session }) => manualSync(deps, session) },

  { method: "GET", pattern: /^\/applications$/, permission: "applications.read", limit: READ,
    handle: ({ deps, session, url }) => listApplications(deps, session, url) },
  { method: "GET", pattern: /^\/applications\/summary$/, permission: "applications.read", limit: READ,
    handle: ({ deps, session }) => applicationsSummary(deps, session) },
  { method: "GET", pattern: new RegExp(`^/applications/${UUID}$`), permission: "applications.read", limit: READ,
    handle: ({ deps, session, params }) => getApplication(deps, session, params[0]) },
  { method: "PATCH", pattern: new RegExp(`^/applications/${UUID}$`), permission: "applications.manage", limit: WRITE,
    handle: async (c) => updateApplication(c.deps, c.session, c.params[0], await body(c)) },
  // A CV is a file with someone's personal details in it: fewer downloads than page views.
  { method: "GET", pattern: new RegExp(`^/applications/${UUID}/cv$`), permission: "applications.read", limit: ["download", 60, 300],
    handle: ({ deps, session, params }) => downloadCv(deps, session, params[0]) },

  {
    method: "GET", pattern: /^\/activity$/, permission: "activity.read", limit: READ,
    handle: async ({ deps, session, url }) => {
      const before = url.searchParams.get("before");
      if (before !== null && !/^\d{1,18}$/.test(before)) {
        throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { before: "is not valid" } });
      }
      return json(200, {
        entries: await deps.db.rpc("audit_list", {
          p_restaurant: session.restaurant.restaurant_id, p_limit: 30, p_before: before === null ? null : Number(before),
        }),
      });
    },
  },
];

// Everything after the function name: /functions/v1/dashboard-api/items/X -> /items/X
function routePath(url: URL): string {
  const marker = "/dashboard-api";
  const index = url.pathname.indexOf(marker);
  const path = index === -1 ? url.pathname : url.pathname.slice(index + marker.length);
  return path.replace(/\/+$/, "") || "/";
}

export async function handleDashboard(request: Request, deps: Deps): Promise<Response> {
  const requestId = newRequestId();
  const cors = corsHeaders(request, deps.env, METHODS);
  if (request.method === "OPTIONS") return preflight(request, deps.env, METHODS);

  const respond = (response: Response) => {
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    response.headers.set("x-request-id", requestId);
    return response;
  };

  try {
    const url = new URL(request.url);
    const path = routePath(url);
    const candidates = ROUTES.filter((route) => route.pattern.test(path));
    if (candidates.length === 0) throw new ApiError(404, "not_found", "Not found.");
    const route = candidates.find((candidate) => candidate.method === request.method);
    if (!route) throw new ApiError(405, "method_not_allowed", "Method not allowed.");

    const session = await authenticate(request, deps, requestId);
    requirePermission(session, route.permission);
    const [bucket, max, windowSeconds] = route.limit;
    await rateLimit(deps, `dash:${bucket}:${session.user.id}`, max, windowSeconds);

    const params = (path.match(route.pattern) ?? []).slice(1);
    return respond(await route.handle({ deps, session, request, url, params }));
  } catch (error) {
    let apiError: ApiError;
    if (error instanceof ApiError) {
      apiError = error;
    } else if (error instanceof CloverError) {
      // A Clover failure a handler did not classify. The honest answer is "unknown".
      apiError = cloverApiError(error, { cloverChanged: "unknown", localChanged: false });
    } else {
      deps.log.error("dashboard_unhandled_error", { request_id: requestId, ...errorFields(error) });
      // No claim is made about what changed: an unexpected failure can happen at any point.
      apiError = new ApiError(500, "internal_error", "Something went wrong. Refresh to see the current state, then try again.", {
        clover_changed: "unknown",
      });
    }
    if (apiError.status >= 500) {
      deps.log.error("dashboard_request_failed", { request_id: requestId, error_code: apiError.code, status: apiError.status });
    }
    return respond(json(apiError.status, errorBody(apiError, requestId)));
  }
}
