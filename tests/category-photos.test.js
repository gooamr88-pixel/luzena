// A photo for each menu category, chosen in the dashboard and shown on the home page's
// category tiles. Real handlers, real SQL (PGlite), a fake Clover, an in-memory file store.
import { beforeAll, describe, expect, it } from "vitest";
import { handlePublicMenu } from "../supabase/functions/_shared/public/menu.ts";
import { createHarness, ORIGIN } from "./helpers/harness.js";

const STORAGE = "https://project.supabase.co/storage/v1/object/public/menu-images";
let h, alpha, beta, owner, manager, staff, outsider, starters, mains, empty, soup, steak;

const webp = (filler = 1) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, filler, filler, filler]);
const photo = (bytes = webp(), name = "IMG_0001.webp") => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "image/webp" }));
  return form;
};
const publicMenu = async () => {
  const response = await handlePublicMenu(new Request("https://fn.test/public-menu?restaurant=alpha", { headers: { origin: ORIGIN } }), h.deps, STORAGE);
  return { status: response.status, body: JSON.parse(await response.text()) };
};
const listed = async (user = owner) => (await h.api(user, "GET", "/categories")).body.categories;
const category = async (id) => (await listed()).find((entry) => entry.id === id);
const filesOf = (id) => [...h.stored.keys()].filter((key) => key.startsWith(`menu-images/${alpha}/categories/${id}/`));

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  owner = await h.addUser(alpha, "owner");
  manager = await h.addUser(alpha, "manager");
  staff = await h.addUser(alpha, "staff");
  outsider = await h.addUser(beta, "owner");

  starters = h.clover.addCategory("Starters", 1);
  mains = h.clover.addCategory("Mains", 2);
  empty = h.clover.addCategory("Coming Soon", 3);
  soup = h.clover.addItem("Soup", 700);
  steak = h.clover.addItem("Steak", 3200);
  h.clover.link(soup, starters);
  h.clover.link(steak, mains);
  await h.connect(alpha);
  await h.api(owner, "POST", "/clover/sync");
  await h.api(owner, "POST", "/items/bulk", { ids: [soup, steak], action: "show" });
});

describe("a category with no photo of its own", () => {
  it("is told to the website as having none, so the page picks one itself", async () => {
    const menu = await publicMenu();
    expect(menu.status).toBe(200);
    expect(menu.body.categories.map((entry) => [entry.name, entry.image_url])).toEqual([["Starters", null], ["Mains", null]]);
    expect((await category(starters)).image_path).toBeNull();
  });

  it("tells the dashboard which photo the website borrows: the first dish of the category that has one", async () => {
    expect((await category(mains)).dish_image_path).toBeNull();
    const dish = new FormData();
    dish.append("file", new File([webp(40)], "steak.webp", { type: "image/webp" }));
    const uploaded = await h.api(owner, "POST", `/items/${steak}/image`, dish);
    expect((await category(mains)).dish_image_path).toBe(uploaded.body.item.image_path);
    // Another category's dishes are not borrowed from.
    expect((await category(starters)).dish_image_path).toBeNull();
    // How many of its dishes the website shows: a category with none is not on the home page.
    expect((await category(mains)).on_website_count).toBe(1);
    expect((await category(empty)).on_website_count).toBe(0);
  });
});

