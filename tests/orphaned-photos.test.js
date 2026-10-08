// The photo of a category that Clover no longer has: kept for a grace period, then deleted
// by the hourly pass, and only when nothing else shows the same file. Real handlers, real
// SQL (PGlite), a fake Clover, an in-memory file store.
import { beforeAll, describe, expect, it } from "vitest";
import { handlePublicMenu } from "../supabase/functions/_shared/public/menu.ts";
import { ORPHANED_PHOTO_GRACE_DAYS, purgeOrphanedCategoryPhotos } from "../supabase/functions/_shared/public/retention.ts";
import { createHarness, ORIGIN } from "./helpers/harness.js";

let h, alpha, beta, owner;
let seasonal, gone, kept, returning, soup;

const webp = (filler) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, filler, filler, filler]);
const photo = (filler) => {
  const form = new FormData();
  form.append("file", new File([webp(filler)], "photo.webp", { type: "image/webp" }));
  return form;
};
const setPhoto = async (user, id, filler) =>
  (await h.api(user, "POST", `/categories/${id}/image`, photo(filler))).body.categories.find((entry) => entry.id === id).image_path;
const pathOf = async (restaurant, id) =>
  (await h.pg.query("select web_image_path from public.menu_categories where restaurant_id = $1 and clover_id = $2", [restaurant, id])).rows[0].web_image_path;
const stored = (path) => h.stored.has(`menu-images/${path}`);
const goneFor = (id, days) =>
  h.pg.query("update public.menu_categories set removed_from_clover_at = now() - make_interval(days => $3) where restaurant_id = $1 and clover_id = $2", [alpha, id, days]);
const removeInClover = async (...ids) => {
  for (const id of ids) h.clover.categories.delete(id);
  await h.api(owner, "POST", "/clover/sync");
};

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  owner = await h.addUser(alpha, "owner");

  seasonal = h.clover.addCategory("Summer Specials", 1);
  gone = h.clover.addCategory("Old Brunch", 2);
  kept = h.clover.addCategory("Mains", 3);
  returning = h.clover.addCategory("Soups", 4);
  soup = h.clover.addItem("Soup", 700);
  h.clover.link(soup, kept);
  await h.connect(alpha);
  await h.api(owner, "POST", "/clover/sync");
});

describe("a category that still exists", () => {
  it("keeps the photo the owner chose for it, however old, pass after pass", async () => {
    const path = await setPhoto(owner, kept, 1);
    await h.pg.query("update public.menu_categories set updated_at = now() - interval '400 days' where restaurant_id = $1", [alpha]);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(stored(path)).toBe(true);
    expect(await pathOf(alpha, kept)).toBe(path);
  });

  it("keeps it when the category is only hidden or archived on the website", async () => {
    const path = await pathOf(alpha, kept);
    await h.pg.query("update public.menu_categories set web_hidden = true, archived_at = now() - interval '90 days' where restaurant_id = $1 and clover_id = $2", [alpha, kept]);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(stored(path)).toBe(true);
    await h.pg.query("update public.menu_categories set web_hidden = false, archived_at = null where restaurant_id = $1 and clover_id = $2", [alpha, kept]);
  });
});

