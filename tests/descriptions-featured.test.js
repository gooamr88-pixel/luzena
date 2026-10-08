// A dish's description and its "featured" mark. Both are website-only: Clover has no field
// for either, the owner sets them in the dashboard, and synchronisation never writes to
// them. Real handlers, real SQL (PGlite), a fake Clover.
//
// Nothing here invents menu content: the dishes and the words are test data only.
import { beforeAll, describe, expect, it } from "vitest";
import { handlePublicMenu } from "../supabase/functions/_shared/public/menu.ts";
import { createHarness, ORIGIN } from "./helpers/harness.js";

let h, alpha, beta, owner, manager, staff, outsider, starters, soup, wrap, steak, salad;

const publicMenu = async (slug = "alpha") => {
  const response = await handlePublicMenu(new Request(`https://fn.test/public-menu?restaurant=${slug}`, { headers: { origin: ORIGIN } }), h.deps, "https://files.test");
  return { status: response.status, body: JSON.parse(await response.text()) };
};
const publicItems = async () => (await publicMenu()).body.categories.flatMap((category) => category.items);
const publicItem = async (id) => (await publicItems()).find((item) => item.id === id);
const dashItem = async (id, user = owner) => (await h.api(user, "GET", `/items/${id}`)).body.item;
const describeItem = (id, description, user = owner) => h.api(user, "PATCH", `/items/${id}`, { website: { description } });
const feature = (id, featured, user = owner) => h.api(user, "PATCH", `/items/${id}`, { website: { featured } });
const stored = async (id) =>
  (await h.pg.query("select web_description, web_featured from public.menu_items where restaurant_id = $1 and clover_id = $2", [alpha, id])).rows[0];

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  owner = await h.addUser(alpha, "owner");
  manager = await h.addUser(alpha, "manager");
  staff = await h.addUser(alpha, "staff");
  outsider = await h.addUser(beta, "owner");

  starters = h.clover.addCategory("Starters", 1);
  soup = h.clover.addItem("Soup", 700);
  wrap = h.clover.addItem("Wrap", 1100);
  steak = h.clover.addItem("Steak", 3200);
  salad = h.clover.addItem("Salad", 900);
  for (const id of [soup, wrap, steak, salad]) h.clover.link(id, starters);
  await h.connect(alpha);
  await h.api(owner, "POST", "/clover/sync");
  await h.api(owner, "POST", "/items/bulk", { ids: [soup, wrap, steak, salad], action: "show" });
});

