// Menu labels (dietary and descriptive attributes of a dish) and the allergy notice. Both
// are each restaurant's own, unknown to Clover, and say only what someone at the restaurant
// has said. Real handlers, real SQL (PGlite), a fake Clover.
//
// The dishes, labels and wording here are test data. None of it describes a real menu.
import { beforeAll, describe, expect, it } from "vitest";
import { LABEL_ICONS, MAX_LABELS, MAX_LABELS_PER_ITEM, NOTICE_LANGUAGES } from "../supabase/functions/_shared/dashboard/labels.ts";
import { handlePublicMenu } from "../supabase/functions/_shared/public/menu.ts";
import { LABEL_ICON_NAMES } from "../src/js/lib/label-icons.js";
import { createHarness, ORIGIN } from "./helpers/harness.js";

let h, alpha, beta, owner, manager, staff, outsider, starters, soup, wrap, steak;

const publicMenu = async (slug = "alpha") => {
  const response = await handlePublicMenu(new Request(`https://fn.test/public-menu?restaurant=${slug}`, { headers: { origin: ORIGIN } }), h.deps, "https://files.test");
  return { status: response.status, body: JSON.parse(await response.text()) };
};
const publicItem = async (id, slug = "alpha") =>
  (await publicMenu(slug)).body.categories.flatMap((category) => category.items).find((item) => item.id === id);
const labels = async (user = owner) => (await h.api(user, "GET", "/labels")).body.labels;
const byName = async (name, user = owner) => (await labels(user)).find((label) => label.name === name);
const setLabels = (id, labelIds, user = owner) => h.api(user, "PATCH", `/items/${id}`, { website: { label_ids: labelIds } });
const assigned = async (id) =>
  (await h.pg.query("select label_id from public.menu_item_labels where item_clover_id = $1 order by label_id", [id])).rows.map((row) => row.label_id);

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
  wrap = h.clover.addItem("Chicken Wrap", 1100);
  steak = h.clover.addItem("Vegetable Pasta", 1500);
  for (const id of [soup, wrap, steak]) h.clover.link(id, starters);
  await h.connect(alpha);
  await h.api(owner, "POST", "/clover/sync");
  await h.api(owner, "POST", "/items/bulk", { ids: [soup, wrap, steak], action: "show" });
});

describe("the icon set", () => {
  it("is the same list in the backend, which checks a label's icon, and on the website, which draws it", () => {
    expect([...LABEL_ICONS].sort()).toEqual([...LABEL_ICON_NAMES].sort());
    expect(new Set(LABEL_ICONS).size).toBe(LABEL_ICONS.length);
  });
});