describe("a category deleted in Clover", () => {
  let seasonalPath, gonePath;

  it("keeps its photo when it has only just gone: nothing is deleted because a category disappeared", async () => {
    seasonalPath = await setPhoto(owner, seasonal, 2);
    gonePath = await setPhoto(owner, gone, 3);
    await removeInClover(seasonal, gone);
    const { rows } = await h.pg.query("select clover_id from public.menu_categories where restaurant_id = $1 and removed_from_clover_at is not null order by clover_id", [alpha]);
    expect(rows.map((row) => row.clover_id).sort()).toEqual([seasonal, gone].sort());

    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(stored(seasonalPath) && stored(gonePath)).toBe(true);
  });

  it("still keeps it a day before the grace period ends", async () => {
    await goneFor(gone, ORPHANED_PHOTO_GRACE_DAYS - 1);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(stored(gonePath)).toBe(true);
    expect(await pathOf(alpha, gone)).toBe(gonePath);
  });

  it("deletes it once the grace period has passed, and forgets it", async () => {
    expect(ORPHANED_PHOTO_GRACE_DAYS).toBe(30);
    await goneFor(gone, ORPHANED_PHOTO_GRACE_DAYS + 1);
    const logsBefore = h.logs.length;

    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(1);

    expect(stored(gonePath)).toBe(false);
    expect(await pathOf(alpha, gone)).toBeNull();
    // The category that went at the same time but is not past the period keeps its photo.
    expect(stored(seasonalPath)).toBe(true);
    expect(await pathOf(alpha, seasonal)).toBe(seasonalPath);
    // It is on record how many went, with no path and no restaurant in the log.
    const logged = h.logs.slice(logsBefore);
    expect(logged.find((entry) => entry.event === "category_photos_purged")).toMatchObject({ files: 1, forgotten: 1, grace_days: 30 });
    expect(JSON.stringify(logged)).not.toContain(alpha);
    expect(JSON.stringify(logged)).not.toContain("categories/");
  });

  it("does nothing more when it is run again, and again", async () => {
    const files = [...h.stored.keys()].sort();
    const logsBefore = h.logs.length;
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect([...h.stored.keys()].sort()).toEqual(files);
    expect(h.logs.slice(logsBefore).some((entry) => entry.event.startsWith("category_photos_"))).toBe(false);
  });

  it("keeps the photo of a category that comes back to Clover, even long after", async () => {
    const path = await setPhoto(owner, returning, 4);
    const saved = h.clover.categories.get(returning);
    await removeInClover(returning);
    await goneFor(returning, 20);
    // Back within the grace period: the synchronisation finds it again.
    h.clover.categories.set(returning, saved);
    await h.api(owner, "POST", "/clover/sync");
    expect((await h.pg.query("select removed_from_clover_at from public.menu_categories where restaurant_id = $1 and clover_id = $2", [alpha, returning])).rows[0].removed_from_clover_at).toBeNull();
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(stored(path)).toBe(true);
    expect(await pathOf(alpha, returning)).toBe(path);
  });
});

describe("a photo that something else still shows", () => {
  let path;

  beforeAll(async () => {
    path = await pathOf(alpha, seasonal);
    await goneFor(seasonal, 90);
  });

  it("is not deleted while another category shows the same file", async () => {
    await h.pg.query("update public.menu_categories set web_image_path = $3 where restaurant_id = $1 and clover_id = $2", [alpha, returning, path]);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(stored(path)).toBe(true);
    await h.pg.query("update public.menu_categories set web_image_path = null where restaurant_id = $1 and clover_id = $2", [alpha, returning]);
  });

  it("is not deleted while a dish shows the same file", async () => {
    await h.pg.query("update public.menu_items set web_image_path = $3 where restaurant_id = $1 and clover_id = $2", [alpha, soup, path]);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(stored(path)).toBe(true);
    await h.pg.query("update public.menu_items set web_image_path = null where restaurant_id = $1 and clover_id = $2", [alpha, soup]);
  });

  it("is not deleted while one of the website's own photos is the same file", async () => {
    await h.pg.query("insert into public.site_photos (restaurant_id, slot, sort_order, image_path, alt) values ($1, 'gallery', 1, $2, 'Shared')", [alpha, path]);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    await h.pg.query("update public.site_photos set image_path = 'elsewhere.webp', small_path = $2 where restaurant_id = $1", [alpha, path]);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(stored(path)).toBe(true);
    await h.pg.query("delete from public.site_photos where restaurant_id = $1", [alpha]);
  });

  it("is deleted once nothing else shows it", async () => {
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(1);
    expect(stored(path)).toBe(false);
    expect(await pathOf(alpha, seasonal)).toBeNull();
  });
});