describe("choosing a photo for a category", () => {
  it("stores it under a path made on the server, and the website is given its address", async () => {
    const response = await h.api(owner, "POST", `/categories/${starters}/image`, photo(webp(2), "../../etc/passwd.webp"));
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Photo saved. The website shows it within a minute.");
    const saved = response.body.categories.find((entry) => entry.id === starters);
    // The restaurant, the category and a hash of the content. Nothing of the file's name.
    expect(saved.image_path).toMatch(new RegExp(`^${alpha}/categories/${starters}/[0-9a-f]{20}\\.webp$`));
    expect(h.stored.get(`menu-images/${saved.image_path}`).contentType).toBe("image/webp");

    const shown = (await publicMenu()).body.categories.find((entry) => entry.id === starters);
    expect(shown.image_url).toBe(`${STORAGE}/${saved.image_path}`);
    // An address only: never the path inside the bucket.
    expect(shown).not.toHaveProperty("image_path");
    expect(JSON.stringify((await publicMenu()).body)).not.toContain('"image_path"');
  });

  it("replaces it and removes the old file, leaving one file for the category", async () => {
    const before = (await category(starters)).image_path;
    const response = await h.api(manager, "POST", `/categories/${starters}/image`, photo(webp(3)));
    const after = response.body.categories.find((entry) => entry.id === starters).image_path;
    expect(after).not.toBe(before);
    expect(filesOf(starters)).toEqual([`menu-images/${after}`]);
  });

  it("keeps the file when the very same photo is chosen again", async () => {
    const before = (await category(starters)).image_path;
    const response = await h.api(owner, "POST", `/categories/${starters}/image`, photo(webp(3)));
    expect(response.body.categories.find((entry) => entry.id === starters).image_path).toBe(before);
    expect(h.stored.has(`menu-images/${before}`)).toBe(true);
  });

  it("survives a synchronisation with Clover, which knows nothing of it", async () => {
    const before = (await category(starters)).image_path;
    h.clover.categories.get(starters).name = "Starters & Soups";
    await h.api(owner, "POST", "/clover/sync");
    const after = await category(starters);
    expect(after.name).toBe("Starters & Soups");
    expect(after.image_path).toBe(before);
  });

  it("goes back to the automatic photo when the owner removes theirs, and deletes the file", async () => {
    const before = (await category(starters)).image_path;
    const response = await h.api(owner, "DELETE", `/categories/${starters}/image`);
    expect(response.status).toBe(200);
    expect(response.body.categories.find((entry) => entry.id === starters).image_path).toBeNull();
    expect(h.stored.has(`menu-images/${before}`)).toBe(false);
    expect((await publicMenu()).body.categories.find((entry) => entry.id === starters).image_url).toBeNull();
    // Removing what is not there is not an error.
    expect((await h.api(owner, "DELETE", `/categories/${starters}/image`)).status).toBe(200);
  });

  it("does not leave a file behind when the photo cannot be saved on the category", async () => {
    const before = [...h.stored.keys()].sort();
    const realRpc = h.deps.db.rpc;
    h.deps.db.rpc = (fn, args) => (fn === "dash_category_set_image" ? Promise.reject(new Error("database unavailable")) : realRpc(fn, args));
    const response = await h.api(owner, "POST", `/categories/${starters}/image`, photo(webp(9)));
    h.deps.db.rpc = realRpc;
    expect(response.status).toBe(500);
    expect([...h.stored.keys()].sort()).toEqual(before);
  });
});

describe("what is not accepted", () => {
  it("a file that is not really an image, one over 1 MB, or no file", async () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
    expect((await h.api(owner, "POST", `/categories/${mains}/image`, photo(exe, "photo.webp"))).status).toBe(415);
    const big = new Uint8Array(1024 * 1024 + 10);
    big.set(webp());
    expect((await h.api(owner, "POST", `/categories/${mains}/image`, photo(big))).status).toBe(413);
    expect((await h.api(owner, "POST", `/categories/${mains}/image`, new FormData())).status).toBe(422);
    expect(filesOf(mains)).toEqual([]);
  });

  it("a category that does not exist, storing nothing for it", async () => {
    const response = await h.api(owner, "POST", "/categories/NOSUCHCAT0001/image", photo(webp(5)));
    expect(response.status).toBe(404);
    expect([...h.stored.keys()].some((key) => key.includes("NOSUCHCAT0001"))).toBe(false);
    expect((await h.api(owner, "DELETE", "/categories/NOSUCHCAT0001/image")).status).toBe(404);
  });
});

describe("who may change a category's photo", () => {
  it("owners and managers; not staff, and nobody without a session", async () => {
    expect((await h.api(staff, "POST", `/categories/${mains}/image`, photo(webp(6)))).status).toBe(403);
    expect((await h.api(staff, "DELETE", `/categories/${mains}/image`)).status).toBe(403);
    expect((await h.api(null, "POST", `/categories/${mains}/image`, photo(webp(6)))).status).toBe(401);
    expect(filesOf(mains)).toEqual([]);
    expect((await h.api(manager, "POST", `/categories/${mains}/image`, photo(webp(6)))).status).toBe(200);
  });

  it("never another restaurant's owner, whose request finds no such category", async () => {
    const before = (await category(mains)).image_path;
    expect((await h.api(outsider, "POST", `/categories/${mains}/image`, photo(webp(7)))).status).toBe(404);
    expect((await h.api(outsider, "DELETE", `/categories/${mains}/image`)).status).toBe(404);
    expect((await category(mains)).image_path).toBe(before);
    expect([...h.stored.keys()].some((key) => key.startsWith(`menu-images/${beta}/`))).toBe(false);
  });

  it("not the public: the new function is closed to the website's key", async () => {
    for (const role of ["anon", "authenticated"]) {
      const result = await h.pg.query("select has_function_privilege($1, 'public.dash_category_set_image(uuid, text, text)', 'execute') as open", [role]);
      expect(result.rows[0].open, role).toBe(false);
    }
  });

  it("records each change in the activity log", async () => {
    const { rows } = await h.pg.query("select action, entity_id from public.audit_logs where action like 'CATEGORY_IMAGE_%' order by id");
    expect(rows.map((row) => row.action)).toContain("CATEGORY_IMAGE_UPDATED");
    expect(rows.map((row) => row.action)).toContain("CATEGORY_IMAGE_REMOVED");
    expect(rows.every((row) => [starters, mains].includes(row.entity_id))).toBe(true);
  });
});
