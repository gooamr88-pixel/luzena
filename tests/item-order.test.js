// The order of the items inside a category, as the website lists them. It is the website's
// own (menu_item_categories.position): the owner sets it in the dashboard, Clover is never
// asked to change, and synchronisation keeps it. Real handlers, real SQL (PGlite), a fake
// Clover.
import { beforeAll, describe, expect, it } from "vitest";
import { handlePublicMenu } from "../supabase/functions/_shared/public/menu.ts";
import { createHarness, ORIGIN } from "./helpers/harness.js";

let h, alpha, beta, owner, manager, staff, outsider, starters, mains, betaCategory;
let soup, wrap, steak, salad, burger;

const publicMenu = async (slug = "alpha") => {
  const response = await handlePublicMenu(new Request(`https://fn.test/public-menu?restaurant=${slug}`, { headers: { origin: ORIGIN } }), h.deps, "https://files.test");
  return JSON.parse(await response.text());
};
const publicOrder = async (categoryId, slug = "alpha") =>
  (await publicMenu(slug)).categories.find((category) => category.id === categoryId).items.map((item) => item.id);
const dashboardOrder = async (categoryId, user = owner) =>
  (await h.api(user, "GET", `/items?category=${categoryId}&sort=custom&limit=100`)).body.items.map((item) => item.id);
const reorder = (categoryId, ids, user = owner) => h.api(user, "POST", `/categories/${categoryId}/items/reorder`, { ids });

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
  soup = h.clover.addItem("Soup", 700);
  wrap = h.clover.addItem("Wrap", 1100);
  steak = h.clover.addItem("Steak", 3200);
  salad = h.clover.addItem("Salad", 900);
  burger = h.clover.addItem("Burger", 1500);
  for (const id of [soup, wrap, steak, salad]) h.clover.link(id, starters);
  // The steak is in two categories, and has a place in each.
  for (const id of [steak, burger]) h.clover.link(id, mains);
  await h.connect(alpha);
  await h.api(owner, "POST", "/clover/sync");
  await h.api(owner, "POST", "/items/bulk", { ids: [soup, wrap, steak, salad, burger], action: "show" });

  // Another restaurant with a category of its own, to aim at.
  await h.pg.query(
    "insert into public.menu_categories (restaurant_id, clover_id, name, sort_order) values ($1, 'BETACATEGORY1', 'Theirs', 1)",
    [beta],
  );
  betaCategory = "BETACATEGORY1";
});

describe("the order of the items in a category", () => {
  it("starts as Clover lists them, the same in the dashboard and on the website", async () => {
    expect(await publicOrder(starters)).toEqual([soup, wrap, steak, salad]);
    expect(await dashboardOrder(starters)).toEqual([soup, wrap, steak, salad]);
  });

  it("is set by the owner, and the website lists the items in exactly that order", async () => {
    const callsBefore = h.clover.calls.length;
    const response = await reorder(starters, [salad, steak, soup, wrap]);
    expect(response.status).toBe(200);
    expect(response.body.result).toBe("saved");
    expect(await publicOrder(starters)).toEqual([salad, steak, soup, wrap]);
    expect(await dashboardOrder(starters)).toEqual([salad, steak, soup, wrap]);
    // Clover is not asked to change anything.
    expect(h.clover.calls.length).toBe(callsBefore);
  });

  it("can be changed again, as often as the owner likes", async () => {
    await reorder(starters, [wrap, soup, salad, steak]);
    expect(await publicOrder(starters)).toEqual([wrap, soup, salad, steak]);
    await reorder(starters, [steak, wrap, soup, salad]);
    expect(await publicOrder(starters)).toEqual([steak, wrap, soup, salad]);
  });

  it("is kept for each category on its own: a dish in two categories has a place in each", async () => {
    const mainsBefore = await publicOrder(mains);
    await reorder(starters, [soup, steak, wrap, salad]);
    expect(await publicOrder(mains)).toEqual(mainsBefore);
    await reorder(mains, [burger, steak]);
    expect(await publicOrder(mains)).toEqual([burger, steak]);
    expect(await publicOrder(starters)).toEqual([soup, steak, wrap, salad]);
  });

  it("puts the items named first, and keeps the others after them in the order they had", async () => {
    await reorder(starters, [soup, wrap, steak, salad]);
    await reorder(starters, [salad]);
    expect(await publicOrder(starters)).toEqual([salad, soup, wrap, steak]);
  });

  it("ignores an item that is not in the category, and orders the rest", async () => {
    await reorder(starters, [steak, burger, salad, soup, wrap]);
    expect(await publicOrder(starters)).toEqual([steak, salad, soup, wrap]);
    expect(await publicOrder(mains)).toEqual([burger, steak]);
  });

  it("is written to the activity log", async () => {
    const { rows } = await h.pg.query(
      "select entity_type, entity_id, new_values, result from public.audit_logs where action = 'ITEMS_REORDERED' order by id desc limit 1",
    );
    expect(rows[0]).toMatchObject({ entity_type: "category", entity_id: starters, result: "success" });
    expect(rows[0].new_values).toEqual({ count: 5 });
  });
});

