// Deletes job applications that have passed the retention period, with their CV files.
//
// There is no scheduler in this system, so this runs on the back of ordinary requests:
// about once an hour while anyone at all is visiting the public website (`upkeep` below),
// and also straight after a new application and when an owner opens the dashboard overview.
// DEPLOYMENT_CHECKLIST.md explains how to add a daily schedule if the restaurant needs one
// that does not depend on visitors.
import { errorFields } from "../log.ts";
import type { Deps } from "../types.ts";

const CV_BUCKET = "cvs";
const BATCH = 100;
const UPKEEP_EVERY_SECONDS = 3600;
const IMAGE_BUCKET = "menu-images";
// How long the photo of a category that Clover no longer has is kept before it is deleted.
// A category deleted by mistake, or for a season, comes back with its photo within this.
export const ORPHANED_PHOTO_GRACE_DAYS = 30;
// What a category photo's place in the bucket looks like. Anything else is left alone,
// whatever the database says: <restaurant>/categories/<category>/<hash>.<type>
const CATEGORY_PHOTO_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/categories\/[A-Z0-9]{13}\/[0-9a-f]{20}\.(webp|jpg|png)$/;

// When each running copy of the backend last looked at whether upkeep is due, so that a
// busy copy asks the database about it once an hour and not on every request.
const lastLook = new WeakMap<object, number>();

// The system's regular chores, done about once an hour by whichever request comes first:
// applications past the retention period are deleted with their CVs, and rows that are only
// of use for a while are cleared (see the housekeeping migration).
//
// There is no scheduler, so this is hung on the requests the public website makes whenever
// anyone opens it. Before, expired applications were deleted only when a new application
// arrived or an owner opened the dashboard, which in a quiet month could be weeks late.
//
// It never throws and is meant to be handed to `waitUntil`: the visitor's answer has
// already gone out.
export async function upkeep(deps: Deps): Promise<void> {
  const now = deps.now();
  const looked = lastLook.get(deps.db);
  if (looked !== undefined && now - looked < UPKEEP_EVERY_SECONDS * 1000) return;
  lastLook.set(deps.db, now);
  try {
    // Many copies of the backend run at once. The database lets one of them through an hour.
    const due = await deps.db.rpc<boolean>("rate_limit_hit", {
      p_key: "upkeep", p_max: 1, p_window_seconds: UPKEEP_EVERY_SECONDS,
    });
    if (!due) return;
    await purgeExpiredApplications(deps);
    const cleared = await deps.db.rpc<Record<string, number>>("housekeeping");
    if (Object.values(cleared ?? {}).some((count) => count > 0)) deps.log.info("housekeeping_done", cleared);
    await purgeOrphanedCategoryPhotos(deps);
  } catch (error) {
    deps.log.error("upkeep_failed", errorFields(error));
  }
}

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

interface OrphanedPhoto {
  restaurant_id: string;
  category_id: string;
  path: string;
}

// Deletes the photos of categories that have been gone from Clover for longer than the
// grace period, when nothing else shows the same file. Which photos those are is decided by
// the database (see the migration), which never offers a photo of a category that still
// exists, one that came back, or a file something else points at.
//
// Files first, then the rows, as for CVs: if a file cannot be removed the row stays and the
// next pass tries again. Removing a file that is already gone is not an error, so a pass
// that was interrupted is simply finished by the next one. Returns how many were deleted;
// never throws.
export async function purgeOrphanedCategoryPhotos(deps: Deps): Promise<number> {
  try {
    const orphaned = await deps.db.rpc<OrphanedPhoto[]>("category_photos_orphaned", {
      p_grace_days: ORPHANED_PHOTO_GRACE_DAYS, p_limit: BATCH,
    });
    // A second check, here, on the shape of each path and on whose folder it is in.
    const photos = orphaned.filter((photo) =>
      CATEGORY_PHOTO_PATH.test(photo.path) && photo.path.startsWith(`${photo.restaurant_id}/categories/${photo.category_id}/`));
    if (photos.length < orphaned.length) {
      deps.log.warn("category_photos_skipped", { skipped: orphaned.length - photos.length, reason: "unexpected_path" });
    }
    if (photos.length === 0) return 0;

    await deps.files.remove(IMAGE_BUCKET, photos.map((photo) => photo.path));
    const forgotten = await deps.db.rpc<number>("category_photos_forget", {
      p_photos: photos, p_grace_days: ORPHANED_PHOTO_GRACE_DAYS,
    });
    // How many, and after how long. No path and no restaurant: nothing here needs them.
    deps.log.info("category_photos_purged", { files: photos.length, forgotten, grace_days: ORPHANED_PHOTO_GRACE_DAYS });
    return photos.length;
  } catch (error) {
    deps.log.error("category_photos_purge_failed", errorFields(error));
    return 0;
  }
}