describe("a restaurant's labels", () => {
  it("start as a vocabulary of nine, in use, on no dish at all", async () => {
    const list = await labels();
    expect(list.map((label) => label.name)).toEqual([
      "Spicy", "Vegetarian", "Vegan", "Contains Nuts", "Contains Dairy", "Contains Gluten", "Popular", "New", "Chef's Choice",
    ]);
    expect(list.map((label) => label.icon)).toEqual(["flame", "leaf", "sprout", "nut", "milk", "wheat", "star", "sparkle", "chef-hat"]);
    expect(list.every((label) => label.active && label.item_count === 0 && label.description === null)).toBe(true);
    expect((await h.pg.query("select count(*)::int as n from public.menu_item_labels")).rows[0].n).toBe(0);
  });

  it("are never put on a dish by its name: a 'Vegetable Pasta' is not vegan until someone says so", async () => {
    const menu = await publicMenu();
    for (const item of menu.body.categories[0].items) {
      expect(item.labels, item.name).toEqual([]);
    }
    expect((await h.api(owner, "GET", `/items/${steak}`)).body.item.label_ids).toEqual([]);
  });

  it("are given once: an owner who deletes one is not given it back", async () => {
    const before = await labels();
    const gone = before.find((label) => label.name === "New");
    expect((await h.api(owner, "DELETE", `/labels/${gone.id}`)).status).toBe(200);
    const after = await labels();
    expect(after).toHaveLength(8);
    expect(after.some((label) => label.name === "New")).toBe(false);
  });

  it("can be added to: a name, an icon from the set, an optional short description", async () => {
    const response = await h.api(owner, "POST", "/labels", { name: "  Halal ", icon: "seal", description: "Prepared to halal standards." });
    expect(response.status).toBe(201);
    const created = response.body.labels.at(-1);
    expect(created).toMatchObject({ name: "Halal", icon: "seal", description: "Prepared to halal standards.", active: true, item_count: 0 });
    expect(created.id).toBe(response.body.id);
    // It goes to the end of the order.
    expect(response.body.labels.map((label) => label.name).at(-1)).toBe("Halal");
    // A manager can, too; the description may be left out.
    const second = await h.api(manager, "POST", "/labels", { name: "Seasonal", icon: "sun" });
    expect(second.status).toBe(201);
    expect(second.body.labels.at(-1)).toMatchObject({ name: "Seasonal", description: null });
  });

  it("refuses a name already in use (whatever its capitals), an icon outside the set, and what is too long or empty", async () => {
    const duplicate = await h.api(owner, "POST", "/labels", { name: "halal", icon: "seal" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("duplicate");
    for (const bad of [
      { name: "Kosher", icon: "skull" }, { name: "Kosher", icon: "<svg onload=alert(1)>" }, { name: "Kosher" },
      { name: "", icon: "seal" }, { name: "   ", icon: "seal" }, { name: "x".repeat(41), icon: "seal" },
      { name: "Kosher", icon: "seal", description: "x".repeat(161) }, { name: "Kosher", icon: "seal", colour: "red" },
    ]) {
      const response = await h.api(owner, "POST", "/labels", bad);
      expect(response.status, JSON.stringify(bad).slice(0, 50)).toBe(422);
    }
    expect((await labels()).some((label) => label.name === "Kosher")).toBe(false);
  });

  it("can be edited: renamed, given another icon, described, and the description removed", async () => {
    const halal = await byName("Halal");
    const renamed = await h.api(owner, "PATCH", `/labels/${halal.id}`, { name: "Halal Certified", icon: "heart", description: null });
    expect(renamed.status).toBe(200);
    expect(renamed.body.labels.find((label) => label.id === halal.id)).toMatchObject({ name: "Halal Certified", icon: "heart", description: null });
    // Renaming to another label's name is refused, and changes nothing.
    const clash = await h.api(owner, "PATCH", `/labels/${halal.id}`, { name: "SPICY" });
    expect(clash.status).toBe(409);
    expect((await byName("Halal Certified")).id).toBe(halal.id);
    expect((await h.api(owner, "PATCH", `/labels/${halal.id}`, {})).status).toBe(422);
    await h.api(owner, "PATCH", `/labels/${halal.id}`, { name: "Halal", icon: "seal" });
  });

  it("can be put in any order, and refuses an order that leaves one out, repeats one or names a stranger's", async () => {
    const before = await labels();
    const ids = before.map((label) => label.id);
    const reversed = [...ids].reverse();
    const response = await h.api(owner, "POST", "/labels/reorder", { ids: reversed });
    expect(response.status).toBe(200);
    expect(response.body.labels.map((label) => label.id)).toEqual(reversed);
    expect((await labels()).map((label) => label.id)).toEqual(reversed);

    expect((await h.api(owner, "POST", "/labels/reorder", { ids: ids.slice(1) })).status).toBe(409);
    expect((await h.api(owner, "POST", "/labels/reorder", { ids: [...ids.slice(1), ids[1]] })).status).toBe(422);
    expect((await h.api(owner, "POST", "/labels/reorder", { ids: [...ids.slice(1), "00000000-0000-4000-8000-00000000ffff"] })).status).toBe(409);
    await h.api(owner, "POST", "/labels/reorder", { ids });
    expect((await labels()).map((label) => label.id)).toEqual(ids);
  });

  it("are limited in number, and say so", async () => {
    const have = (await labels()).length;
    for (let n = have; n < MAX_LABELS; n++) {
      expect((await h.api(owner, "POST", "/labels", { name: `Filler ${n}`, icon: "seal" })).status).toBe(201);
    }
    const over = await h.api(owner, "POST", "/labels", { name: "One too many", icon: "seal" });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("labels_full");
    await h.pg.query("delete from public.menu_labels where restaurant_id = $1 and name like 'Filler %'", [alpha]);
    expect((await labels()).length).toBe(have);
  });
});

describe("labels on a dish", () => {
  let spicy, vegetarian, nuts, popular;

  beforeAll(async () => {
    [spicy, vegetarian, nuts, popular] = await Promise.all(["Spicy", "Vegetarian", "Contains Nuts", "Popular"].map((name) => byName(name)));
  });

  it("are set by the owner, several at once, without calling Clover", async () => {
    const callsBefore = h.clover.calls.length;
    const response = await setLabels(soup, [popular.id, spicy.id, vegetarian.id]);
    expect(response.status).toBe(200);
    expect(response.body.clover_changed).toBe(false);
    expect(h.clover.calls.length).toBe(callsBefore);
    // The dashboard is given the ids; the order is the labels' own, not the order sent.
    expect(response.body.item.label_ids).toEqual([spicy.id, vegetarian.id, popular.id]);
    expect((await byName("Spicy")).item_count).toBe(1);
  });

  it("reach the public menu as name, icon and description, in the restaurant's order, and nothing else", async () => {
    await h.api(owner, "PATCH", `/labels/${spicy.id}`, { description: "Made with fresh chillies." });
    const item = await publicItem(soup);
    expect(item.labels).toEqual([
      { name: "Spicy", icon: "flame", description: "Made with fresh chillies." },
      { name: "Vegetarian", icon: "leaf", description: null },
      { name: "Popular", icon: "star", description: null },
    ]);
    // No id, no restaurant, no internal field.
    expect(JSON.stringify(item.labels)).not.toMatch(/"id"|restaurant|sort_order|active/);
    // A dish nobody has labelled carries an empty list, not a missing one.
    expect((await publicItem(wrap)).labels).toEqual([]);
  });

  it("follow a change of order", async () => {
    const ids = (await labels()).map((label) => label.id);
    const popularFirst = [popular.id, ...ids.filter((id) => id !== popular.id)];
    await h.api(owner, "POST", "/labels/reorder", { ids: popularFirst });
    expect((await publicItem(soup)).labels.map((label) => label.name)).toEqual(["Popular", "Spicy", "Vegetarian"]);
    await h.api(owner, "POST", "/labels/reorder", { ids });
  });

  it("are replaced as a set: what is sent is exactly what the dish then carries", async () => {
    expect((await setLabels(soup, [spicy.id, nuts.id])).body.item.label_ids).toEqual([spicy.id, nuts.id]);
    expect((await publicItem(soup)).labels.map((label) => label.name)).toEqual(["Spicy", "Contains Nuts"]);
    // The same set again changes nothing and duplicates nothing.
    await setLabels(soup, [spicy.id, nuts.id]);
    expect(await assigned(soup)).toHaveLength(2);
    // An empty list takes them all off.
    expect((await setLabels(soup, [])).body.item.label_ids).toEqual([]);
    expect((await publicItem(soup)).labels).toEqual([]);
    await setLabels(soup, [spicy.id, vegetarian.id, popular.id]);
  });

  it("leave the dish's other website choices alone, and are left alone by them", async () => {
    await h.api(owner, "PATCH", `/items/${soup}`, { website: { description: "Test wording.", featured: true } });
    expect((await h.api(owner, "GET", `/items/${soup}`)).body.item.label_ids).toHaveLength(3);
    await setLabels(soup, [spicy.id]);
    const item = (await h.api(owner, "GET", `/items/${soup}`)).body.item;
    expect(item).toMatchObject({ description: "Test wording.", featured: true });
    await setLabels(soup, [spicy.id, vegetarian.id, popular.id]);
  });

  it("refuse a label that does not exist, the same one twice, too many, and anything that is not an id", async () => {
    const before = await assigned(soup);
    for (const bad of [
      [spicy.id, "00000000-0000-4000-8000-00000000ffff"], [spicy.id, spicy.id], ["spicy"], "Spicy", [42],
      Array.from({ length: MAX_LABELS_PER_ITEM + 1 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
    ]) {
      const response = await setLabels(soup, bad);
      expect(response.status, JSON.stringify(bad).slice(0, 40)).toBe(422);
    }
    expect(await assigned(soup)).toEqual(before);
  });

  it("refuse a label that does not exist before anything else in the save is written, in Clover or on the website", async () => {
    // A label deleted in another tab while the editor was open.
    const gone = (await h.api(owner, "POST", "/labels", { name: "Gone Soon", icon: "clock" })).body.id;
    await h.api(owner, "DELETE", `/labels/${gone}`);
    const before = (await h.api(owner, "GET", `/items/${wrap}`)).body.item;
    const callsBefore = h.clover.calls.length;

    const response = await h.api(owner, "PATCH", `/items/${wrap}`, {
      clover: { price_cents: before.price_cents + 100 }, expected: { price_cents: before.price_cents },
      website: { description: "Written while the label was being deleted.", label_ids: [gone] },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({ "website.label_ids": "contains a label that does not exist" });
    // Nothing was sent to Clover, and nothing changed here.
    expect(h.clover.calls.length).toBe(callsBefore);
    const after = (await h.api(owner, "GET", `/items/${wrap}`)).body.item;
    expect(after.price_cents).toBe(before.price_cents);
    expect(after.description).toBe(before.description);
    expect(after.label_ids).toEqual(before.label_ids);

    // A new dish with such a label is not created in Clover either.
    const created = await h.api(owner, "POST", "/items", {
      clover: { name: "Never Made", price_cents: 500 }, website: { label_ids: [gone] },
    }, { "idempotency-key": "never-made-0001" });
    expect(created.status).toBe(422);
    expect(h.clover.calls.length).toBe(callsBefore);
  });

  it("are hidden on the website while their label is switched off, and come back with it", async () => {
    const off = await h.api(owner, "PATCH", `/labels/${spicy.id}`, { active: false });
    expect(off.body.message).toContain("hidden on the website");
    expect((await publicItem(soup)).labels.map((label) => label.name)).toEqual(["Vegetarian", "Popular"]);
    // The dish still carries it: nothing was taken off.
    expect((await h.api(owner, "GET", `/items/${soup}`)).body.item.label_ids).toContain(spicy.id);
    expect((await byName("Spicy")).item_count).toBe(1);
    await h.api(owner, "PATCH", `/labels/${spicy.id}`, { active: true });
    expect((await publicItem(soup)).labels.map((label) => label.name)).toEqual(["Spicy", "Vegetarian", "Popular"]);
  });

  it("go from every dish when their label is deleted, and the answer says how many", async () => {
    const extra = (await h.api(owner, "POST", "/labels", { name: "Limited Time", icon: "clock" })).body;
    await setLabels(wrap, [extra.id]);
    await setLabels(steak, [extra.id, popular.id]);
    const response = await h.api(owner, "DELETE", `/labels/${extra.id}`);
    expect(response.body.message).toBe("Label deleted and taken off 2 dishes.");
    expect((await publicItem(wrap)).labels).toEqual([]);
    expect((await publicItem(steak)).labels.map((label) => label.name)).toEqual(["Popular"]);
    expect((await h.api(owner, "DELETE", `/labels/${extra.id}`)).status).toBe(404);
    await setLabels(steak, []);
  });
});

describe("who may change labels", () => {
  it("owners and managers; staff may see them and nothing more; nobody without a session", async () => {
    const spicy = await byName("Spicy");
    expect((await h.api(staff, "GET", "/labels")).status).toBe(200);
    expect((await h.api(staff, "POST", "/labels", { name: "By Staff", icon: "seal" })).status).toBe(403);
    expect((await h.api(staff, "PATCH", `/labels/${spicy.id}`, { active: false })).status).toBe(403);
    expect((await h.api(staff, "DELETE", `/labels/${spicy.id}`)).status).toBe(403);
    expect((await h.api(staff, "POST", "/labels/reorder", { ids: [spicy.id] })).status).toBe(403);
    expect((await setLabels(wrap, [spicy.id], staff)).status).toBe(403);
    for (const [method, path, body] of [["GET", "/labels"], ["POST", "/labels", { name: "X", icon: "seal" }], ["DELETE", `/labels/${spicy.id}`]]) {
      expect((await h.api(null, method, path, body)).status, `${method} ${path}`).toBe(401);
    }
    expect((await byName("Spicy")).active).toBe(true);
    expect((await publicItem(wrap)).labels).toEqual([]);
  });
});

describe("one restaurant and another", () => {
  let theirs, mine;

  it("each has its own labels: the other's are not listed, and its own start afresh", async () => {
    mine = await labels(owner);
    theirs = await labels(outsider);
    expect(theirs).toHaveLength(9);
    expect(theirs.map((label) => label.name)).toContain("New");
    const mineIds = new Set(mine.map((label) => label.id));
    expect(theirs.some((label) => mineIds.has(label.id))).toBe(false);
    // A name in use at one is free at the other.
    expect((await h.api(outsider, "POST", "/labels", { name: "Halal", icon: "seal" })).status).toBe(201);
  });

  it("cannot edit, switch off, delete or reorder the other's labels", async () => {
    const target = mine.find((label) => label.name === "Spicy");
    expect((await h.api(outsider, "PATCH", `/labels/${target.id}`, { name: "Changed" })).status).toBe(404);
    expect((await h.api(outsider, "PATCH", `/labels/${target.id}`, { active: false })).status).toBe(404);
    expect((await h.api(outsider, "DELETE", `/labels/${target.id}`)).status).toBe(404);
    expect((await h.api(outsider, "POST", "/labels/reorder", { ids: mine.map((label) => label.id) })).status).toBe(409);
    expect(await byName("Spicy")).toMatchObject({ id: target.id, active: true });
  });

  it("cannot put its labels on the other's dishes, nor the other's labels on its own", async () => {
    const before = await assigned(soup);
    expect((await setLabels(soup, [theirs[0].id], outsider)).status).toBe(404);
    expect((await setLabels(soup, [theirs[0].id], owner)).status).toBe(422);
    expect(await assigned(soup)).toEqual(before);
    // The database refuses it too, whatever the code above it does.
    await expect(h.pg.query(
      "insert into public.menu_item_labels (restaurant_id, item_clover_id, label_id) values ($1, $2, $3)", [alpha, soup, theirs[0].id],
    )).rejects.toThrow(/foreign key/i);
  });

  it("shows each restaurant's public menu its own labels only", async () => {
    const text = JSON.stringify((await publicMenu()).body);
    expect(text).toContain("Spicy");
    expect((await publicMenu("beta")).status).not.toBe(200); // beta has no menu at all yet
  });
});

describe("synchronisation with Clover", () => {
  it("leaves labels exactly as they were: none removed, none added, none duplicated", async () => {
    const before = {
      labels: await labels(),
      links: (await h.pg.query("select * from public.menu_item_labels order by item_clover_id, label_id")).rows,
      public: (await publicItem(soup)).labels,
    };
    h.clover.items.get(soup).name = "Soup of the Day";
    h.clover.items.get(soup).price = 850;
    const added = h.clover.addItem("Brand New Dish", 500);
    h.clover.link(added, starters);
    expect((await h.api(owner, "POST", "/clover/sync")).status).toBe(200);
    expect((await h.api(owner, "POST", "/clover/sync")).status).toBe(200);

    expect(await labels()).toEqual(before.labels);
    expect((await h.pg.query("select * from public.menu_item_labels order by item_clover_id, label_id")).rows).toEqual(before.links);
    const item = await publicItem(soup);
    expect(item).toMatchObject({ name: "Soup of the Day", price_cents: 850 });
    expect(item.labels).toEqual(before.public);
    // The dish that arrived from Clover has no label: nothing is guessed from a name.
    expect((await h.api(owner, "GET", `/items/${added}`)).body.item.label_ids).toEqual([]);
    // And Clover was never told about labels.
    expect(h.clover.calls.some((call) => /label/i.test(JSON.stringify(call.body ?? "")))).toBe(false);
  });

  it("keeps a dish's labels while Clover does not have the dish, for when it comes back", async () => {
    const saved = h.clover.items.get(soup);
    const before = await assigned(soup);
    h.clover.items.delete(soup);
    await h.api(owner, "POST", "/clover/sync");
    expect(await publicItem(soup)).toBeUndefined();
    expect(await assigned(soup)).toEqual(before);
    h.clover.items.set(soup, saved);
    h.clover.link(soup, starters);
    await h.api(owner, "POST", "/clover/sync");
    expect((await publicItem(soup)).labels.map((label) => label.name)).toEqual(["Spicy", "Vegetarian", "Popular"]);
  });
});

describe("the allergy notice", () => {
  const notice = async (user = owner) => (await h.api(user, "GET", "/site/notice")).body;
  const save = (body, user = owner) => h.api(user, "PUT", "/site/notice", body);
  const WORDING = "Test wording only: please tell our staff about any allergy before you order.";

  it("is off and empty to begin with, and the public menu carries none", async () => {
    const start = await notice();
    expect(start.notice).toMatchObject({ enabled: false, entries: [] });
    expect([...start.languages]).toEqual([...NOTICE_LANGUAGES]);
    expect((await publicMenu()).body.notice).toBeNull();
  });

  it("can be written and kept switched off: the public menu still carries none", async () => {
    const response = await save({ enabled: false, entries: [{ lang: "en", text: WORDING }] });
    expect(response.status).toBe(200);
    expect(response.body.notice).toMatchObject({ enabled: false, entries: [{ lang: "en", text: WORDING }] });
    expect(response.body.message).toContain("switched off");
    expect((await publicMenu()).body.notice).toBeNull();
  });

  it("is on the public menu once switched on, in every language it was written in, in order", async () => {
    const arabic = "نص تجريبي فقط: يرجى إبلاغ الموظفين بأي حساسية قبل الطلب.";
    const response = await save({ enabled: true, entries: [{ lang: "en", text: `  ${WORDING} ` }, { lang: "ar", text: arabic }, { lang: "es", text: "" }] });
    expect(response.status).toBe(200);
    // Trimmed, and the language left empty is not kept.
    expect((await publicMenu()).body.notice).toEqual([{ lang: "en", text: WORDING }, { lang: "ar", text: arabic }]);
    expect((await notice()).notice.entries).toHaveLength(2);
  });

  it("is stored as plain text: markup in it is kept as the characters it is", async () => {
    const hostile = `<script>alert(1)</script> & <b>bold</b>`;
    await save({ enabled: true, entries: [{ lang: "en", text: hostile }] });
    expect((await publicMenu()).body.notice).toEqual([{ lang: "en", text: hostile }]);
    await save({ enabled: true, entries: [{ lang: "en", text: WORDING }] });
  });

  it("can be switched off again without losing its wording", async () => {
    await save({ enabled: false, entries: [{ lang: "en", text: WORDING }] });
    expect((await publicMenu()).body.notice).toBeNull();
    expect((await notice()).notice.entries).toEqual([{ lang: "en", text: WORDING }]);
    await save({ enabled: true, entries: [{ lang: "en", text: WORDING }] });
  });

  it("refuses to be switched on empty, a language it does not offer, the same language twice, and what is too long", async () => {
    for (const bad of [
      { enabled: true, entries: [] }, { enabled: true, entries: [{ lang: "en", text: "   " }] },
      { enabled: true, entries: [{ lang: "xx", text: WORDING }] },
      { enabled: true, entries: [{ lang: "en", text: WORDING }, { lang: "en", text: "Again." }] },
      { enabled: true, entries: [{ lang: "en", text: "x".repeat(601) }] },
      { enabled: "yes", entries: [] }, { entries: [{ lang: "en", text: WORDING }] },
      { enabled: true, entries: [{ lang: "en", text: WORDING, html: true }] },
    ]) {
      expect((await save(bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(422);
    }
    expect((await publicMenu()).body.notice).toEqual([{ lang: "en", text: WORDING }]);
  });

  it("can only be read and changed by the restaurant's owner or manager", async () => {
    expect((await h.api(staff, "GET", "/site/notice")).status).toBe(403);
    expect((await save({ enabled: false, entries: [] }, staff)).status).toBe(403);
    expect((await h.api(null, "PUT", "/site/notice", { enabled: false, entries: [] })).status).toBe(401);
    expect((await save({ enabled: true, entries: [{ lang: "en", text: WORDING }] }, manager)).status).toBe(200);
    expect((await publicMenu()).body.notice).toEqual([{ lang: "en", text: WORDING }]);
  });

  it("is each restaurant's own: another restaurant sees and changes only its own", async () => {
    expect((await notice(outsider)).notice).toMatchObject({ enabled: false, entries: [] });
    const theirs = await save({ enabled: true, entries: [{ lang: "en", text: "The other restaurant's test wording." }] }, outsider);
    expect(theirs.status).toBe(200);
    // This restaurant's notice is untouched by it.
    expect((await notice()).notice.entries).toEqual([{ lang: "en", text: WORDING }]);
    expect((await publicMenu()).body.notice).toEqual([{ lang: "en", text: WORDING }]);
    const rows = (await h.pg.query("select restaurant_id from public.site_settings where allergy_notice_enabled order by restaurant_id")).rows;
    expect(rows.map((row) => row.restaurant_id).sort()).toEqual([alpha, beta].sort());
  });

  it("is not touched by synchronisation, and its wording is not written to the activity log", async () => {
    await h.api(owner, "POST", "/clover/sync");
    expect((await publicMenu()).body.notice).toEqual([{ lang: "en", text: WORDING }]);
    const { rows } = await h.pg.query("select new_values from public.audit_logs where action = 'ALLERGY_NOTICE_UPDATED' order by id desc limit 1");
    expect(rows[0].new_values).toEqual({ enabled: true, languages: ["en"] });
  });
});

describe("the database itself", () => {
  it("keeps the three new tables closed to the website's own roles, with row level security on and no policy", async () => {
    for (const table of ["menu_labels", "menu_item_labels", "site_settings"]) {
      const security = await h.pg.query("select relrowsecurity from pg_class where oid = $1::regclass", [`public.${table}`]);
      expect(security.rows[0].relrowsecurity, table).toBe(true);
      expect((await h.pg.query("select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = $1", [table])).rows[0].n, table).toBe(0);
      for (const role of ["anon", "authenticated"]) {
        const open = await h.pg.query("select has_table_privilege($1, $2, 'select, insert, update, delete') as open", [role, `public.${table}`]);
        expect(open.rows[0].open, `${role} on ${table}`).toBe(false);
      }
    }
  });

  it("keeps every new function closed to them too", async () => {
    const { rows } = await h.pg.query(
      `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'dash_label%' or p.proname like 'site_notice%'
         or p.proname in ('menu_labels_seed', 'web_set_item_labels', 'category_photos_orphaned', 'clover_auth_failed', 'clover_auth_ok'))`);
    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const { fn } of rows) {
      for (const role of ["anon", "authenticated"]) {
        const open = await h.pg.query("select has_function_privilege($1, $2, 'execute') as open", [role, fn]);
        expect(open.rows[0].open, `${role} on ${fn}`).toBe(false);
      }
    }
  });
});

describe("dietary tags a restaurant already had", () => {
  it("are carried over as labels on the same dishes when the change is applied, and decide nothing new", async () => {
    // A database as it was before the change, with two tagged dishes; then the migration.
    const { createTestDb, createRestaurant } = await import("./helpers/db.js");
    const { readFileSync } = await import("node:fs");
    const { pg } = await createTestDb({ upTo: "20261008001200_orphaned_category_photos.sql" });
    const restaurant = await createRestaurant(pg, "gamma");
    await pg.query(
      `insert into public.menu_items (restaurant_id, clover_id, name, web_dietary) values
         ($1, 'ITEM000000001', 'Dish One', '{vegetarian,spicy}'), ($1, 'ITEM000000002', 'Dish Two', '{gluten-free}'),
         ($1, 'ITEM000000003', 'Dish Three', '{}')`, [restaurant]);
    await pg.exec(readFileSync(new URL("../supabase/migrations/20261008001300_menu_labels_and_notice.sql", import.meta.url), "utf8"));

    const { rows } = await pg.query(
      `select il.item_clover_id as item, l.name from public.menu_item_labels il
       join public.menu_labels l on l.id = il.label_id order by il.item_clover_id, l.name`);
    expect(rows).toEqual([
      { item: "ITEM000000001", name: "Spicy" }, { item: "ITEM000000001", name: "Vegetarian" },
      { item: "ITEM000000002", name: "Gluten-Free" },
    ]);
    // The starting nine, plus the one tag in use that is not among them. No duplicates.
    const names = (await pg.query("select name from public.menu_labels where restaurant_id = $1 order by name", [restaurant])).rows.map((row) => row.name);
    expect(names).toHaveLength(10);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(10);
    // The old column is left as it was, for the website that is live while this is applied.
    expect((await pg.query("select web_dietary from public.menu_items where clover_id = 'ITEM000000001'")).rows[0].web_dietary).toEqual(["vegetarian", "spicy"]);
  });
});