describe("synchronisation with Clover", () => {
  it("keeps the owner's order, through a rename and a new price in Clover", async () => {
    await reorder(starters, [salad, wrap, steak, soup]);
    h.clover.items.get(soup).name = "Soup of the day";
    h.clover.items.get(wrap).price = 1250;
    expect((await h.api(owner, "POST", "/clover/sync")).status).toBe(200);
    expect(await publicOrder(starters)).toEqual([salad, wrap, steak, soup]);
    expect(await dashboardOrder(starters)).toEqual([salad, wrap, steak, soup]);
  });

  it("puts an item added to the category in Clover at the end, and moves nothing else", async () => {
    const bread = h.clover.addItem("Bread", 300);
    h.clover.link(bread, starters);
    await h.api(owner, "POST", "/clover/sync");
    await h.api(owner, "POST", "/items/bulk", { ids: [bread], action: "show" });
    expect(await publicOrder(starters)).toEqual([salad, wrap, steak, soup, bread]);
    // And it can be placed like any other.
    await reorder(starters, [bread, salad, wrap, steak, soup]);
    expect(await publicOrder(starters)).toEqual([bread, salad, wrap, steak, soup]);
  });

  it("keeps a hidden item's place for when it is shown again", async () => {
    const order = await publicOrder(starters);
    await h.api(owner, "PATCH", `/items/${wrap}`, { website: { web_hidden: true } });
    expect(await publicOrder(starters)).toEqual(order.filter((id) => id !== wrap));
    await h.api(owner, "PATCH", `/items/${wrap}`, { website: { web_hidden: false } });
    expect(await publicOrder(starters)).toEqual(order);
  });
});

describe("who may change it", () => {
  it("a manager may", async () => {
    const order = await publicOrder(starters);
    const reversed = [...order].reverse();
    expect((await reorder(starters, reversed, manager)).status).toBe(200);
    expect(await publicOrder(starters)).toEqual(reversed);
  });

  it("staff may see the order and not change it; nobody without a session may do either", async () => {
    const order = await publicOrder(starters);
    expect(await dashboardOrder(starters, staff)).toEqual(order);
    const refused = await reorder(starters, [...order].reverse(), staff);
    expect(refused.status).toBe(403);
    const anonymous = await h.api(null, "POST", `/categories/${starters}/items/reorder`, { ids: [...order].reverse() });
    expect(anonymous.status).toBe(401);
    expect(await publicOrder(starters)).toEqual(order);
  });

  // A category of another restaurant gets the same answer as one that does not exist, so
  // the answer says nothing about what other restaurants have.
  const notHere = (response) => {
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({ category: "contains an entry that does not exist" });
  };

  it("another restaurant's owner cannot change this restaurant's order", async () => {
    const order = await publicOrder(starters);
    notHere(await reorder(starters, [...order].reverse(), outsider));
    expect(await publicOrder(starters)).toEqual(order);
  });

  it("this restaurant's owner cannot reach the other restaurant's category", async () => {
    notHere(await reorder(betaCategory, [soup], owner));
    notHere(await reorder("NOSUCHCATEGOR", [soup], owner));
  });
});

describe("what is refused", () => {
  it("an empty list, the same item twice, and anything that is not an item id", async () => {
    const order = await publicOrder(starters);
    for (const ids of [[], [soup, soup], ["not-an-id"], [123], null]) {
      const response = await reorder(starters, ids);
      expect(response.status, JSON.stringify(ids)).toBe(422);
    }
    expect((await h.api(owner, "POST", `/categories/${starters}/items/reorder`, {})).status).toBe(422);
    expect(await publicOrder(starters)).toEqual(order);
  });
});
