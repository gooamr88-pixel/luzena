// The dashboard API. One Edge Function, one router. Every route runs, in this order:
// CORS -> authentication -> tenant resolution -> permission -> rate limit -> validation.
//
// Two routes stop after authentication, because the account calling them has no restaurant
// yet: seeing and accepting its own invitations (ACCOUNT_ROUTES). Nothing is reachable
// without a session that Supabase Auth vouches for.
import { CloverError } from "../clover/errors.ts";
import { ApiError, corsHeaders, errorBody, json, newRequestId, preflight, readJson } from "../http.ts";
import { errorFields } from "../log.ts";
import { purgeExpiredApplications } from "../public/retention.ts";
import type { AuthUser, Deps, Session } from "../types.ts";
import {
  applicationsSummary, deleteApplication, downloadCv, exportApplications, getApplication, listApplications, updateApplication,
} from "./applications.ts";
import {
  createCategoryHandler, createModifierGroupHandler, createModifierHandler, listCategoriesHandler,
  listModifierGroupsHandler, reorderCategories, reorderCategoryItems, updateCategoryHandler,
  updateModifierGroupHandler, updateModifierHandler,
} from "./catalog.ts";
import { completeConnect, connectionStatus, connectWithToken, disconnect, manualSync, startConnect } from "./connection.ts";
import { removeCategoryImage, removeItemImage, uploadCategoryImage, uploadItemImage } from "./images.ts";
import { bulkItems, createItemHandler, DIETARY_TAGS, getItemDetail, listItems, updateItemHandler } from "./items.ts";
import { createLabel, deleteLabel, getNotice, listLabels, reorderLabels, setNotice, updateLabel } from "./labels.ts";
import { retryApplicantMessage, sendApplicantMessage } from "./messages.ts";
import {
  authenticate, authenticateAccount, cloverApiError, hasPermission, type Permission, permissionsOf, rateLimit, requirePermission,
} from "./session.ts";
import { describeSitePhoto, listSitePhotos, removeSitePhoto, reorderGallery, uploadSitePhoto } from "./site-photos.ts";
import {
  acceptInvitation, cancelInvitation, changeMemberRole, inviteMember, listTeam, myInvitations, removeMember, resendInvitation,
} from "./team.ts";

const METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
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
// Invitations send email to someone outside the restaurant: few are ever needed.
const INVITE: [string, number, number] = ["invite", 20, 3600];
const body = (context: RouteContext) => readJson(context.request);

interface ActivityEntry {
  entity_type: string;
  entity_id: string | null;
  old_values: unknown;
  new_values: unknown;
}

// The activity log is open to managers, who do not manage the team. They see that someone
// was invited or removed, and by whom; not who it was. Those details are the owner's.
const TEAM_ENTITIES = ["team_member", "team_invitation"];
function visibleActivity<T extends ActivityEntry>(entries: T[], session: Session): T[] {
  if (hasPermission(session, "team.manage")) return entries;
  return entries.map((entry) => (TEAM_ENTITIES.includes(entry.entity_type)
    ? { ...entry, entity_id: null, old_values: null, new_values: null }
    : entry));
}