describe("a dish's description", () => {
  it("is empty for every dish that comes from Clover: none is made up", async () => {
    for (const id of [soup, wrap, steak, salad]) {
      expect((await stored(id)).web_description).toBeNull();
      expect((await dashItem(id)).description).toBeNull();
    }
    // The public menu carries the field, empty, and is none the worse for it.
    const items = await publicItems();
    expect(items).toHaveLength(4);
    expect(items.every((item) => "description" in item && item.description === null)).toBe(true);
  });

  it("is saved by the owner and shown on the public menu, without calling Clover", async () => {
    const callsBefore = h.clover.calls.length;
    const response = await describeItem(soup, "Slow-cooked every morning, served with warm bread.");
    expect(response.status).toBe(200);
    expect(response.body.result).toBe("saved");
    expect(response.body.clover_changed).toBe(false);
    expect(h.clover.calls.length).toBe(callsBefore);
    expect(response.body.item.description).toBe("Slow-cooked every morning, served with warm bread.");
    expect((await publicItem(soup)).description).toBe("Slow-cooked every morning, served with warm bread.");
    // The other dishes are untouched.
    expect((await publicItem(wrap)).description).toBeNull();
  });

  it("can be changed by a manager, and is trimmed", async () => {
    const response = await describeItem(soup, "   Made fresh every morning.  ", manager);
    expect(response.status).toBe(200);
    expect((await stored(soup)).web_description).toBe("Made fresh every morning.");
  });

  it("can be removed again: null, an empty text and blank space all mean no description", async () => {
    for (const empty of [null, "", "    "]) {
      await describeItem(soup, "Something.");
      const response = await describeItem(soup, empty);
      expect(response.status, JSON.stringify(empty)).toBe(200);
      expect((await stored(soup)).web_description, JSON.stringify(empty)).toBeNull();
      expect((await publicItem(soup)).description, JSON.stringify(empty)).toBeNull();
    }
    expect((await publicMenu()).status).toBe(200);
  });

  it("keeps Arabic and English as they were written, and several lines", async () => {
    const arabic = "شاورما دجاج مشوية تقدم مع صلصة الثوم والمخلل";
    await describeItem(wrap, arabic);
    expect((await publicItem(wrap)).description).toBe(arabic);
    const mixed = "Grilled chicken · دجاج مشوي\nServed with rice.";
    await describeItem(wrap, mixed);
    expect((await stored(wrap)).web_description).toBe(mixed);
    expect((await dashItem(wrap)).description).toBe(mixed);
  });

  it("is stored as plain text: markup in it is kept as the characters it is, for the page to show as text", async () => {
    const hostile = `<script>alert(1)</script><img src=x onerror="alert(2)"> & "quotes"`;
    const response = await describeItem(steak, hostile);
    expect(response.status).toBe(200);
    // Nothing is stripped and nothing is turned into entities here: the page sets it as
    // text, never as markup (see the browser test of the menu page).
    expect((await publicItem(steak)).description).toBe(hostile);
    await describeItem(steak, null);
  });

  it("is refused when it is too long, not text, or holds control characters", async () => {
    await describeItem(salad, "Crisp leaves.");
    for (const bad of ["x".repeat(601), 42, ["a list"], { text: "an object" }, "bell\u0007", "null\u0000byte"]) {
      const response = await describeItem(salad, bad);
      expect(response.status, JSON.stringify(bad).slice(0, 30)).toBe(422);
      expect(response.body.error.code).toBe("validation_failed");
    }
    expect((await describeItem(salad, "x".repeat(600))).status).toBe(200);
    await describeItem(salad, "Crisp leaves.");
    expect((await stored(salad)).web_description).toBe("Crisp leaves.");
  });

  it("can only be changed by the restaurant's own owner or manager", async () => {
    expect((await describeItem(salad, "Changed by staff.", staff)).status).toBe(403);
    expect((await describeItem(salad, "Changed by a stranger.", outsider)).status).toBe(404);
    expect((await h.api(null, "PATCH", `/items/${salad}`, { website: { description: "No session." } })).status).toBe(401);
    expect((await stored(salad)).web_description).toBe("Crisp leaves.");
    // Staff may read it; another restaurant may not see the dish at all.
    expect((await dashItem(salad, staff)).description).toBe("Crisp leaves.");
    expect((await h.api(outsider, "GET", `/items/${salad}`)).status).toBe(404);
  });

  it("survives synchronisation with Clover, including a rename and a new price there", async () => {
    await describeItem(soup, "Made fresh every morning.");
    h.clover.items.get(soup).name = "Soup of the Day";
    h.clover.items.get(soup).price = 850;
    const sync = await h.api(owner, "POST", "/clover/sync");
    expect(sync.status).toBe(200);
    const item = await publicItem(soup);
    expect(item).toMatchObject({ name: "Soup of the Day", price_cents: 850, description: "Made fresh every morning." });
    expect((await stored(salad)).web_description).toBe("Crisp leaves.");
    // And Clover was never sent a description: it has nowhere to keep one.
    expect(h.clover.calls.some((call) => JSON.stringify(call.body ?? "").includes("description"))).toBe(false);
  });
});

