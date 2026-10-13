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
import { parseBody, uuid, v } from "../validate.ts";
import { applicationMessages, notifyStatusChange, statusEmail, statusEmails } from "./messages.ts";
import { audit, auditRequired, hasPermission, rateLimit, requirePermission } from "./session.ts";

const restaurantOf = (session: Session) => session.restaurant.restaurant_id;
const invalid = (name: string) =>
  new ApiError(422, "validation_failed", "Some fields need attention.", { fields: { [name]: "is not valid" } });
const notFound = () => new ApiError(404, "not_found", "This application does not exist.");

// An instant such as 2026-10-06T07:00:00.000Z. The dashboard sends the start and the end of
// a day in the owner's own time zone, so "today" means the owner's today.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// The filters of the list, checked. The list reads them from its address and the export
// from its body, and both hand them to the same definition in the database
// (_applications_matching), so a filter means one thing wherever it is used.
function readFilters(get: (name: string) => string) {
  const status = get("status");
  if (status !== "" && !(STATUSES as readonly string[]).includes(status)) throw invalid("status");
  const instant = (name: string) => {
    const value = get(name);
    if (value === "") return null;
    if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) throw invalid(name);
    return value;
  };
  return {
    p_search: get("search").slice(0, 100),
    p_status: status === "" ? null : status,
    p_position: get("position").slice(0, 100) || null,
    p_from: instant("from"),
    p_to: instant("to"),
  };
}

export async function listApplications(deps: Deps, session: Session, url: URL): Promise<Response> {
  const q = url.searchParams;
  const int = (name: string, fallback: number, max: number) => {
    const raw = q.get(name) ?? "";
    if (raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > max) throw invalid(name);
    return value;
  };

  return json(200, await deps.db.rpc("dash_applications_list", {
    p_restaurant: restaurantOf(session),
    ...readFilters((name) => q.get(name) ?? ""),
    p_limit: int("limit", 25, 100),
    p_offset: int("offset", 0, 1_000_000),
  }));
}

// ---------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------

// The most applications one file may hold. Far above what a restaurant collects inside its
// retention period; a ceiling on what one request can take, not a working limit.
export const MAX_EXPORT_ROWS = 5000;
// The most applications that can be named one by one in a request.
const MAX_SELECTED = 1000;

const exportBody = v.object({
  // all       every application of this restaurant
  // filtered  those matching `filters`, on every page of the list
  // selected  those named in `ids`: the ticked rows, or the rows of the page on screen
  scope: v.oneOf(["all", "filtered", "selected"]),
  format: v.optional(v.oneOf(["xlsx", "csv"])),
  filters: v.optional(v.object({
    search: v.optional(v.string({ max: 100 })),
    status: v.optional(v.string({ max: 20 })),
    position: v.optional(v.string({ max: 100 })),
    from: v.optional(v.string({ max: 30 })),
    to: v.optional(v.string({ max: 30 })),
  })),
  ids: v.optional(v.array(uuid, { min: 1, max: MAX_SELECTED, unique: true })),
});

// The applications a signed-in owner asked to export, as data: the dashboard lays them out
// as an Excel workbook or a CSV file in the browser. With `countOnly` nothing but the number
// is returned, which is what the export dialog shows before anything is generated.
//
// An export is the list in a file: the main facts of each application (name, position,
// experience, date, CV or not, stage), as the client decided on 2026-10-13. Contact details
// and the applicant's own words are not in it, and the database function does not read
// them for it, so they cannot end up in a file by mistake.
//
// What decides which applications these are:
//   - the restaurant is the caller's own, from their membership. Nothing in the request
//     names one, and an id in `ids` is looked for only inside that restaurant: another
//     restaurant's id finds nothing, exactly like an id that does not exist.
//   - the permission (applications.export) and the membership were checked by the router on
//     this very request, so an account whose access has been taken away gets nothing.
//   - one database statement reads the rows and counts them, so the file cannot be half of
//     one moment and half of another.
export async function exportApplications(deps: Deps, session: Session, body: unknown, countOnly: boolean): Promise<Response> {
  const request = parseBody(exportBody, body);
  // Each scope takes exactly what it needs. Anything else would leave it unclear what was
  // being asked for, so it is refused rather than ignored.
  if (request.scope === "selected" ? !request.ids : request.ids !== undefined) throw invalid("ids");
  if (request.scope !== "filtered" && request.filters !== undefined) throw invalid("filters");

  const given = request.filters ?? {};
  const filters = readFilters((name) => given[name as keyof typeof given] ?? "");
  const result = await deps.db.rpc<{ count: number; applications: unknown[] | null }>("dash_applications_export", {
    p_restaurant: restaurantOf(session),
    ...filters,
    p_ids: request.ids ?? null,
    p_limit: MAX_EXPORT_ROWS,
    p_count_only: countOnly,
  });
  const requested = request.ids?.length ?? null;

  if (countOnly) {
    return json(200, { count: result.count, requested, limit: MAX_EXPORT_ROWS, exportable: result.count <= MAX_EXPORT_ROWS });
  }
  if (result.applications === null) {
    throw new ApiError(422, "export_too_large",
      `This export would hold ${result.count} applications, and one file holds ${MAX_EXPORT_ROWS} at most. Narrow the filters and export in parts.`,
      { count: result.count, limit: MAX_EXPORT_ROWS });
  }

  // The record first, the data second: if it cannot be written that an export was taken,
  // none is. It says how many and by which filters, never whose: no name, no address, and
  // not what was typed in the search box, which is usually someone's name.
  const format = request.format ?? "xlsx";
  try {
    await auditRequired(deps, session, {
      action: "APPLICATIONS_EXPORTED", entityType: "application_export",
      newValues: {
        format, scope: request.scope, count: result.count,
        filters: request.scope === "filtered"
          ? { search: filters.p_search !== "", status: filters.p_status, position: filters.p_position, from: filters.p_from, to: filters.p_to }
          : null,
      },
      result: "success",
    });
  } catch (error) {
    deps.log.error("application_export_not_recorded", { request_id: session.requestId, error_message: String(error) });
    throw new ApiError(503, "export_unavailable", "The export could not be recorded, so nothing was exported. Try again.", { retryable: true });
  }
  deps.log.info("applications_exported", { request_id: session.requestId, scope: request.scope, format, count: result.count });

  return json(200, {
    result: "exported",
    count: result.count,
    requested,
    scope: request.scope,
    generated_at: new Date(deps.now()).toISOString(),
    restaurant: { name: session.restaurant.name, slug: session.restaurant.slug },
    applications: result.applications,
  });
}