const ROUTES: Route[] = [
  {
    method: "GET", pattern: /^\/me$/, permission: "menu.read", limit: READ,
    handle: ({ deps, session }) => {
      // Opening the dashboard is noted on the membership (when, and the account's current
      // address), for the team page. After the answer: it never delays or fails a sign-in.
      deps.waitUntil(deps.db.rpc("team_member_seen", {
        p_restaurant: session.restaurant.restaurant_id, p_user: session.user.id, p_email: session.user.email,
      }));
      return Promise.resolve(json(200, {
        user: { email: session.user.email },
        restaurant: {
          id: session.restaurant.restaurant_id, name: session.restaurant.name,
          slug: session.restaurant.slug, currency: session.restaurant.currency,
        },
        role: session.restaurant.role,
        permissions: permissionsOf(session.restaurant.role),
        dietary_tags: DIETARY_TAGS,
      }));
    },
  },
  {
    method: "GET", pattern: /^\/overview$/, permission: "menu.read", limit: READ,
    handle: async ({ deps, session }) => {
      // The overview is opened often, which makes it a dependable place to run the
      // retention clean-up when no new application has arrived for a while.
      deps.waitUntil(purgeExpiredApplications(deps));
      const overview = await deps.db.rpc<{ recent_activity: ActivityEntry[] }>("dash_overview", { p_restaurant: session.restaurant.restaurant_id });
      // The overview carries the latest entries of the activity log. A role that may not
      // open the log is not given them here either.
      overview.recent_activity = hasPermission(session, "activity.read") ? visibleActivity(overview.recent_activity ?? [], session) : [];
      return json(200, overview);
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
  // A category's photo on the home page: one of the website's own photos, so it goes with
  // the permission for those.
  { method: "POST", pattern: new RegExp(`^/categories/${ID}/image$`), permission: "site.manage", limit: ["upload", 60, 600],
    handle: ({ deps, session, params, request }) => uploadCategoryImage(deps, session, params[0], request) },
  { method: "DELETE", pattern: new RegExp(`^/categories/${ID}/image$`), permission: "site.manage", limit: WRITE,
    handle: ({ deps, session, params }) => removeCategoryImage(deps, session, params[0]) },

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
  // Reading the merchant's inventory into the mirror. A permission of its own: it is not
  // the same decision as letting someone edit the menu or hold the connection.
  { method: "POST", pattern: /^\/clover\/sync$/, permission: "clover.sync", limit: ["sync", 12, 300],
    handle: ({ deps, session }) => manualSync(deps, session) },

  // Menu labels: the restaurant's own dietary and descriptive attributes. Anyone who can
  // see the menu can see them; changing them is changing the menu.
  { method: "GET", pattern: /^\/labels$/, permission: "menu.read", limit: READ,
    handle: ({ deps, session }) => listLabels(deps, session) },
  { method: "POST", pattern: /^\/labels$/, permission: "menu.write", limit: WRITE,
    handle: async (c) => createLabel(c.deps, c.session, await body(c)) },
  { method: "POST", pattern: /^\/labels\/reorder$/, permission: "menu.write", limit: WRITE,
    handle: async (c) => reorderLabels(c.deps, c.session, await body(c)) },
  { method: "PATCH", pattern: new RegExp(`^/labels/${UUID}$`), permission: "menu.write", limit: WRITE,
    handle: async (c) => updateLabel(c.deps, c.session, c.params[0], await body(c)) },
  { method: "DELETE", pattern: new RegExp(`^/labels/${UUID}$`), permission: "menu.write", limit: WRITE,
    handle: ({ deps, session, params }) => deleteLabel(deps, session, params[0]) },
  // The allergy notice at the foot of the public menu.
  { method: "GET", pattern: /^\/site\/notice$/, permission: "site.manage", limit: READ,
    handle: ({ deps, session }) => getNotice(deps, session) },
  { method: "PUT", pattern: /^\/site\/notice$/, permission: "site.manage", limit: WRITE,
    handle: async (c) => setNotice(c.deps, c.session, await body(c)) },

  // The website's own photos: hero, "our story", gallery.
  { method: "GET", pattern: /^\/site\/photos$/, permission: "site.manage", limit: READ,
    handle: ({ deps, session }) => listSitePhotos(deps, session) },
  { method: "POST", pattern: /^\/site\/photos$/, permission: "site.manage", limit: ["upload", 60, 600],
    handle: ({ deps, session, request }) => uploadSitePhoto(deps, session, request) },
  { method: "POST", pattern: /^\/site\/photos\/reorder$/, permission: "site.manage", limit: WRITE,
    handle: async (c) => reorderGallery(c.deps, c.session, await body(c)) },
  { method: "PATCH", pattern: new RegExp(`^/site/photos/${UUID}$`), permission: "site.manage", limit: WRITE,
    handle: async (c) => describeSitePhoto(c.deps, c.session, c.params[0], await body(c)) },
  { method: "DELETE", pattern: new RegExp(`^/site/photos/${UUID}$`), permission: "site.manage", limit: WRITE,
    handle: ({ deps, session, params }) => removeSitePhoto(deps, session, params[0]) },

  { method: "GET", pattern: /^\/applications$/, permission: "applications.read", limit: READ,
    handle: ({ deps, session, url }) => listApplications(deps, session, url) },
  { method: "GET", pattern: /^\/applications\/summary$/, permission: "applications.read", limit: READ,
    handle: ({ deps, session }) => applicationsSummary(deps, session) },
  { method: "GET", pattern: new RegExp(`^/applications/${UUID}$`), permission: "applications.read", limit: READ,
    handle: ({ deps, session, params }) => getApplication(deps, session, params[0]) },
  { method: "PATCH", pattern: new RegExp(`^/applications/${UUID}$`), permission: "applications.manage", limit: WRITE,
    handle: async (c) => updateApplication(c.deps, c.session, c.request, c.params[0], await body(c)) },
  { method: "DELETE", pattern: new RegExp(`^/applications/${UUID}$`), permission: "applications.manage", limit: WRITE,
    handle: ({ deps, session, params }) => deleteApplication(deps, session, params[0]) },
  // A CV is a file with someone's personal details in it: fewer downloads than page views,
  // and a permission of its own, so that reading the list never implies taking the file.
  { method: "GET", pattern: new RegExp(`^/applications/${UUID}/cv$`), permission: "applications.cv", limit: ["download", 60, 300],
    handle: ({ deps, session, params }) => downloadCv(deps, session, params[0]) },
  // Writing to the applicant. Each message is an email to someone outside the restaurant,
  // so they are counted on their own: sixty an hour is a busy day of hiring, not a mailing.
  { method: "POST", pattern: new RegExp(`^/applications/${UUID}/messages$`), permission: "applications.message", limit: ["message", 60, 3600],
    handle: async (c) => sendApplicantMessage(c.deps, c.session, c.request, c.params[0], await body(c)) },
  { method: "POST", pattern: new RegExp(`^/applications/${UUID}/messages/${UUID}/retry$`), permission: "applications.message", limit: ["message", 60, 3600],
    handle: ({ deps, session, request, params }) => retryApplicantMessage(deps, session, request, params[0], params[1]) },
  // Many applicants' details in one file. The owner's alone, and counted separately: the
  // first route only says how many an export would hold, the second hands them over.
  { method: "POST", pattern: /^\/applications\/export\/preview$/, permission: "applications.export", limit: READ,
    handle: async (c) => exportApplications(c.deps, c.session, await body(c), true) },
  { method: "POST", pattern: /^\/applications\/export$/, permission: "applications.export", limit: ["export", 30, 3600],
    handle: async (c) => exportApplications(c.deps, c.session, await body(c), false) },

  // Team and access: who may open this restaurant's dashboard, and as what.
  { method: "GET", pattern: /^\/team$/, permission: "team.manage", limit: READ,
    handle: ({ deps, session }) => listTeam(deps, session) },
  { method: "POST", pattern: /^\/team\/invitations$/, permission: "team.manage", limit: INVITE,
    handle: async (c) => inviteMember(c.deps, c.session, c.request, await body(c)) },
  { method: "POST", pattern: new RegExp(`^/team/invitations/${UUID}/resend$`), permission: "team.manage", limit: INVITE,
    handle: ({ deps, session, request, params }) => resendInvitation(deps, session, request, params[0]) },
  { method: "DELETE", pattern: new RegExp(`^/team/invitations/${UUID}$`), permission: "team.manage", limit: WRITE,
    handle: ({ deps, session, params }) => cancelInvitation(deps, session, params[0]) },
  { method: "PATCH", pattern: new RegExp(`^/team/members/${UUID}$`), permission: "team.manage", limit: WRITE,
    handle: async (c) => changeMemberRole(c.deps, c.session, c.params[0], await body(c)) },
  { method: "DELETE", pattern: new RegExp(`^/team/members/${UUID}$`), permission: "team.manage", limit: WRITE,
    handle: ({ deps, session, params }) => removeMember(deps, session, params[0]) },

  {
    method: "GET", pattern: /^\/activity$/, permission: "activity.read", limit: READ,
    handle: async ({ deps, session, url }) => {
      const before = url.searchParams.get("before");
      if (before !== null && !/^\d{1,18}$/.test(before)) {
        throw new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { before: "is not valid" } });
      }
      const entries = await deps.db.rpc<ActivityEntry[]>("audit_list", {
        p_restaurant: session.restaurant.restaurant_id, p_limit: 30, p_before: before === null ? null : Number(before),
      });
      return json(200, { entries: visibleActivity(entries, session) });
    },
  },
];

