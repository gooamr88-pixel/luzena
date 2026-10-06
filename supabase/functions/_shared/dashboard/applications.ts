// Job applications in the dashboard: the list, one application in full, its status, its CV.
//
// Applications are personal data. Every route here needs a signed-in member of the
// restaurant with the applications permission (owners and managers; not staff), and every
// query is bound to that restaurant, so an id from another restaurant is simply not found.
// The CV never gets an address of its own: it is read from the private bucket and streamed
// through this API to the person who asked, and each download is recorded.
import { ApiError, json } from "../http.ts";
import { CV_BUCKET } from "../public/application.ts";
import { LABELS, STATUSES } from "../public/application-fields.ts";
import type { Deps, Session } from "../types.ts";
import { parseBody, v } from "../validate.ts";
import { audit } from "./session.ts";

const restaurantOf = (session: Session) => session.restaurant.restaurant_id;
const invalid = (name: string) =>
  new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { [name]: "is not valid" } });
const notFound = () => new ApiError(404, "not_found", "This application does not exist.");

// An instant such as 2026-10-06T07:00:00.000Z. The dashboard sends the start and the end of
// a day in the owner's own time zone, so "today" means the owner's today.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export async function listApplications(deps: Deps, session: Session, url: URL): Promise<Response> {
  const q = url.searchParams;
  const status = q.get("status") ?? "";
  if (status !== "" && !(STATUSES as readonly string[]).includes(status)) throw invalid("status");
  const instant = (name: string) => {
    const value = q.get(name) ?? "";
    if (value === "") return null;
    if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) throw invalid(name);
    return value;
  };
  const int = (name: string, fallback: number, max: number) => {
    const raw = q.get(name) ?? "";
    if (raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > max) throw invalid(name);
    return value;
  };

  return json(200, await deps.db.rpc("dash_applications_list", {
    p_restaurant: restaurantOf(session),
    p_search: (q.get("search") ?? "").slice(0, 100),
    p_status: status === "" ? null : status,
    p_position: (q.get("position") ?? "").slice(0, 100) || null,
    p_from: instant("from"),
    p_to: instant("to"),
    p_limit: int("limit", 25, 100),
    p_offset: int("offset", 0, 1_000_000),
  }));
}

export async function applicationsSummary(deps: Deps, session: Session): Promise<Response> {
  return json(200, await deps.db.rpc("dash_applications_summary", { p_restaurant: restaurantOf(session) }));
}

export async function getApplication(deps: Deps, session: Session, id: string): Promise<Response> {
  const application = await deps.db.rpc<unknown | null>("dash_application_get", {
    p_restaurant: restaurantOf(session), p_id: id,
  });
  if (!application) throw notFound();
  return json(200, { application });
}

const statusBody = v.object({
  status: v.oneOf(STATUSES),
  note: v.optional(v.nullable(v.string({ max: 500 }))),
});

export async function updateApplication(deps: Deps, session: Session, id: string, body: unknown): Promise<Response> {
  const { status, note } = parseBody(statusBody, body);
  const before = await deps.db.rpc<{ status: string } | null>("dash_application_get", {
    p_restaurant: restaurantOf(session), p_id: id,
  });
  if (!before) throw notFound();

  const application = await deps.db.rpc<{ status: string } | null>("dash_application_set_status", {
    p_restaurant: restaurantOf(session), p_id: id, p_status: status, p_note: note ?? null,
    p_actor_email: session.user.email,
  });
  if (!application) throw notFound();

  const changed = before.status !== status;
  if (changed) {
    // The audit log says that the status moved, not whose application it is: the activity
    // page is open to roles that may not read applications.
    await audit(deps, session, {
      action: "APPLICATION_STATUS_CHANGED", entityType: "application", entityId: id,
      oldValues: { status: before.status }, newValues: { status }, result: "success",
    });
  }
  return json(200, {
    result: "saved",
    application,
    message: changed ? `Status changed to ${LABELS.status[status]}.` : note ? "Note added." : "Nothing changed.",
  });
}

// Deletes one application for good, with its CV and its history: what the privacy policy
// promises an applicant who asks. The file goes first, as in the retention clean-up, so a
// file that cannot be removed leaves the application in place to be tried again and never
// a CV with nothing pointing at it.
export async function deleteApplication(deps: Deps, session: Session, id: string): Promise<Response> {
  const restaurant = restaurantOf(session);
  // Both lookups are bound to this restaurant, so the delete below can only ever be given
  // an id that is this restaurant's.
  const existing = await deps.db.rpc<{ status: string } | null>("dash_application_get", { p_restaurant: restaurant, p_id: id });
  if (!existing) throw notFound();
  const cv = await deps.db.rpc<{ path: string } | null>("dash_application_cv", { p_restaurant: restaurant, p_id: id });
  if (cv) {
    try {
      await deps.files.remove(CV_BUCKET, [cv.path]);
    } catch (error) {
      deps.log.error("application_cv_delete_failed", { application_id: id, error_message: String(error) });
      throw new ApiError(502, "delete_failed", "The CV could not be deleted, so the application was kept. Try again.", { retryable: true });
    }
  }
  await deps.db.rpc("job_applications_delete", { p_ids: [id] });
  await audit(deps, session, {
    action: "APPLICATION_DELETED", entityType: "application", entityId: id,
    oldValues: { status: existing.status, had_cv: cv !== null }, result: "success",
  });
  return json(200, { result: "deleted", message: "The application, its CV and its history have been deleted." });
}

export async function downloadCv(deps: Deps, session: Session, id: string): Promise<Response> {
  const cv = await deps.db.rpc<{ path: string; name: string | null; mime: string | null } | null>("dash_application_cv", {
    p_restaurant: restaurantOf(session), p_id: id,
  });
  if (!cv) throw new ApiError(404, "not_found", "This application has no CV.");

  const bytes = await deps.files.download(CV_BUCKET, cv.path);
  if (!bytes) {
    deps.log.error("application_cv_unreadable", { application_id: id });
    throw new ApiError(404, "cv_unavailable", "The CV could not be read. Try again; if it keeps failing, the file is no longer stored.");
  }

  await deps.db.rpc("dash_application_log_download", {
    p_restaurant: restaurantOf(session), p_id: id, p_actor_email: session.user.email,
  }).catch((error) => deps.log.error("application_download_log_failed", { error_message: String(error) }));
  await audit(deps, session, {
    action: "APPLICATION_CV_DOWNLOADED", entityType: "application", entityId: id, result: "success",
  });

  // The stored name was reduced to letters, digits, spaces, hyphens and underscores when the
  // file arrived, so it is safe inside the header as it is.
  const filename = (cv.name ?? "cv").replace(/[^A-Za-z0-9 ._-]/g, "") || "cv";
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": cv.mime ?? "application/octet-stream",
      "content-length": String(bytes.length),
      // Always a download, never shown in the page: a CV is a file from a stranger.
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
