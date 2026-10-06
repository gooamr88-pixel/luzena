// Clover SANDBOX tests. These send real requests to apisandbox.dev.clover.com using this
// project's own Clover client, inventory calls and normaliser, so they test the real code
// against the real API. They exist to turn the "NOT VERIFIED" rows of
// CLOVER_CAPABILITY_MATRIX.md into facts.
//
// They are skipped unless credentials are provided:
//
//   CLOVER_SANDBOX_MERCHANT_ID   the test merchant's id (13 characters)
//   CLOVER_SANDBOX_TOKEN         an API token for that test merchant with Inventory read
//                                and write. Clover allows dashboard-generated tokens in the
//                                sandbox only; production must use OAuth.
//
// SAFETY
//   - Hard-wired to the sandbox host. There is no setting that points it at production.
//   - Everything it creates is named "ZZ-LUZENA-TEST ..." and deleted at the end. Deleting
//     is done here, for clean-up, with a direct DELETE call; the application itself never
//     deletes anything in Clover.
//   - Run it against a TEST merchant, never a real restaurant's sandbox data you care about.
//
// What is NOT covered here, because it needs the deployed app and a browser: the OAuth
// connection, the `state` round trip, webhooks, disconnect and reconnect. Those are the
// manual steps in CLOVER_SANDBOX_TEST_PLAN.md.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloverFetch } from "../../supabase/functions/_shared/clover/client.ts";
import { CLOVER_HOSTS } from "../../supabase/functions/_shared/clover/config.ts";
import { CloverError } from "../../supabase/functions/_shared/clover/errors.ts";
import {
  createCategory, createItem, createModifier, createModifierGroup, fetchInventory, findItemsByName, getItem,
  getModifierGroup, listCategories, setItemAssociations, updateCategory, updateItem, updateModifier, updateModifierGroup,
} from "../../supabase/functions/_shared/clover/inventory.ts";
import {
  buildSyncPayload, normalizeCategory, normalizeItem, normalizeModifierGroup,
} from "../../supabase/functions/_shared/clover/normalize.ts";

const MERCHANT = process.env.CLOVER_SANDBOX_MERCHANT_ID ?? "";
const TOKEN = process.env.CLOVER_SANDBOX_TOKEN ?? "";
const configured = /^[A-Z0-9]{13}$/.test(MERCHANT) && TOKEN.length > 10;
const BASE = CLOVER_HOSTS.sandbox.api;
const PREFIX = "ZZ-LUZENA-TEST";
const RUN = Date.now().toString(36).toUpperCase();

if (!configured) {
  console.log("\nClover sandbox tests SKIPPED: set CLOVER_SANDBOX_MERCHANT_ID and CLOVER_SANDBOX_TOKEN.\nSee CLOVER_SANDBOX_TEST_PLAN.md.\n");
}

const logs = [];
const deps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
  log: {
    info: (event, fields) => logs.push({ level: "info", event, ...fields }),
    warn: (event, fields) => logs.push({ level: "warn", event, ...fields }),
    error: (event, fields) => logs.push({ level: "error", event, ...fields }),
  },
};

const apiWith = (token) => ({
  merchantId: MERCHANT,
  request: (call) => cloverFetch(deps, BASE, token, call, `sandbox-${RUN}`),
});
const api = apiWith(TOKEN);

