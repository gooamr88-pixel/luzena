// Deletes job applications that have passed the retention period, with their CV files.
//
// There is no scheduler in this system, so this runs opportunistically: after a new
// application is accepted, and when an owner opens the dashboard overview. Both are frequent
// enough for a restaurant; DEPLOYMENT_CHECKLIST.md explains how to add a daily schedule if
// the restaurant needs a guaranteed one.
import { errorFields } from "../log.ts";
import type { Deps } from "../types.ts";

const CV_BUCKET = "cvs";
const BATCH = 100;

export async function purgeExpiredApplications(deps: Deps): Promise<number> {
  const days = deps.env.jobApplications.retentionDays;
  // No retention period configured means nothing may be deleted on a guess, either.
  if (days === null) return 0;

  try {
    const expired = await deps.db.rpc<{ id: string; cv_path: string | null }[]>("job_applications_expired", {
      p_days: days, p_limit: BATCH,
    });
    if (expired.length === 0) return 0;

    // Files first. If this throws, the rows stay and the next run tries again, so a CV can
    // never be left behind with nothing pointing to it.
    const paths = expired.map((entry) => entry.cv_path).filter((path): path is string => path !== null);
    if (paths.length > 0) await deps.files.remove(CV_BUCKET, paths);

    const deleted = await deps.db.rpc<number>("job_applications_delete", { p_ids: expired.map((entry) => entry.id) });
    deps.log.info("job_applications_purged", { deleted, files: paths.length, retention_days: days });
    return deleted;
  } catch (error) {
    deps.log.error("job_applications_purge_failed", errorFields(error));
    return 0;
  }
}
