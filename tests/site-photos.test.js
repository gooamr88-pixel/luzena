// The website's own photos (hero, "our story", gallery), changed from the dashboard and read
// by the public pages. Real handlers, real SQL (PGlite), an in-memory file store.
import { beforeAll, describe, expect, it } from "vitest";
import { handlePublicSite } from "../supabase/functions/_shared/public/site.ts";
import { createHarness, ORIGIN } from "./helpers/harness.js";

const STORAGE = "https://project.supabase.co/storage/v1/object/public/menu-images";
let h, alpha, beta, owner, manager, staff, outsider;

// The smallest things that are really a WebP, a PNG and a JPEG as far as their first bytes say.
const webp = (filler = 1) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, filler, filler, filler]);
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);

let counter = 0;
function photoForm(slot, { alt = "A table set for dinner", bytes, small = true, width = 1920, height = 1080 } = {}) {
  counter += 1;
  const form = new FormData();
  form.append("slot", slot);
  form.append("alt", alt);
  form.append("width", String(width));
  form.append("height", String(height));
  form.append("file", new File([bytes ?? webp(counter)], "whatever-the-browser-called-it.webp", { type: "image/webp" }));
  if (small) {
    form.append("small_width", "800");
    form.append("file_small", new File([webp(100 + counter)], "small.webp", { type: "image/webp" }));
  }
  return form;
}
const publicSite = async (slug = "alpha", init = {}) => {
  const response = await handlePublicSite(new Request(`https://fn.test/public-site?restaurant=${slug}`, { headers: { origin: ORIGIN }, ...init }), h.deps, STORAGE);
  return { status: response.status, headers: response.headers, body: JSON.parse(await response.text()) };
};
const filesOf = (restaurant) => [...h.stored.keys()].filter((key) => key.startsWith(`menu-images/${restaurant}/site/`));

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  await h.pg.query("update public.restaurants set name = 'Alpha Kitchen' where id = $1", [alpha]);
  owner = await h.addUser(alpha, "owner");
  manager = await h.addUser(alpha, "manager");
  staff = await h.addUser(alpha, "staff");
  outsider = await h.addUser(beta, "owner");
});