// Raw call for things the application never does (clean-up deletes, shape probes).
const raw = async (method, path, body) => {
  const response = await fetch(`${BASE}/v3/merchants/${MERCHANT}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
};

const created = { items: [], categories: [], groups: [] };
const state = (rawItem) => normalizeItem(rawItem, { categories: true, modifierGroups: true });

describe.skipIf(!configured)("Clover sandbox", () => {
  let itemId, categoryA, categoryB, groupId, modifierId;

  beforeAll(async () => {
    expect(BASE).toBe("https://apisandbox.dev.clover.com");
  });

  // Everything in the merchant whose name starts with the test prefix: what this run made,
  // and anything an interrupted earlier run left behind. Nothing else is ever selected.
  const leftovers = async () => {
    const named = (list) => list.filter((entry) => typeof entry?.name === "string" && entry.name.startsWith(PREFIX));
    const all = async (path) => (await raw("GET", `${path}?limit=1000`)).body?.elements ?? [];
    return {
      items: named(await all("/items")),
      groups: named(await all("/modifier_groups")),
      categories: named(await all("/categories")),
    };
  };
  const removeLeftovers = async () => {
    const found = await leftovers();
    for (const item of found.items) await raw("DELETE", `/items/${item.id}`).catch(() => {});
    for (const group of found.groups) await raw("DELETE", `/modifier_groups/${group.id}`).catch(() => {});
    for (const category of found.categories) await raw("DELETE", `/categories/${category.id}`).catch(() => {});
  };

  afterAll(async () => {
    // Clean-up only. Best effort: a failure here must not hide a test result. The last
    // test has normally done this already; this covers a run that stopped half way.
    for (const id of created.items) await raw("DELETE", `/items/${id}`).catch(() => {});
    for (const id of created.groups) await raw("DELETE", `/modifier_groups/${id}`).catch(() => {});
    for (const id of created.categories) await raw("DELETE", `/categories/${id}`).catch(() => {});
    await removeLeftovers().catch(() => {});
    const failures = logs.filter((entry) => entry.level !== "info");
    if (failures.length) console.log("Clover client warnings during the run:", JSON.stringify(failures, null, 2));
  });

  // -- Plan step 6, 7, 8: reading -----------------------------------------------------------

  it("[6] reads categories: rows are wrapped in `elements`, and expand=items lists item ids in order", async () => {
    const response = await raw("GET", "/categories?expand=items&limit=5");
    expect(response.status).toBe(200);
    // UA-5: list responses are { elements: [...] }.
    expect(Array.isArray(response.body.elements)).toBe(true);
    for (const category of response.body.elements) {
      expect(normalizeCategory(category), JSON.stringify(category)).not.toBeNull();
      if (category.items) expect(Array.isArray(category.items.elements)).toBe(true);
    }
    expect((await listCategories(api)).length).toBeGreaterThanOrEqual(response.body.elements.length);
  });

  it("[7] reads items with their categories and modifier groups, and pages with limit and offset", async () => {
    const first = await raw("GET", "/items?expand=categories%2CmodifierGroups&limit=1&offset=0");
    expect(first.status).toBe(200);
    expect(Array.isArray(first.body.elements)).toBe(true);
    expect(first.body.elements.length).toBeLessThanOrEqual(1);
    if (first.body.elements.length === 1) {
      const item = first.body.elements[0];
      expect(typeof item.id).toBe("string");
      expect(item.id).toMatch(/^[A-Z0-9]{13}$/);
      expect(typeof item.name).toBe("string");
      expect(Number.isInteger(item.price)).toBe(true);
      const second = await raw("GET", "/items?limit=1&offset=1");
      if (second.body.elements.length === 1) expect(second.body.elements[0].id).not.toBe(item.id);
    }
  });

  it("[8] reads modifier groups with their modifiers", async () => {
    const response = await raw("GET", "/modifier_groups?expand=modifiers&limit=5");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.elements)).toBe(true);
    for (const group of response.body.elements) expect(normalizeModifierGroup(group), JSON.stringify(group)).not.toBeNull();
  });

  it("[7] the whole live inventory passes this project's normaliser with nothing skipped", async () => {
    const inventory = await fetchInventory(api);
    const { payload, skipped } = buildSyncPayload(inventory);
    console.log(`inventory: ${payload.categories.length} categories, ${payload.items.length} items, ${payload.modifier_groups.length} modifier groups, ${skipped} skipped`);
    // A skipped row means Clover returned a shape the mirror would silently drop.
    expect(skipped).toBe(0);
  });

  // -- Plan step 9 to 13: writing (Dashboard -> Clover) --------------------------------------

  it("[9] creates an item and gets it back with the fields the mirror needs", async () => {
    const response = await createItem(api, { name: `${PREFIX} item ${RUN}`, price: 1234, priceType: "FIXED", available: true, hidden: false });
    const item = normalizeItem(response, { categories: false, modifierGroups: false });
    expect(item, JSON.stringify(response)).not.toBeNull();
    itemId = item.id;
    created.items.push(itemId);
    expect(item.price_cents).toBe(1234);
    expect(item.available).toBe(true);
    expect(item.hidden).toBe(false);
    // The conflict check and the reconcile-after-timeout search both rely on this field.
    expect(typeof response.modifiedTime).toBe("number");
    expect(response.modifiedTime).toBeGreaterThan(1e12);
  });

  it("[9] finds a just-created item by exact name (the reconcile-after-timeout search)", async () => {
    const name = `${PREFIX} item ${RUN}`;
    const matches = await findItemsByName(api, name, Date.now() - 10 * 60_000);
    // UA-9: `filter=name=<value>` is an exact match.
    expect(matches.map((match) => match.id)).toContain(itemId);
    expect(matches.every((match) => match.name === name)).toBe(true);
    const prefixOnly = await findItemsByName(api, PREFIX, Date.now() - 10 * 60_000);
    expect(prefixOnly.map((match) => match.id)).not.toContain(itemId);
  });

  it("[9] renames an item, and Clover moves modifiedTime forward", async () => {
    const before = await getItem(api, itemId);
    await updateItem(api, itemId, { name: `${PREFIX} renamed ${RUN}` });
    const after = await getItem(api, itemId);
    expect(after.name).toBe(`${PREFIX} renamed ${RUN}`);
    expect(after.modifiedTime).toBeGreaterThanOrEqual(before.modifiedTime);
    // A rename must not change the price.
    expect(after.price).toBe(1234);
  });

  it("[10] changes a price in cents", async () => {
    await updateItem(api, itemId, { price: 1575 });
    expect(state(await getItem(api, itemId)).price_cents).toBe(1575);
  });

  it("[12] marks an item out of stock and back", async () => {
    await updateItem(api, itemId, { available: false });
    expect(state(await getItem(api, itemId)).available).toBe(false);
    await updateItem(api, itemId, { available: true });
    expect(state(await getItem(api, itemId)).available).toBe(true);
  });

  it("[12] sets and clears `hidden`, which the website treats as 'not public'", async () => {
    await updateItem(api, itemId, { hidden: true });
    expect(state(await getItem(api, itemId)).hidden).toBe(true);
    await updateItem(api, itemId, { hidden: false });
    expect(state(await getItem(api, itemId)).hidden).toBe(false);
    // What `hidden` does at the register cannot be seen through the API: plan step M-7.
  });

  it("[11] creates categories, renames one and sets its sort order", async () => {
    categoryA = normalizeCategory(await createCategory(api, `${PREFIX} cat A ${RUN}`)).id;
    categoryB = normalizeCategory(await createCategory(api, `${PREFIX} cat B ${RUN}`)).id;
    created.categories.push(categoryA, categoryB);

    await updateCategory(api, categoryA, { name: `${PREFIX} cat A2 ${RUN}`, sortOrder: 9001 });
    const renamed = (await listCategories(api)).map(normalizeCategory).find((category) => category?.id === categoryA);
    expect(renamed.name).toBe(`${PREFIX} cat A2 ${RUN}`);
    expect(renamed.sort_order).toBe(9001);
  });

  it("[11] assigns an item to a category, then moves it to another", async () => {
    await setItemAssociations(api, "category_items", itemId, [], [categoryA]);
    expect(state(await getItem(api, itemId)).category_ids).toEqual([categoryA]);

    await setItemAssociations(api, "category_items", itemId, [categoryA], [categoryB]);
    expect(state(await getItem(api, itemId)).category_ids).toEqual([categoryB]);

    // The category side agrees, which is what gives the website its item order.
    const listed = await raw("GET", "/categories?expand=items&limit=1000");
    const b = listed.body.elements.find((category) => category.id === categoryB);
    expect((b.items?.elements ?? []).map((entry) => entry.id)).toContain(itemId);
  });

  it("[13] creates a modifier group with limits, adds a modifier and edits it", async () => {
    const group = normalizeModifierGroup(await createModifierGroup(api, { name: `${PREFIX} group ${RUN}`, minRequired: 0, maxAllowed: 2 }));
    groupId = group.id;
    created.groups.push(groupId);

    const modifier = await createModifier(api, groupId, { name: "Test extra", price: 150 });
    modifierId = modifier.id;
    expect(modifierId).toMatch(/^[A-Z0-9]{13}$/);

    await updateModifier(api, groupId, modifierId, { price: 175, available: false });
    await updateModifierGroup(api, groupId, { minRequired: 1, maxAllowed: 1 });

    const after = normalizeModifierGroup(await getModifierGroup(api, groupId));
    expect(after.min_required).toBe(1);
    expect(after.max_allowed).toBe(1);
    expect(after.modifiers).toEqual([{ id: modifierId, name: "Test extra", price_cents: 175, available: false }]);
  });

  it("[13] attaches a modifier group to an item and detaches it (the `modifierGroup` body key)", async () => {
    // UA-8: the association body uses the key `modifierGroup`.
    await setItemAssociations(api, "item_modifier_groups", itemId, [], [groupId]);
    expect(state(await getItem(api, itemId)).modifier_group_ids).toEqual([groupId]);
    await setItemAssociations(api, "item_modifier_groups", itemId, [groupId], []);
    expect(state(await getItem(api, itemId)).modifier_group_ids).toEqual([]);
  });

  // -- Plan step 16, 17, 18: failure, retry, conflict ---------------------------------------

  it("[16] classifies a rejected token as `unauthorized` without retrying", async () => {
    const before = logs.length;
    await expect(getItem(apiWith("not-a-real-token"), itemId)).rejects.toMatchObject({ kind: "unauthorized", outcomeUnknown: false });
    expect(logs.slice(before).filter((entry) => entry.event === "clover_http_error")).toHaveLength(1);
  });

  it("[16] classifies a missing object as `not_found`", async () => {
    await expect(getItem(api, "AAAAAAAAAAAAA")).rejects.toBeInstanceOf(CloverError);
    await expect(getItem(api, "AAAAAAAAAAAAA")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("[16] gets a client error, not a server error, for an invalid write", async () => {
    await expect(updateItem(api, itemId, { price: "not-a-number" })).rejects.toMatchObject({ kind: "bad_request" });
    // And the item is untouched.
    expect(state(await getItem(api, itemId)).price_cents).toBe(1575);
  });

  it("[17] sends rate-limit headers the retry logic can use (informational)", async () => {
    const response = await raw("GET", "/items?limit=1");
    const headers = [...response.headers.keys()].filter((name) => /ratelimit|retry-after/i.test(name));
    console.log("rate-limit related headers on a normal response:", headers.length ? headers.join(", ") : "none");
    expect(response.status).toBe(200);
  });

  it("[18] a change made outside the dashboard is visible on the next read (basis of conflict detection)", async () => {
    // Simulates staff changing the price at the register: a write that did not come
    // through the dashboard API.
    const outside = await raw("POST", `/items/${itemId}`, { price: 1999 });
    expect(outside.status).toBe(200);
    const seen = state(await getItem(api, itemId));
    // The dashboard would have sent expected.price_cents = 1575; Clover now says 1999, so
    // the field-level check in dashboard/items.ts reports a conflict instead of writing.
    expect(seen.price_cents).toBe(1999);
    expect(seen.price_cents).not.toBe(1575);
  });

  // -- Clean-up, verified ---------------------------------------------------------------------

  it("[cleanup] removes every object this test made, and leaves the merchant's own data alone", async () => {
    const before = (await raw("GET", "/items?limit=1000")).body.elements.filter((entry) => !entry.name.startsWith(PREFIX)).length;
    await removeLeftovers();
    const after = await leftovers();
    expect(after.items.map((entry) => entry.name)).toEqual([]);
    expect(after.groups.map((entry) => entry.name)).toEqual([]);
    expect(after.categories.map((entry) => entry.name)).toEqual([]);
    // The item made above is gone, by id as well as by name.
    await expect(getItem(api, itemId)).rejects.toMatchObject({ kind: "not_found" });
    // Nothing that was not ours was deleted.
    const remaining = (await raw("GET", "/items?limit=1000")).body.elements.filter((entry) => !entry.name.startsWith(PREFIX)).length;
    expect(remaining).toBe(before);
  });

  // -- Token endpoint shape (only when OAuth values are supplied) ---------------------------

  it.skipIf(!process.env.CLOVER_SANDBOX_APP_ID || !process.env.CLOVER_SANDBOX_REFRESH_TOKEN)(
    "[2] the refresh endpoint accepts a JSON body and returns expirations in seconds (ROTATES the refresh token)",
    async () => {
      const response = await fetch(`${BASE}/oauth/v2/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: process.env.CLOVER_SANDBOX_APP_ID, refresh_token: process.env.CLOVER_SANDBOX_REFRESH_TOKEN }),
      });
      const body = await response.json();
      // UA-4: JSON body is accepted.
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(typeof body.access_token).toBe("string");
      expect(typeof body.refresh_token).toBe("string");
      expect(body.refresh_token).not.toBe(process.env.CLOVER_SANDBOX_REFRESH_TOKEN);
      expect(body.access_token_expiration).toBeLessThan(1e12);
      console.log("The refresh token you supplied is now dead. A new pair was issued and is NOT printed here.");
    },
  );
});