describe("what is never touched", () => {
  it("files that are not a removed category's photo: dishes, the website's photos, other restaurants, strays", async () => {
    const others = [
      `menu-images/${alpha}/SOUPITEM00001/0123456789abcdef0123.webp`,
      `menu-images/${alpha}/site/hero/0123456789abcdef0123.webp`,
      `menu-images/${alpha}/categories/${kept}/ffffffffffffffffffff.webp`,
      `menu-images/${beta}/categories/BETACATEGORY1/0123456789abcdef0123.webp`,
      `cvs/${alpha}/someone.pdf`,
    ];
    for (const key of others) h.stored.set(key, { bytes: new Uint8Array([1]), contentType: "image/webp" });
    const before = [...h.stored.keys()].sort();
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect([...h.stored.keys()].sort()).toEqual(before);
  });

  it("a path that points outside the category's own folder, whatever the row says", async () => {
    const outside = `${alpha}/site/hero/0123456789abcdef0123.webp`;
    const extra = h.clover.addCategory("Misfiled", 9);
    await h.api(owner, "POST", "/clover/sync");
    await h.pg.query("update public.menu_categories set web_image_path = $3 where restaurant_id = $1 and clover_id = $2", [alpha, extra, outside]);
    await removeInClover(extra);
    await goneFor(extra, 200);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    expect(h.stored.has(`menu-images/${outside}`)).toBe(true);
    expect(await pathOf(alpha, extra)).toBe(outside);
  });

  it("another restaurant's removed category is judged on its own, and this one's photos are not affected by it", async () => {
    const mine = await pathOf(alpha, kept);
    const theirs = `${beta}/categories/BETACATEGORY1/0123456789abcdef0123.webp`;
    await h.pg.query(
      "insert into public.menu_categories (restaurant_id, clover_id, name, web_image_path, removed_from_clover_at) values ($1, 'BETACATEGORY1', 'Gone', $2, now() - interval '45 days')",
      [beta, theirs]);
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(1);
    expect(h.stored.has(`menu-images/${theirs}`)).toBe(false);
    expect(stored(mine)).toBe(true);
  });
});

describe("when something goes wrong", () => {
  it("keeps the row if the file cannot be removed, and finishes on a later pass", async () => {
    const extra = h.clover.addCategory("Stuck", 8);
    await h.api(owner, "POST", "/clover/sync");
    const path = await setPhoto(owner, extra, 7);
    await removeInClover(extra);
    await goneFor(extra, 31);

    const realRemove = h.deps.files.remove;
    h.deps.files.remove = async () => { throw new Error("storage unavailable"); };
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(0);
    h.deps.files.remove = realRemove;
    expect(await pathOf(alpha, extra)).toBe(path);
    expect(stored(path)).toBe(true);
    expect(h.logs.some((entry) => entry.event === "category_photos_purge_failed")).toBe(true);

    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(1);
    expect(stored(path)).toBe(false);
    expect(await pathOf(alpha, extra)).toBeNull();
  });

  it("finishes a pass that removed the file but did not get to forget it", async () => {
    const extra = h.clover.addCategory("Half Done", 7);
    await h.api(owner, "POST", "/clover/sync");
    const path = await setPhoto(owner, extra, 8);
    await removeInClover(extra);
    await goneFor(extra, 31);
    h.stored.delete(`menu-images/${path}`); // the file went, the row did not
    expect(await purgeOrphanedCategoryPhotos(h.deps)).toBe(1);
    expect(await pathOf(alpha, extra)).toBeNull();
  });
});

describe("where it runs, and who may run it", () => {
  it("is part of the hourly pass that rides on the public pages", async () => {
    const extra = h.clover.addCategory("Hourly", 6);
    await h.api(owner, "POST", "/clover/sync");
    const path = await setPhoto(owner, extra, 9);
    await removeInClover(extra);
    await goneFor(extra, 40);
    await h.pg.query("delete from public.rate_limits where key = 'upkeep'");
    const realNow = h.deps.now;
    h.deps.now = () => realNow() + 5 * 3600 * 1000;
    await handlePublicMenu(new Request("https://fn.test/public-menu?restaurant=alpha", { headers: { origin: ORIGIN } }), h.deps, "https://files.test");
    await h.settle();
    h.deps.now = realNow;
    expect(stored(path)).toBe(false);
    expect(h.logs.some((entry) => entry.event === "upkeep_failed")).toBe(false);
  });

  it("is closed to the public roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const fn of ["category_photos_orphaned(integer, integer)", "category_photos_forget(jsonb, integer)"]) {
        const result = await h.pg.query("select has_function_privilege($1, $2, 'execute') as open", [role, `public.${fn}`]);
        expect(result.rows[0].open, `${role} on ${fn}`).toBe(false);
      }
    }
  });
});