describe("what the website is told", () => {
  it("says nothing is set until the owner chooses a photo, so each page keeps its own", async () => {
    const response = await publicSite();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: 1, photos: { hero: null, story: null, gallery: [] } });
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60, stale-while-revalidate=300");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("answers without the menu ever having been synced, unlike the menu itself", async () => {
    expect((await h.pg.query("select count(*)::int as n from public.clover_connections")).rows[0].n).toBe(0);
    expect((await publicSite()).status).toBe(200);
  });

  it("gives the same plain answer for an unknown restaurant and a malformed one, and refuses other methods and origins", async () => {
    expect((await publicSite("no-such-place")).status).toBe(404);
    expect((await publicSite("../etc")).status).toBe(404);
    expect((await publicSite("alpha", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(405);
    const foreign = await publicSite("alpha", { headers: { origin: "https://evil.example" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("changing the hero and the story photo", () => {
  it("stores the photo and its smaller copy, and the website is given both", async () => {
    const response = await h.api(owner, "POST", "/site/photos", photoForm("hero", { alt: "The dining room at night" }));
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Photo saved. The website shows it within a minute.");
    const { hero } = response.body.photos;
    // The path is made on the server: the restaurant, the slot, a hash of the content.
    expect(hero.path).toMatch(new RegExp(`^${alpha}/site/hero/[0-9a-f]{20}\\.webp$`));
    expect(hero.small_path).toMatch(new RegExp(`^${alpha}/site/hero/[0-9a-f]{20}-small\\.webp$`));
    expect(hero).toMatchObject({ alt: "The dining room at night", width: 1920, height: 1080, small_width: 800 });
    expect(h.stored.get(`menu-images/${hero.path}`).contentType).toBe("image/webp");
    expect(h.stored.has(`menu-images/${hero.small_path}`)).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("whatever-the-browser-called-it");

    const site = (await publicSite()).body.photos;
    expect(site.hero).toEqual({
      src: `${STORAGE}/${hero.path}`,
      srcset: `${STORAGE}/${hero.small_path} 800w, ${STORAGE}/${hero.path} 1920w`,
      width: 1920, height: 1080, alt: "The dining room at night",
    });
    expect(site.story).toBeNull();
    expect(site.gallery).toEqual([]);
  });

  it("replaces the photo and removes the old files, leaving one photo in the slot", async () => {
    const before = (await h.api(owner, "GET", "/site/photos")).body.photos.hero;
    const response = await h.api(manager, "POST", "/site/photos", photoForm("hero", { alt: "Lunch on the terrace", bytes: png(), small: false }));
    expect(response.status).toBe(200);
    const after = response.body.photos.hero;
    expect(after.path).toMatch(/\.png$/);
    expect(after.small_path).toBeNull();
    expect(h.stored.has(`menu-images/${before.path}`)).toBe(false);
    expect(h.stored.has(`menu-images/${before.small_path}`)).toBe(false);
    expect(filesOf(alpha)).toEqual([`menu-images/${after.path}`]);
    expect((await h.pg.query("select count(*)::int as n from public.site_photos where restaurant_id = $1 and slot = 'hero'", [alpha])).rows[0].n).toBe(1);
    // With no smaller copy there is one address and no srcset.
    expect((await publicSite()).body.photos.hero).toMatchObject({ src: `${STORAGE}/${after.path}`, srcset: null });
  });

  it("keeps the two slots apart", async () => {
    await h.api(owner, "POST", "/site/photos", photoForm("story", { alt: "Our chef at the grill", bytes: jpeg() }));
    const { photos } = (await h.api(owner, "GET", "/site/photos")).body;
    expect(photos.story.path).toMatch(new RegExp(`^${alpha}/site/story/[0-9a-f]{20}\\.jpg$`));
    expect(photos.hero.alt).toBe("Lunch on the terrace");
  });

  it("changes a description without touching the file, and never leaves a photo without one on the website", async () => {
    const { hero } = (await h.api(owner, "GET", "/site/photos")).body.photos;
    const described = await h.api(owner, "PATCH", `/site/photos/${hero.id}`, { alt: "  Guests on the terrace at lunch  " });
    expect(described.body.photos.hero).toMatchObject({ alt: "Guests on the terrace at lunch", path: hero.path });
    await h.api(owner, "PATCH", `/site/photos/${hero.id}`, { alt: "" });
    expect((await publicSite()).body.photos.hero.alt).toBe("Photo from Alpha Kitchen");
    expect((await h.api(owner, "PATCH", `/site/photos/${hero.id}`, { alt: "x".repeat(201) })).status).toBe(422);
    expect((await h.api(owner, "PATCH", `/site/photos/${hero.id}`, { alt: "ok", path: "elsewhere/file.webp" })).status).toBe(422);
  });

  it("goes back to the page's own photo when the owner removes theirs", async () => {
    const { hero } = (await h.api(owner, "GET", "/site/photos")).body.photos;
    const removed = await h.api(owner, "DELETE", `/site/photos/${hero.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.photos.hero).toBeNull();
    expect(h.stored.has(`menu-images/${hero.path}`)).toBe(false);
    expect((await publicSite()).body.photos.hero).toBeNull();
    expect((await h.api(owner, "DELETE", `/site/photos/${hero.id}`)).status).toBe(404);
  });
});

describe("the gallery", () => {
  let ids;

  it("adds photos in the order they are uploaded", async () => {
    for (const alt of ["Mezze to share", "Grilled chicken", "The coffee bar"]) {
      expect((await h.api(owner, "POST", "/site/photos", photoForm("gallery", { alt }))).status).toBe(200);
    }
    const { photos, limits } = (await h.api(owner, "GET", "/site/photos")).body;
    expect(photos.gallery.map((photo) => photo.alt)).toEqual(["Mezze to share", "Grilled chicken", "The coffee bar"]);
    expect(limits).toEqual({ gallery: 24 });
    ids = photos.gallery.map((photo) => photo.id);
    expect((await publicSite()).body.photos.gallery.map((photo) => photo.alt)).toEqual(["Mezze to share", "Grilled chicken", "The coffee bar"]);
    // The website is not given ids or storage paths: only what it needs to show a photo.
    expect(Object.keys((await publicSite()).body.photos.gallery[0]).sort()).toEqual(["alt", "height", "src", "srcset", "width"]);
  });

  it("puts them in the order the owner chooses", async () => {
    const response = await h.api(owner, "POST", "/site/photos/reorder", { ids: [ids[2], ids[0], ids[1]] });
    expect(response.status).toBe(200);
    expect(response.body.photos.gallery.map((photo) => photo.alt)).toEqual(["The coffee bar", "Mezze to share", "Grilled chicken"]);
    expect((await publicSite()).body.photos.gallery.map((photo) => photo.alt)).toEqual(["The coffee bar", "Mezze to share", "Grilled chicken"]);
  });

  it("refuses an order that leaves a photo out, repeats one or names a stranger's", async () => {
    const { story } = (await h.api(owner, "GET", "/site/photos")).body.photos;
    for (const bad of [[ids[0], ids[1]], [ids[0], ids[0], ids[1]], [ids[0], ids[1], story.id], []]) {
      const status = (await h.api(owner, "POST", "/site/photos/reorder", { ids: bad })).status;
      expect([409, 422], JSON.stringify(bad).slice(0, 40)).toContain(status);
    }
    expect((await h.api(owner, "GET", "/site/photos")).body.photos.gallery.map((photo) => photo.alt)).toEqual(["The coffee bar", "Mezze to share", "Grilled chicken"]);
  });

  it("removes one photo and its files, and keeps the rest in order", async () => {
    const { gallery } = (await h.api(owner, "GET", "/site/photos")).body.photos;
    const removed = await h.api(owner, "DELETE", `/site/photos/${gallery[1].id}`);
    expect(removed.body.photos.gallery.map((photo) => photo.alt)).toEqual(["The coffee bar", "Grilled chicken"]);
    expect(h.stored.has(`menu-images/${gallery[1].path}`)).toBe(false);
    expect(h.stored.has(`menu-images/${gallery[1].small_path}`)).toBe(false);
    expect(h.stored.has(`menu-images/${gallery[0].path}`)).toBe(true);
  });

  it("holds 24 photos and says so at the 25th, keeping nothing of it", async () => {
    await h.pg.query(
      `insert into public.site_photos (restaurant_id, slot, sort_order, image_path, alt)
       select $1, 'gallery', 100 + n, 'filler/' || n || '.webp', 'Filler' from generate_series(1, 22) n`, [alpha]);
    const filesBefore = filesOf(alpha).length;
    const response = await h.api(owner, "POST", "/site/photos", photoForm("gallery", { alt: "One too many" }));
    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("The gallery holds 24 photos. Remove one to add another.");
    expect(filesOf(alpha)).toHaveLength(filesBefore);
    await h.pg.query("delete from public.site_photos where image_path like 'filler/%'");
  });
});

describe("what is not accepted", () => {
  it("anything that is not really a JPEG, PNG or WebP, whatever it is called", async () => {
    const before = filesOf(alpha).length;
    const executable = photoForm("hero", { bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]) });
    const page = photoForm("hero", { bytes: new TextEncoder().encode("<svg onload=alert(1)>") });
    expect((await h.api(owner, "POST", "/site/photos", executable)).status).toBe(415);
    expect((await h.api(owner, "POST", "/site/photos", page)).status).toBe(415);
    expect(filesOf(alpha)).toHaveLength(before);
  });

  it("a file over 1 MB, a slot that does not exist, or no file at all", async () => {
    const big = photoForm("hero", { bytes: new Uint8Array(1024 * 1024 + 1).fill(1).map((value, index) => [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50][index] ?? value) });
    expect((await h.api(owner, "POST", "/site/photos", big)).status).toBe(413);
    expect((await h.api(owner, "POST", "/site/photos", photoForm("footer"))).status).toBe(422);
    const empty = new FormData();
    empty.append("slot", "hero");
    expect((await h.api(owner, "POST", "/site/photos", empty)).status).toBe(422);
    const long = photoForm("hero", { alt: "x".repeat(201) });
    expect((await h.api(owner, "POST", "/site/photos", long)).body.error.fields.alt).toBeDefined();
  });
});

describe("who may change the website's photos", () => {
  it("owners and managers; not staff, and nobody without a session", async () => {
    for (const user of [owner, manager]) expect((await h.api(user, "GET", "/site/photos")).status).toBe(200);
    expect((await h.api(manager, "GET", "/me")).body.permissions).toContain("site.manage");
    const { gallery } = (await h.api(owner, "GET", "/site/photos")).body.photos;
    const attempts = (user) => [
      h.api(user, "GET", "/site/photos"), h.api(user, "POST", "/site/photos", photoForm("hero")),
      h.api(user, "PATCH", `/site/photos/${gallery[0].id}`, { alt: "Changed" }),
      h.api(user, "DELETE", `/site/photos/${gallery[0].id}`), h.api(user, "POST", "/site/photos/reorder", { ids: gallery.map((photo) => photo.id) }),
    ];
    for (const response of await Promise.all(attempts(staff))) expect(response.status).toBe(403);
    for (const response of await Promise.all(attempts(null))) expect(response.status).toBe(401);
    expect((await h.api(owner, "GET", "/site/photos")).body.photos.gallery[0].alt).toBe(gallery[0].alt);
  });

  it("never another restaurant's owner, whose own website is untouched by this one's photos", async () => {
    const { gallery, story } = (await h.api(owner, "GET", "/site/photos")).body.photos;
    expect((await h.api(outsider, "GET", "/site/photos")).body.photos).toEqual({ hero: null, story: null, gallery: [] });
    expect((await h.api(outsider, "PATCH", `/site/photos/${story.id}`, { alt: "Taken over" })).status).toBe(404);
    expect((await h.api(outsider, "DELETE", `/site/photos/${gallery[0].id}`)).status).toBe(404);
    expect((await h.api(outsider, "POST", "/site/photos/reorder", { ids: gallery.map((photo) => photo.id) })).status).toBe(409);
    expect((await publicSite("beta")).body.photos).toEqual({ hero: null, story: null, gallery: [] });
    expect((await h.api(owner, "GET", "/site/photos")).body.photos.story.alt).toBe(story.alt);

    await h.api(outsider, "POST", "/site/photos", photoForm("hero", { alt: "Beta's own" }));
    expect((await publicSite("beta")).body.photos.hero.src).toContain(`/${beta}/site/hero/`);
    expect((await publicSite("alpha")).body.photos.hero).toBeNull();
  });

  it("not the public: the table and its functions are closed to the website's key", async () => {
    for (const role of ["anon", "authenticated"]) {
      const table = await h.pg.query("select has_table_privilege($1, 'public.site_photos', 'select, insert, update, delete') as open", [role]);
      expect(table.rows[0].open, role).toBe(false);
      for (const fn of ["site_photos_for(uuid, boolean)", "dash_site_photo_remove(uuid, uuid)", "dash_site_gallery_reorder(uuid, uuid[])"]) {
        const result = await h.pg.query("select has_function_privilege($1, $2, 'execute') as open", [role, `public.${fn}`]);
        expect(result.rows[0].open, `${role} on ${fn}`).toBe(false);
      }
    }
    expect((await h.pg.query("select relrowsecurity from pg_class where relname = 'site_photos'")).rows[0].relrowsecurity).toBe(true);
  });

  it("records each change in the activity log", async () => {
    const { rows } = await h.pg.query("select action, count(*)::int as n from public.audit_logs where action like 'SITE_PHOTO_%' group by action order by action");
    expect(rows.map((row) => row.action)).toEqual(["SITE_PHOTO_REMOVED", "SITE_PHOTO_SET"]);
    // Each entry names where the photo is on the website, never a file or an id.
    const places = await h.pg.query("select distinct entity_id from public.audit_logs where action like 'SITE_PHOTO_%' order by entity_id");
    expect(places.rows.map((row) => row.entity_id).every((place) => ["gallery", "hero", "story"].includes(place))).toBe(true);
  });
});
