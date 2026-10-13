// POST /scheduled-tasks
//
// The work that must happen whether or not anyone visits the website or opens the
// dashboard: the monthly report, and the regular clean-up (applications past the retention
// period, rows that are only of use for a while).
//
// It is called once a day by the database's own scheduler (pg_cron, through pg_net; see
// supabase/schedule-daily-tasks.sql). Nobody else may call it: the caller must present the
// shared secret this function was given (CRON_SECRET), and until that secret is set the
// function refuses every call. It takes no input, so there is nothing a caller could ask
// it to do other than what is written here; and what it does is safe to do twice.
import { timingSafeEqual } from "../crypto.ts";
import { ApiError, errorBody, json, newRequestId } from "../http.ts";
import { errorFields } from "../log.ts";
import { purgeExpiredApplications, purgeOrphanedCategoryPhotos } from "../public/retention.ts";
import type { Deps } from "../types.ts";
import { sendMonthlyReports } from "./monthly-report.ts";

export async function handleScheduled(request: Request, deps: Deps): Promise<Response> {
  const requestId = newRequestId();
  try {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed.");
    const secret = deps.env.cronSecret;
    if (!secret) {
      deps.log.error("scheduled_tasks_not_configured", { request_id: requestId });
      throw new ApiError(503, "not_configured", "Not available.");
    }
    const presented = request.headers.get("x-cron-secret") ?? "";
    if (presented === "" || !(await timingSafeEqual(presented, secret))) {
      throw new ApiError(401, "unauthenticated", "Not authorised.");
    }

    // Each task stands alone: one failing does not stop the others, and each is reported.
    const purged = await purgeExpiredApplications(deps);
    const cleared = await deps.db.rpc<Record<string, number>>("housekeeping")
      .catch((error) => { deps.log.error("housekeeping_failed", errorFields(error)); return null; });
    const photos = await purgeOrphanedCategoryPhotos(deps);
    const reports = await sendMonthlyReports(deps)
      .catch((error) => { deps.log.error("monthly_reports_failed", errorFields(error)); return { sent: 0, failed: 1, skipped: 0, not_configured: 0 }; });

    // Counts only. Nothing about any restaurant or person is in the answer.
    const summary = { applications_purged: purged, housekeeping: cleared !== null, category_photos_purged: photos, reports };
    deps.log.info("scheduled_tasks_done", { request_id: requestId, ...summary });
    return json(200, { ok: true, ...summary });
  } catch (error) {
    if (error instanceof ApiError) return json(error.status, errorBody(error, requestId));
    deps.log.error("scheduled_tasks_failed", { request_id: requestId, ...errorFields(error) });
    return json(500, errorBody(new ApiError(500, "internal_error", "The scheduled tasks could not be run."), requestId));
  }
}