export async function applicationsSummary(deps: Deps, session: Session): Promise<Response> {
  return json(200, await deps.db.rpc("dash_applications_summary", { p_restaurant: restaurantOf(session) }));
}

interface ApplicationRow {
  status: string;
  full_name: string;
  position: string;
}

// One application as its page shows it: the record, what has been written to the applicant
// from here (with what became of each message), and, for someone who may write to them, the
// email each status would send.
async function applicationPage(deps: Deps, session: Session, id: string, application: ApplicationRow) {
  return {
    ...application,
    messages: await applicationMessages(deps, session, id),
    ...(hasPermission(session, "applications.message") ? { status_emails: statusEmails(application, session.restaurant.name) } : {}),
  };
}

export async function getApplication(deps: Deps, session: Session, id: string): Promise<Response> {
  const application = await deps.db.rpc<ApplicationRow | null>("dash_application_get", {
    p_restaurant: restaurantOf(session), p_id: id,
  });
  if (!application) throw notFound();
  return json(200, { application: await applicationPage(deps, session, id, application) });
}

const statusBody = v.object({
  status: v.oneOf(STATUSES),
  note: v.optional(v.nullable(v.string({ max: 500 }))),
  // Tell the applicant about the new status by email. Only acted on when the status
  // actually changes and that status has an email; the words are the server's own.
  notify_applicant: v.optional(v.bool()),
});

export async function updateApplication(deps: Deps, session: Session, request: Request, id: string, body: unknown): Promise<Response> {
  const { status, note, notify_applicant: notify } = parseBody(statusBody, body);
  const before = await deps.db.rpc<ApplicationRow | null>("dash_application_get", {
    p_restaurant: restaurantOf(session), p_id: id,
  });
  if (!before) throw notFound();
  const changed = before.status !== status;
  const emails = notify === true && changed && statusEmail(status, before, session.restaurant.name) !== null;
  if (emails) {
    // Writing to an applicant is a permission of its own, and it shares the hourly budget of
    // the messages written by hand. Both are checked before anything is changed.
    requirePermission(session, "applications.message");
    await rateLimit(deps, `dash:message:${session.user.id}`, 60, 3600);
  }

  const application = await deps.db.rpc<ApplicationRow | null>("dash_application_set_status", {
    p_restaurant: restaurantOf(session), p_id: id, p_status: status, p_note: note ?? null,
    p_actor_email: session.user.email,
  });
  if (!application) throw notFound();

  if (changed) {
    // The audit log says that the status moved, not whose application it is: the activity
    // page is open to roles that may not read applications.
    await audit(deps, session, {
      action: "APPLICATION_STATUS_CHANGED", entityType: "application", entityId: id,
      oldValues: { status: before.status }, newValues: { status }, result: "success",
    });
  }
  // After the change is saved: an email that cannot be sent does not undo it. The
  // application is read again afterwards, so its history shows the email too.
  const email = emails ? await notifyStatusChange(deps, session, request, id, status, before) : null;
  const current = email
    ? (await deps.db.rpc<ApplicationRow | null>("dash_application_get", { p_restaurant: restaurantOf(session), p_id: id })) ?? application
    : application;

  const label = LABELS.status[status];
  let message = changed ? `Status changed to ${label}.` : note ? "Note added." : "Nothing changed.";
  if (email?.result === "sent") message = `Status changed to ${label}. The applicant has been emailed at ${email.to_email}.`;
  if (email?.result === "failed") {
    message = `Status changed to ${label}, but the email to the applicant could not be sent. It is kept under "Messages to the applicant", where you can try again.`;
  }
  return json(200, {
    result: "saved",
    email,
    application: await applicationPage(deps, session, id, current),
    message,
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