// What an account may do before it belongs to a restaurant: see the invitations waiting
// for its own address, and accept one. The account is verified exactly as for every other
// route (the session, and the second step where it is on); only the membership is not
// asked for, because making one is what these are for.
interface AccountRoute {
  method: string;
  pattern: RegExp;
  limit: [string, number, number];
  handle(context: { deps: Deps; user: AuthUser; params: string[]; requestId: string }): Promise<Response>;
}

const ACCOUNT_ROUTES: AccountRoute[] = [
  { method: "GET", pattern: /^\/account\/invitations$/, limit: ["account", 120, 300],
    handle: ({ deps, user }) => myInvitations(deps, user) },
  { method: "POST", pattern: new RegExp(`^/account/invitations/${UUID}/accept$`), limit: ["join", 20, 900],
    handle: ({ deps, user, params, requestId }) => acceptInvitation(deps, user, params[0], requestId) },
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

    const accountCandidates = ACCOUNT_ROUTES.filter((route) => route.pattern.test(path));
    if (accountCandidates.length > 0) {
      const accountRoute = accountCandidates.find((candidate) => candidate.method === request.method);
      if (!accountRoute) throw new ApiError(405, "method_not_allowed", "Method not allowed.");
      const user = await authenticateAccount(request, deps);
      const [bucket, max, windowSeconds] = accountRoute.limit;
      await rateLimit(deps, `dash:${bucket}:${user.id}`, max, windowSeconds);
      const params = (path.match(accountRoute.pattern) ?? []).slice(1);
      return respond(await accountRoute.handle({ deps, user, params, requestId }));
    }

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
