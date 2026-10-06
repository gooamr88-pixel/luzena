// Dashboard API end to end: real handlers, real SQL, fake Clover.
import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, ENCRYPTION_KEY } from "./helpers/harness.js";

let h, alpha, beta, owner, staff, outsider, betaOwner;
let starters, mains, soup, steak, doneness;

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  owner = await h.addUser(alpha, "owner");
  staff = await h.addUser(alpha, "staff");
  betaOwner = await h.addUser(beta, "owner");
  outsider = await h.addUser(null);

  starters = h.clover.addCategory("Starters", 1);
  mains = h.clover.addCategory("Mains", 2);
  soup = h.clover.addItem("Soup", 700);
  steak = h.clover.addItem("Steak", 3200);
  h.clover.link(soup, starters);
  h.clover.link(steak, mains);
  doneness = h.clover.addGroup("Doneness", { minRequired: 1, maxAllowed: 1 });
  h.clover.addModifier(doneness, "Rare");

  await h.connect(alpha);
  const sync = await h.api(owner, "POST", "/clover/sync");
  expect(sync.status).toBe(200);
  expect(sync.body.stats.items).toBe(2);
});

const item = async (id, user = owner) => (await h.api(user, "GET", `/items/${id}`)).body.item;

describe("authentication and authorisation", () => {
  it("rejects a request with no session", async () => {
    expect((await h.api(null, "GET", "/items")).status).toBe(401);
  });

  it("rejects an invalid session token", async () => {
    expect((await h.api({ token: "forged" }, "GET", "/items")).status).toBe(401);
  });

  it("rejects a signed-in user who belongs to no restaurant", async () => {
    const response = await h.api(outsider, "GET", "/items");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("no_restaurant");
  });

  it("ignores a restaurant id the user does not belong to", async () => {
    const response = await h.api(betaOwner, "GET", "/items", undefined, { "x-restaurant-id": alpha });
    expect(response.status).toBe(403);
  });

  it("never serves one restaurant's items to another restaurant's owner", async () => {
    expect((await h.api(betaOwner, "GET", "/items")).body.items).toEqual([]);
    expect((await h.api(betaOwner, "GET", `/items/${soup}`)).status).toBe(404);
    const write = await h.api(betaOwner, "PATCH", `/items/${soup}`, { website: { web_hidden: true } });
    expect(write.status).toBe(404);
    expect((await item(soup)).web_hidden).toBe(false);
  });

  it("enforces roles on the server: staff can read but not write or manage Clover", async () => {
    expect((await h.api(staff, "GET", "/items")).status).toBe(200);
    expect((await h.api(staff, "PATCH", `/items/${soup}`, { website: { featured: true } })).status).toBe(403);
    expect((await h.api(staff, "POST", "/clover/disconnect")).status).toBe(403);
    expect((await h.api(staff, "GET", "/activity")).status).toBe(403);
  });

  it("returns 404 for unknown routes and never leaks a stack trace", async () => {
    const response = await h.api(owner, "GET", "/nope");
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\.ts/);
  });

  it("sends CORS headers only to the allowed origin", async () => {
    const ok = await h.api(owner, "GET", "/me");
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://luzenarestaurant.com");
    const evil = await h.api(owner, "GET", "/me", undefined, { origin: "https://evil.example" });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("validation", () => {
  it("rejects unknown fields, bad prices and malformed ids", async () => {
    const cases = [
      { clover: { price_cents: -1 }, expected: { price_cents: 700 } },
      { clover: { price_cents: 1.5 }, expected: { price_cents: 700 } },
      { clover: { name: "" }, expected: { name: "Soup" } },
      { clover: { restaurant_id: beta } },
      { website: { role: "admin" } },
      { clover: { category_ids: ["not-an-id"] }, expected: { category_ids: [] } },
    ];
    for (const body of cases) {
      const response = await h.api(owner, "PATCH", `/items/${soup}`, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(h.clover.callsTo("POST", /\/items\//)).toHaveLength(0);
  });

  it("rejects a category that belongs to no one in this restaurant before calling Clover", async () => {
    const before = h.clover.calls.length;
    const response = await h.api(owner, "PATCH", `/items/${soup}`, {
      clover: { category_ids: ["CATG000000999"] }, expected: { category_ids: [starters] },
    });
    expect(response.status).toBe(422);
    expect(h.clover.calls.length).toBe(before);
  });

  it("requires JSON", async () => {
    const response = await h.api(owner, "PATCH", `/items/${soup}`, undefined, { "content-type": "text/plain" });
    expect(response.status).toBe(415);
  });
});

describe("editing an item", () => {
  it("writes Clover-owned fields to Clover and mirrors Clover's answer", async () => {
    const response = await h.api(owner, "PATCH", `/items/${soup}`, {
      clover: { price_cents: 750, name: "Soup of the day" },
      expected: { price_cents: 700, name: "Soup" },
      website: { description: "Made fresh every morning.", dietary: ["vegetarian"] },
    });
    expect(response.status).toBe(200);
    expect(response.body.result).toBe("synced");
    expect(h.clover.items.get(soup).price).toBe(750);
    expect(response.body.item).toMatchObject({
      name: "Soup of the day", price_cents: 750, description: "Made fresh every morning.", dietary: ["vegetarian"],
    });
  });

  it("saves website-only fields without calling Clover", async () => {
    const before = h.clover.calls.length;
    const response = await h.api(owner, "PATCH", `/items/${soup}`, { website: { featured: true } });
    expect(response.body.result).toBe("saved");
    expect(response.body.clover_changed).toBe(false);
    expect(h.clover.calls.length).toBe(before);
  });

  it("moves an item between categories", async () => {
    const response = await h.api(owner, "PATCH", `/items/${soup}`, {
      clover: { category_ids: [mains] }, expected: { category_ids: [starters] },
    });
    expect(response.body.result).toBe("synced");
    expect(response.body.item.categories.map((c) => c.name)).toEqual(["Mains"]);
    expect(h.clover.itemCategories.has(`${soup}|${mains}`)).toBe(true);
    expect(h.clover.itemCategories.has(`${soup}|${starters}`)).toBe(false);
  });

  it("reports a conflict and writes nothing when Clover changed underneath the editor", async () => {
    h.clover.items.get(steak).price = 3600; // changed at the register
    const response = await h.api(owner, "PATCH", `/items/${steak}`, {
      clover: { price_cents: 3300 }, expected: { price_cents: 3200 },
      website: { description: "Should not be saved." },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("conflict");
    expect(response.body.error.conflicts.price_cents).toEqual({ expected: 3200, actual: 3600 });
    expect(h.clover.items.get(steak).price).toBe(3600);
    expect(response.body.error.item.price_cents).toBe(3600);
    expect(response.body.error.item.description).toBeNull();
  });

  it("does not treat an unrelated Clover change as a conflict", async () => {
    h.clover.items.get(steak).available = false; // unrelated field changed in Clover
    const response = await h.api(owner, "PATCH", `/items/${steak}`, {
      clover: { price_cents: 3700 }, expected: { price_cents: 3600 },
    });
    expect(response.status).toBe(200);
    expect(response.body.item).toMatchObject({ price_cents: 3700, available: false });
  });

  it("saves nothing, locally or in Clover, when Clover rejects the change", async () => {
    h.clover.fault({ method: "POST", path: /\/items\/[A-Z0-9]+$/, status: 400 });
    const response = await h.api(owner, "PATCH", `/items/${steak}`, {
      clover: { price_cents: 4000 }, expected: { price_cents: 3700 },
      website: { description: "Should not be saved." },
    });
    expect(response.status).toBe(502);
    expect(response.body.error).toMatchObject({ code: "clover_bad_request", clover_changed: false, local_changed: false, retryable: false });
    const current = await item(steak);
    expect(current.price_cents).toBe(3700);
    expect(current.description).toBeNull();
  });

  it("retries an update through a temporary Clover outage", async () => {
    h.clover.fault({ method: "POST", path: /\/items\/[A-Z0-9]+$/, status: 503, times: 2 });
    const response = await h.api(owner, "PATCH", `/items/${steak}`, {
      clover: { price_cents: 3800 }, expected: { price_cents: 3700 },
    });
    expect(response.status).toBe(200);
    expect(h.clover.items.get(steak).price).toBe(3800);
  });

  it("recognises a write that Clover applied even though the response was lost", async () => {
    h.clover.fault({ method: "POST", path: /\/items\/[A-Z0-9]+$/, mode: "drop_after", times: 3 });
    const response = await h.api(owner, "PATCH", `/items/${steak}`, {
      clover: { price_cents: 3900 }, expected: { price_cents: 3800 },
    });
    expect(response.status).toBe(200);
    expect(response.body.result).toBe("synced");
    expect(response.body.item.price_cents).toBe(3900);
  });

  it("reports a partial save when one part reaches Clover and the next does not", async () => {
    h.clover.fault({ method: "POST", path: /\/category_items$/, status: 400, times: 5 });
    const response = await h.api(owner, "PATCH", `/items/${steak}`, {
      clover: { price_cents: 4100, category_ids: [starters] },
      expected: { price_cents: 3900, category_ids: [mains] },
    });
    expect(response.status).toBe(200);
    expect(response.body.result).toBe("partial");
    expect(response.body.failed_parts).toEqual(["categories"]);
    expect(response.body.item.price_cents).toBe(4100);
    expect(response.body.item.categories.map((c) => c.name)).toEqual(["Mains"]);
    h.clover.faults.length = 0;
  });

  it("marks an item removed when Clover no longer has it", async () => {
    const temp = h.clover.addItem("Temp", 100);
    await h.api(owner, "POST", "/clover/sync");
    h.clover.items.delete(temp);
    const response = await h.api(owner, "PATCH", `/items/${temp}`, {
      clover: { price_cents: 200 }, expected: { price_cents: 100 },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("removed_in_clover");
    expect((await item(temp)).removed_from_clover).toBe(true);
  });

  it("archives on the website only and never deletes in Clover", async () => {
    const response = await h.api(owner, "PATCH", `/items/${soup}`, { website: { archived: true } });
    expect(response.body.item.archived).toBe(true);
    expect(response.body.item.on_website).toBe(false);
    expect(h.clover.items.has(soup)).toBe(true);
    expect((await h.api(owner, "GET", "/items")).body.items.map((i) => i.id)).not.toContain(soup);
    expect((await h.api(owner, "GET", "/items?status=archived")).body.items.map((i) => i.id)).toContain(soup);
    await h.api(owner, "PATCH", `/items/${soup}`, { website: { archived: false } });
  });
});

describe("creating an item", () => {
  it("creates in Clover, assigns the category, and stores website data", async () => {
    const response = await h.api(owner, "POST", "/items", {
      clover: { name: "Bread", price_cents: 300, category_ids: [starters], modifier_group_ids: [doneness] },
      website: { description: "Baked here." },
    });
    expect(response.status).toBe(201);
    expect(response.body.result).toBe("synced");
    const id = response.body.item.id;
    expect(h.clover.items.get(id).name).toBe("Bread");
    expect(h.clover.itemCategories.has(`${id}|${starters}`)).toBe(true);
    expect(response.body.item.modifier_groups.map((g) => g.name)).toEqual(["Doneness"]);
    expect(response.body.item.description).toBe("Baked here.");
  });

  it("requires an idempotency key", async () => {
    const response = await h.api(owner, "POST", "/items", { clover: { name: "X", price_cents: 1 } }, { "idempotency-key": "" });
    expect(response.status).toBe(400);
  });

  it("does not create a second item when the same request is sent again", async () => {
    const headers = { "idempotency-key": "create-olives-0001" };
    const body = { clover: { name: "Olives", price_cents: 400 } };
    const first = await h.api(owner, "POST", "/items", body, headers);
    const second = await h.api(owner, "POST", "/items", body, headers);
    expect(second.status).toBe(201);
    expect(second.body.item.id).toBe(first.body.item.id);
    expect([...h.clover.items.values()].filter((i) => i.name === "Olives")).toHaveLength(1);
  });

  it("refuses a reused key with a different body", async () => {
    const response = await h.api(owner, "POST", "/items", { clover: { name: "Other", price_cents: 1 } }, { "idempotency-key": "create-olives-0001" });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("idempotency_key_reused");
  });

  it("does not duplicate when Clover created the item but the response was lost", async () => {
    const headers = { "idempotency-key": "create-hummus-0001" };
    const body = { clover: { name: "Hummus", price_cents: 600 } };
    h.clover.fault({ method: "POST", path: /\/items$/, mode: "drop_after" });

    const first = await h.api(owner, "POST", "/items", body, headers);
    expect(first.status).toBe(504);
    expect(first.body.error).toMatchObject({ clover_changed: "unknown", retryable: true });

    const retry = await h.api(owner, "POST", "/items", body, headers);
    expect(retry.status).toBe(201);
    expect([...h.clover.items.values()].filter((i) => i.name === "Hummus")).toHaveLength(1);
    expect(retry.body.item.name).toBe("Hummus");
  });

  it("creates on retry when the first attempt never reached Clover", async () => {
    const headers = { "idempotency-key": "create-falafel-0001" };
    const body = { clover: { name: "Falafel", price_cents: 650 } };
    h.clover.fault({ method: "POST", path: /\/items$/, mode: "drop_before" });
    expect((await h.api(owner, "POST", "/items", body, headers)).status).toBe(502);
    const retry = await h.api(owner, "POST", "/items", body, headers);
    expect(retry.status).toBe(201);
    expect([...h.clover.items.values()].filter((i) => i.name === "Falafel")).toHaveLength(1);
  });
});

describe("bulk actions", () => {
  it("hides several items on the website in one step", async () => {
    const response = await h.api(owner, "POST", "/items/bulk", { ids: [soup, steak], action: "hide" });
    expect(response.body.succeeded).toHaveLength(2);
    expect((await item(soup)).web_hidden).toBe(true);
    await h.api(owner, "POST", "/items/bulk", { ids: [soup, steak], action: "show" });
  });

  it("refuses the whole request if any id is not the restaurant's", async () => {
    const response = await h.api(owner, "POST", "/items/bulk", { ids: [soup, "ITEM000000999"], action: "hide" });
    expect(response.status).toBe(422);
    expect((await item(soup)).web_hidden).toBe(false);
  });

  it("reports per-item results when changing availability in Clover", async () => {
    h.clover.fault({ method: "POST", path: new RegExp(`/items/${steak}$`), status: 400 });
    const response = await h.api(owner, "POST", "/items/bulk", { ids: [soup, steak], action: "unavailable" });
    expect(response.body.result).toBe("partial");
    expect(response.body.succeeded).toEqual([soup]);
    expect(response.body.failed).toEqual([{ id: steak, code: "clover_bad_request" }]);
    expect((await item(soup)).available).toBe(false);
    expect(h.clover.items.get(soup).available).toBe(false);
  });
});

describe("categories and modifiers", () => {
  it("creates and renames a category in Clover", async () => {
    const created = await h.api(owner, "POST", "/categories", { name: "Desserts" });
    expect(created.status).toBe(201);
    const desserts = created.body.categories.find((c) => c.name === "Desserts");
    expect(h.clover.categories.get(desserts.id).name).toBe("Desserts");

    const renamed = await h.api(owner, "PATCH", `/categories/${desserts.id}`, {
      clover: { name: "Sweets" }, expected: { name: "Desserts" },
    });
    expect(renamed.body.result).toBe("synced");
    expect(h.clover.categories.get(desserts.id).name).toBe("Sweets");
  });

  it("detects a category renamed in Clover meanwhile", async () => {
    h.clover.categories.get(mains).name = "Main courses";
    const response = await h.api(owner, "PATCH", `/categories/${mains}`, {
      clover: { name: "Plates" }, expected: { name: "Mains" },
    });
    expect(response.status).toBe(409);
    expect(h.clover.categories.get(mains).name).toBe("Main courses");
  });

  it("reorders categories through Clover's sortOrder", async () => {
    const ids = (await h.api(owner, "GET", "/categories")).body.categories.map((c) => c.id);
    const reversed = [...ids].reverse();
    const response = await h.api(owner, "POST", "/categories/reorder", { ids: reversed });
    expect(response.body.result).toBe("synced");
    expect(response.body.categories.map((c) => c.id)).toEqual(reversed);
    expect(h.clover.categories.get(reversed[0]).sortOrder).toBe(1);
  });

  it("refuses a reorder that does not list every category", async () => {
    const response = await h.api(owner, "POST", "/categories/reorder", { ids: [starters] });
    expect(response.status).toBe(409);
  });

  it("hides a category on the website without touching Clover", async () => {
    const before = h.clover.callsTo("POST", /categories/).length;
    const response = await h.api(owner, "PATCH", `/categories/${starters}`, { website: { web_hidden: true } });
    expect(response.body.categories.find((c) => c.id === starters).web_hidden).toBe(true);
    expect(h.clover.callsTo("POST", /categories/).length).toBe(before);
    await h.api(owner, "PATCH", `/categories/${starters}`, { website: { web_hidden: false } });
  });

  it("manages modifier groups and modifiers in Clover", async () => {
    const created = await h.api(owner, "POST", "/modifier-groups", { name: "Sides", min_required: 0, max_allowed: 2 });
    const sides = created.body.modifier_groups.find((g) => g.name === "Sides");
    expect(h.clover.groups.get(sides.id)).toMatchObject({ name: "Sides", maxAllowed: 2 });

    const added = await h.api(owner, "POST", `/modifier-groups/${sides.id}/modifiers`, { name: "Fries", price_cents: 250 });
    const fries = added.body.modifier_groups.find((g) => g.id === sides.id).modifiers[0];
    expect(fries).toMatchObject({ name: "Fries", price_cents: 250, available: true });

    const disabled = await h.api(owner, "PATCH", `/modifier-groups/${sides.id}/modifiers/${fries.id}`, {
      clover: { available: false }, expected: { available: true },
    });
    expect(disabled.body.result).toBe("synced");
    expect(h.clover.modifiers.get(fries.id).available).toBe(false);
  });

  it("rejects a minimum above the maximum", async () => {
    const response = await h.api(owner, "POST", "/modifier-groups", { name: "Bad", min_required: 3, max_allowed: 1 });
    expect(response.status).toBe(422);
  });
});

describe("item photos", () => {
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3]);
  const form = (bytes, name, type) => {
    const data = new FormData();
    data.append("file", new File([bytes], name, { type }));
    return data;
  };

  it("stores a photo under the restaurant's own folder", async () => {
    const response = await h.api(owner, "POST", `/items/${steak}/image`, form(webp, "steak.webp", "image/webp"));
    expect(response.status).toBe(200);
    expect(response.body.item.image_path).toMatch(new RegExp(`^${alpha}/${steak}/[0-9a-f]{20}\\.webp$`));
    expect(h.stored.has(`menu-images/${response.body.item.image_path}`)).toBe(true);
  });

  it("rejects a file that is not an image, whatever it is named", async () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
    const response = await h.api(owner, "POST", `/items/${steak}/image`, form(exe, "photo.webp", "image/webp"));
    expect(response.status).toBe(415);
  });

  it("removes the stored file when the photo is removed", async () => {
    const path = (await item(steak)).image_path;
    const response = await h.api(owner, "DELETE", `/items/${steak}/image`);
    expect(response.body.item.image_path).toBeNull();
    expect(h.stored.has(`menu-images/${path}`)).toBe(false);
  });

  it("does not let another restaurant attach a photo to this item", async () => {
    const response = await h.api(betaOwner, "POST", `/items/${steak}/image`, form(webp, "x.webp", "image/webp"));
    expect(response.status).toBe(404);
  });
});

describe("Clover connection", () => {
  it("refreshes an expiring token once, even under concurrent requests", async () => {
    await h.connect(alpha, { expiresInSeconds: 30 });
    const before = h.clover.refreshCalls;
    const results = await Promise.all([
      h.api(owner, "PATCH", `/items/${soup}`, { clover: { hidden: true }, expected: { hidden: false } }),
      h.api(owner, "POST", "/clover/sync"),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(h.clover.refreshCalls - before).toBe(1);
    await h.api(owner, "PATCH", `/items/${soup}`, { clover: { hidden: false }, expected: { hidden: true } });
  });

  it("recovers when Clover rejects the access token mid-flight", async () => {
    h.clover.tokenGeneration += 1; // Clover invalidated the token we hold
    const { rows } = await h.pg.query("select refresh_token_enc from public.clover_connections where restaurant_id = $1", [alpha]);
    expect(rows[0].refresh_token_enc).not.toContain("refresh-");
    // Our stored refresh token is now stale too, so Clover refuses it.
    const response = await h.api(owner, "POST", "/clover/sync");
    expect(response.status).toBe(502);
    const status = (await h.api(owner, "GET", "/clover")).body.connection;
    expect(status.status).toBe("needs_reauth");
  });

  it("never exposes token material in status responses or logs", async () => {
    const status = await h.api(owner, "GET", "/clover");
    const text = JSON.stringify(status.body) + JSON.stringify(h.logs);
    expect(text).not.toMatch(/access-\d|refresh-\d|app-secret-value|v1\.[A-Za-z0-9_-]{10,}\./);
  });

  it("completes OAuth only for the attempt this owner started", async () => {
    const start = await h.api(owner, "POST", "/clover/connect");
    expect(start.status).toBe(200);
    const url = new URL(start.body.authorize_url);
    expect(url.origin).toBe("https://sandbox.dev.clover.com");
    expect(url.searchParams.get("state")).toBe(start.body.nonce);
    expect(start.body.authorize_url).not.toContain("app-secret-value");

    const base = { code: "good-code", merchant_id: h.clover.merchantId };

    const mismatch = await h.api(owner, "POST", "/clover/complete", { ...base, nonce: start.body.nonce, state: "something-else" });
    expect(mismatch.body.error.code).toBe("oauth_state_mismatch");

    const missing = await h.api(owner, "POST", "/clover/complete", { ...base, nonce: start.body.nonce });
    expect(missing.body.error.code).toBe("oauth_state_missing");

    const forged = await h.api(owner, "POST", "/clover/complete", { ...base, nonce: "x".repeat(43), state: "x".repeat(43) });
    expect(forged.body.error.code).toBe("oauth_state_invalid");

    const ok = await h.api(owner, "POST", "/clover/complete", { ...base, nonce: start.body.nonce, state: start.body.nonce });
    expect(ok.status).toBe(200);
    await h.settle();
    const status = (await h.api(owner, "GET", "/clover")).body.connection;
    expect(status).toMatchObject({ status: "active", merchant_name: "Fake Merchant" });

    const replay = await h.api(owner, "POST", "/clover/complete", { ...base, nonce: start.body.nonce, state: start.body.nonce });
    expect(replay.body.error.code).toBe("oauth_state_invalid");
  });

  it("stores tokens encrypted", async () => {
    const { rows } = await h.pg.query("select access_token_enc, refresh_token_enc from public.clover_connections where restaurant_id = $1", [alpha]);
    expect(rows[0].access_token_enc).toMatch(/^v1\./);
    expect(rows[0].access_token_enc).not.toContain(h.clover.accessToken);
    const { decryptSecret } = await import("../supabase/functions/_shared/crypto.ts");
    expect(await decryptSecret(rows[0].access_token_enc, ENCRYPTION_KEY)).toBe(h.clover.accessToken);
  });

  it("refuses to connect a merchant that another restaurant already uses", async () => {
    const start = await h.api(betaOwner, "POST", "/clover/connect");
    const response = await h.api(betaOwner, "POST", "/clover/complete", {
      code: "good-code", merchant_id: h.clover.merchantId, nonce: start.body.nonce, state: start.body.nonce,
    });
    expect(response.body.error.code).toBe("merchant_in_use");
  });

  it("keeps the menu after disconnecting and blocks Clover writes", async () => {
    const response = await h.api(owner, "POST", "/clover/disconnect");
    expect(response.body.connection.connected).toBe(false);
    expect((await h.api(owner, "GET", "/items")).body.total).toBeGreaterThan(0);
    const write = await h.api(owner, "PATCH", `/items/${steak}`, { clover: { price_cents: 1 }, expected: { price_cents: 4100 } });
    expect(write.status).toBe(409);
    expect(write.body.error.code).toBe("clover_not_connected");
  });
});

describe("audit trail", () => {
  it("records who did what, with the outcome", async () => {
    const entries = (await h.api(owner, "GET", "/activity")).body.entries;
    const actions = entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["CLOVER_DISCONNECTED", "CLOVER_CONNECTED"]));
    expect(entries[0].actor_email).toBe(owner.email);
    expect(entries.every((e) => !("restaurant_id" in e))).toBe(true);

    const { rows } = await h.pg.query(
      "select action, result, sync_status from public.audit_logs where restaurant_id = $1 and result <> 'success' order by id", [alpha]);
    expect(rows.map((r) => `${r.action}:${r.result}`)).toEqual(expect.arrayContaining([
      "ITEM_UPDATED:conflict", "ITEM_UPDATED:failed", "ITEM_UPDATED:partial",
    ]));
  });

  it("keeps each restaurant's activity separate", async () => {
    const entries = (await h.api(betaOwner, "GET", "/activity")).body.entries;
    expect(entries.every((e) => e.action.startsWith("CLOVER_CONNECT"))).toBe(true);
  });
});