describe("featured dishes", () => {
  const featuredIds = async () => (await publicItems()).filter((item) => item.featured).map((item) => item.id).sort();

  it("are none to begin with: nothing that comes from Clover is featured by itself", async () => {
    const { rows } = await h.pg.query("select count(*)::int as n from public.menu_items where restaurant_id = $1 and web_featured", [alpha]);
    expect(rows[0].n).toBe(0);
    expect(await featuredIds()).toEqual([]);
    // The public menu is whole with no featured dish in it.
    const menu = await publicMenu();
    expect(menu.status).toBe(200);
    expect(menu.body.categories[0].items).toHaveLength(4);
    expect(menu.body.categories[0].items.every((item) => item.featured === false)).toBe(true);
    expect((await h.api(owner, "GET", "/overview")).body.counts.featured).toBe(0);
  });

  it("are marked one at a time by the owner, and the public menu says so for that dish only", async () => {
    const callsBefore = h.clover.calls.length;
    const response = await feature(soup, true);
    expect(response.status).toBe(200);
    expect(response.body.item.featured).toBe(true);
    expect(h.clover.calls.length).toBe(callsBefore);
    expect(await featuredIds()).toEqual([soup]);
    expect((await stored(wrap)).web_featured).toBe(false);
  });

  it("can be several, chosen together", async () => {
    const response = await h.api(manager, "POST", "/items/bulk", { ids: [wrap, steak], action: "feature" });
    expect(response.status).toBe(200);
    expect(await featuredIds()).toEqual([soup, wrap, steak].sort());
    expect((await h.api(owner, "GET", "/overview")).body.counts.featured).toBe(3);
    // The dashboard can list just these.
    const listed = (await h.api(owner, "GET", "/items?featured=true")).body.items.map((item) => item.id).sort();
    expect(listed).toEqual([soup, wrap, steak].sort());
    expect((await h.api(owner, "GET", "/items?featured=false")).body.items.map((item) => item.id)).toEqual([salad]);
  });

  it("can be unmarked again, one or several", async () => {
    expect((await feature(soup, false)).body.item.featured).toBe(false);
    expect(await featuredIds()).toEqual([wrap, steak].sort());
    await h.api(owner, "POST", "/items/bulk", { ids: [wrap, steak], action: "unfeature" });
    expect(await featuredIds()).toEqual([]);
    expect((await publicMenu()).status).toBe(200);
  });

  it("accepts only true or false", async () => {
    for (const bad of ["yes", 1, null, "true"]) {
      const response = await feature(salad, bad);
      expect(response.status, String(bad)).toBe(422);
    }
    expect((await stored(salad)).web_featured).toBe(false);
  });

  it("can only be changed by the restaurant's own owner or manager", async () => {
    expect((await feature(salad, true, staff)).status).toBe(403);
    expect((await h.api(staff, "POST", "/items/bulk", { ids: [salad], action: "feature" })).status).toBe(403);
    expect((await feature(salad, true, outsider)).status).toBe(404);
    expect((await h.api(outsider, "POST", "/items/bulk", { ids: [salad], action: "feature" })).status).toBe(422);
    expect((await h.api(null, "PATCH", `/items/${salad}`, { website: { featured: true } })).status).toBe(401);
    expect((await stored(salad)).web_featured).toBe(false);
    expect(await featuredIds()).toEqual([]);
  });

  it("stay as the owner chose them through synchronisation with Clover, in both directions", async () => {
    await feature(steak, true);
    h.clover.items.get(steak).price = 3500;
    h.clover.items.get(salad).name = "House Salad";
    expect((await h.api(owner, "POST", "/clover/sync")).status).toBe(200);
    // The featured one is still featured; the others were not featured by the sync.
    expect(await featuredIds()).toEqual([steak]);
    expect((await publicItem(steak)).price_cents).toBe(3500);
    expect((await publicItem(salad)).name).toBe("House Salad");
    expect(h.clover.calls.some((call) => JSON.stringify(call.body ?? "").includes("featured"))).toBe(false);
  });

  it("are not shown to the public while the dish itself is hidden, out of Clover, or archived", async () => {
    await h.api(owner, "PATCH", `/items/${steak}`, { website: { web_hidden: true } });
    expect(await featuredIds()).toEqual([]);
    expect((await stored(steak)).web_featured).toBe(true);
    await h.api(owner, "PATCH", `/items/${steak}`, { website: { web_hidden: false } });
    expect(await featuredIds()).toEqual([steak]);
  });
});
