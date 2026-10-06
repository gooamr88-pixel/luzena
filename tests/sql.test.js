import { beforeAll, describe, expect, it } from "vitest";
import { connectClover, createRestaurant, createTestDb, createUser, samplePayload, showAllItems } from "./helpers/db.js";

let pg, db, alpha, beta, gamma;

beforeAll(async () => {
  ({ pg, db } = await createTestDb());
  alpha = await createRestaurant(pg, "alpha");
  beta = await createRestaurant(pg, "beta");
  await connectClover(pg, alpha, "MERCHANTALPHA");
  await db.rpc("menu_apply_sync", { p_restaurant: alpha, p_payload: samplePayload(), p_full: true });
  // Alpha's owner has shown everything; most tests below are about a published menu.
  await showAllItems(pg, alpha);

  // Gamma is a restaurant that has just connected Clover and chosen nothing yet.
  gamma = await createRestaurant(pg, "gamma");
  await connectClover(pg, gamma, "MERCHANTGAMMA");
  await db.rpc("menu_apply_sync", { p_restaurant: gamma, p_payload: samplePayload(), p_full: true });
});

const listNames = async (restaurant, filters = {}) =>
  (await db.rpc("dash_list_items", { p_restaurant: restaurant, p_filters: filters })).items.map((i) => i.name);

describe("access control at the database", () => {
  it("gives anon and authenticated no table access and no function access", async () => {
    for (const role of ["anon", "authenticated"]) {
      await pg.exec(`set role ${role}`);
      await expect(pg.query("select * from public.menu_items")).rejects.toThrow(/permission denied/);
      await expect(pg.query("select * from public.clover_connections")).rejects.toThrow(/permission denied/);
      await expect(pg.query("select public.public_menu($1)", [alpha])).rejects.toThrow(/permission denied/);
      await expect(pg.query("select public.clover_connection_secret($1)", [alpha])).rejects.toThrow(/permission denied/);
      await pg.exec("reset role");
    }
  });

  it("leaves anon and authenticated no privilege on any table, sequence or function", async () => {
    const { rows } = await pg.query(`
      select c.relname as name, r.rolname as role
      from pg_class c cross join (values ('anon'), ('authenticated')) r(rolname)
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'S', 'v')
        and (has_table_privilege(r.rolname, c.oid, 'select')
          or (c.relkind = 'S' and has_sequence_privilege(r.rolname, c.oid, 'usage, update'))
          or (c.relkind <> 'S' and has_table_privilege(r.rolname, c.oid, 'insert, update, delete')))
      union all
      select p.proname, r.rolname
      from pg_proc p cross join (values ('anon'), ('authenticated')) r(rolname)
      where p.pronamespace = 'public'::regnamespace and has_function_privilege(r.rolname, p.oid, 'execute')`);
    expect(rows).toEqual([]);
  });

  it("starts a table or sequence created by a later migration closed to the public roles", async () => {
    await pg.exec("create table public.later_table (id bigint generated always as identity primary key)");
    const { rows } = await pg.query(`
      select has_table_privilege('anon', 'public.later_table', 'select') as table_open,
             has_sequence_privilege('authenticated', 'public.later_table_id_seq', 'usage') as sequence_open,
             has_table_privilege('service_role', 'public.later_table', 'select, insert') as service_can`);
    await pg.exec("drop table public.later_table");
    expect(rows[0]).toEqual({ table_open: false, sequence_open: false, service_can: true });
  });

  it("lets the service role call the functions", async () => {
    await pg.exec("set role service_role");
    const { rows } = await pg.query("select public.dash_list_categories($1) as r", [alpha]);
    await pg.exec("reset role");
    expect(rows[0].r).toHaveLength(2);
  });

  it("has row level security enabled on every public table", async () => {
    const { rows } = await pg.query(
      "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity",
    );
    expect(rows).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("never returns another restaurant's rows", async () => {
    expect(await listNames(beta)).toEqual([]);
    expect(await db.rpc("dash_get_item", { p_restaurant: beta, p_item: "ITEMSOUP00001" })).toBeNull();
    expect((await db.rpc("public_menu", { p_restaurant: beta })).categories).toEqual([]);
  });

  it("refuses website writes to an item owned by another restaurant", async () => {
    const result = await db.rpc("web_update_item", {
      p_restaurant: beta, p_item: "ITEMSOUP00001", p_patch: { web_hidden: true },
    });
    expect(result).toBeNull();
    const soup = await db.rpc("dash_get_item", { p_restaurant: alpha, p_item: "ITEMSOUP00001" });
    expect(soup.web_hidden).toBe(false);
  });

  it("only reports ids that belong to the restaurant", async () => {
    const ids = ["ITEMSOUP00001", "ITEMUNKNOWN01"];
    expect(await db.rpc("menu_known_ids", { p_restaurant: alpha, p_kind: "item", p_ids: ids })).toEqual(["ITEMSOUP00001"]);
    expect(await db.rpc("menu_known_ids", { p_restaurant: beta, p_kind: "item", p_ids: ids })).toEqual([]);
  });

  it("lists only the caller's memberships", async () => {
    const owner = await createUser(pg, alpha);
    const stranger = await createUser(pg, null);
    const memberships = await db.rpc("user_memberships", { p_user: owner.id });
    expect(memberships.map((m) => m.slug)).toEqual(["alpha"]);
    expect(memberships[0].role).toBe("owner");
    expect(await db.rpc("user_memberships", { p_user: stranger.id })).toEqual([]);
  });

  it("rejects a Clover merchant that is already connected to another restaurant", async () => {
    const result = await db.rpc("clover_connection_save", {
      p_restaurant: beta, p_user: null, p_merchant_id: "MERCHANTALPHA", p_merchant_name: null,
      p_environment: "sandbox", p_access_enc: "a", p_refresh_enc: "r",
      p_access_exp: new Date(Date.now() + 3600e3).toISOString(), p_refresh_exp: null,
    });
    expect(result).toEqual({ ok: false, reason: "merchant_in_use" });
  });
});

describe("dashboard item listing", () => {
  it("sorts by name by default and hides nothing from the owner", async () => {
    expect(await listNames(alpha)).toEqual(["Salad", "Soup", "Staff meal", "Steak"]);
  });

  it("sorts by price in both directions", async () => {
    expect(await listNames(alpha, { sort: "price", dir: "desc" })).toEqual(["Steak", "Salad", "Soup", "Staff meal"]);
    expect(await listNames(alpha, { sort: "price", dir: "asc" })).toEqual(["Staff meal", "Soup", "Salad", "Steak"]);
  });

  it("filters by category, availability and visibility", async () => {
    expect(await listNames(alpha, { category: "CATSTARTERS01" })).toEqual(["Salad", "Soup"]);
    expect(await listNames(alpha, { category: "none" })).toEqual(["Staff meal"]);
    expect(await listNames(alpha, { availability: "unavailable" })).toEqual(["Salad"]);
    expect(await listNames(alpha, { visibility: "hidden" })).toEqual(["Staff meal"]);
  });

  it("searches item names and category names, treating % and _ literally", async () => {
    expect(await listNames(alpha, { search: "ste" })).toEqual(["Steak"]);
    expect(await listNames(alpha, { search: "starters" })).toEqual(["Salad", "Soup"]);
    expect(await listNames(alpha, { search: "%" })).toEqual([]);
    expect(await listNames(alpha, { search: "_" })).toEqual([]);
  });

  it("paginates and reports the total", async () => {
    const page = await db.rpc("dash_list_items", { p_restaurant: alpha, p_filters: { limit: 2, offset: 2 } });
    expect(page.total).toBe(4);
    expect(page.items.map((i) => i.name)).toEqual(["Staff meal", "Steak"]);
  });

  it("caps the page size at 100", async () => {
    const page = await db.rpc("dash_list_items", { p_restaurant: alpha, p_filters: { limit: 5000 } });
    expect(page.limit).toBe(100);
  });
});

describe("public menu", () => {
  it("shows categories in Clover order with Clover's item order, and never hidden items", async () => {
    const menu = await db.rpc("public_menu", { p_restaurant: alpha });
    expect(menu.categories.map((c) => c.name)).toEqual(["Starters", "Mains"]);
    expect(menu.categories[0].items.map((i) => i.name)).toEqual(["Soup", "Salad"]);
    expect(JSON.stringify(menu)).not.toContain("Staff meal");
  });

  it("keeps unavailable items but marks them", async () => {
    const menu = await db.rpc("public_menu", { p_restaurant: alpha });
    const salad = menu.categories[0].items.find((i) => i.name === "Salad");
    expect(salad.available).toBe(false);
  });

  it("includes modifier groups with their modifiers", async () => {
    const menu = await db.rpc("public_menu", { p_restaurant: alpha });
    const steak = menu.categories[1].items[0];
    expect(steak.modifier_groups[0].name).toBe("Doneness");
    expect(steak.modifier_groups[0].modifiers.map((m) => m.name)).toEqual(["Rare", "Well done"]);
  });

  it("drops items the owner hid or archived, and categories the owner hid", async () => {
    await db.rpc("web_update_item", { p_restaurant: alpha, p_item: "ITEMSOUP00001", p_patch: { web_hidden: true } });
    let menu = await db.rpc("public_menu", { p_restaurant: alpha });
    expect(menu.categories[0].items.map((i) => i.name)).toEqual(["Salad"]);

    await db.rpc("web_update_item", { p_restaurant: alpha, p_item: "ITEMSALAD0001", p_patch: { archived: true } });
    menu = await db.rpc("public_menu", { p_restaurant: alpha });
    expect(menu.categories.map((c) => c.name)).toEqual(["Mains"]);

    await db.rpc("web_update_category", { p_restaurant: alpha, p_category: "CATMAINS00001", p_patch: { web_hidden: true } });
    menu = await db.rpc("public_menu", { p_restaurant: alpha });
    expect(menu.categories).toEqual([]);

    await db.rpc("web_update_item", { p_restaurant: alpha, p_item: "ITEMSOUP00001", p_patch: { web_hidden: false } });
    await db.rpc("web_update_item", { p_restaurant: alpha, p_item: "ITEMSALAD0001", p_patch: { archived: false } });
    await db.rpc("web_update_category", { p_restaurant: alpha, p_category: "CATMAINS00001", p_patch: { web_hidden: false } });
  });
});

describe("what is public is the owner's choice, not Clover's", () => {
  const item = (id) => db.rpc("dash_get_item", { p_restaurant: gamma, p_item: id });
  const publicNames = async () =>
    (await db.rpc("public_menu", { p_restaurant: gamma })).categories.flatMap((c) => c.items.map((i) => i.name));

  it("publishes nothing when a merchant's inventory is first imported", async () => {
    expect(await publicNames()).toEqual([]);
    // The owner sees every item, each marked as not on the website.
    expect(await listNames(gamma)).toEqual(["Salad", "Soup", "Staff meal", "Steak"]);
    expect((await item("ITEMSOUP00001")).web_hidden).toBe(true);
    expect((await item("ITEMSOUP00001")).on_website).toBe(false);
    const overview = await db.rpc("dash_overview", { p_restaurant: gamma });
    expect(overview.counts.items).toBe(4);
    expect(overview.counts.on_website).toBe(0);
  });

  it("publishes exactly the items the owner shows", async () => {
    await db.rpc("web_update_item", { p_restaurant: gamma, p_item: "ITEMSOUP00001", p_patch: { web_hidden: false } });
    expect(await publicNames()).toEqual(["Soup"]);
  });

  it("never publishes an item Clover marks hidden, even if the owner shows it", async () => {
    await db.rpc("web_update_item", { p_restaurant: gamma, p_item: "ITEMSTAFF0001", p_patch: { web_hidden: false } });
    expect(await publicNames()).toEqual(["Soup"]);
  });

  it("keeps the owner's choices through later syncs, while Clover's fields follow Clover", async () => {
    const payload = samplePayload();
    payload.items.find((i) => i.id === "ITEMSOUP00001").price_cents = 850;
    payload.items.find((i) => i.id === "ITEMSALAD0001").name = "Garden salad";
    payload.items.push({ id: "ITEMBREAD0001", name: "Bread", price_cents: 300, category_ids: ["CATSTARTERS01"], modifier_group_ids: [] });
    await db.rpc("menu_apply_sync", { p_restaurant: gamma, p_payload: payload, p_full: true });

    // Shown stays shown, with Clover's new price. Hidden stays hidden, with Clover's new name.
    const menu = await db.rpc("public_menu", { p_restaurant: gamma });
    expect(menu.categories.flatMap((c) => c.items.map((i) => [i.name, i.price_cents]))).toEqual([["Soup", 850]]);
    expect((await item("ITEMSALAD0001")).name).toBe("Garden salad");
    expect((await item("ITEMSALAD0001")).web_hidden).toBe(true);
    // An item added in Clover afterwards arrives hidden too.
    expect((await item("ITEMBREAD0001")).web_hidden).toBe(true);
  });

  it("hides or archives on the website only: the item and Clover's fields stay as they are", async () => {
    const before = await item("ITEMSOUP00001");
    await db.rpc("web_update_item", { p_restaurant: gamma, p_item: "ITEMSOUP00001", p_patch: { web_hidden: true } });
    await db.rpc("web_update_item", { p_restaurant: gamma, p_item: "ITEMSOUP00001", p_patch: { archived: true } });
    expect(await publicNames()).toEqual([]);

    const after = await item("ITEMSOUP00001");
    expect(after.archived).toBe(true);
    expect(after.removed_from_clover).toBe(false);
    for (const field of ["id", "name", "price_cents", "price_type", "available", "hidden", "clover_modified_time"]) {
      expect(after[field], field).toEqual(before[field]);
    }
    // Still there for the owner, under Archived, and restorable.
    expect(await listNames(gamma, { status: "archived" })).toEqual(["Soup"]);
    await db.rpc("web_update_item", { p_restaurant: gamma, p_item: "ITEMSOUP00001", p_patch: { archived: false, web_hidden: false } });
    expect(await publicNames()).toEqual(["Soup"]);
  });
});

describe("sync never overwrites website data", () => {
  it("keeps description, image, featured, hidden and archive across a full sync", async () => {
    await db.rpc("web_update_item", {
      p_restaurant: alpha, p_item: "ITEMSTEAK0001",
      p_patch: { description: "Dry aged.", featured: true, dietary: ["gluten-free"], image_path: "x/y.webp" },
    });
    const payload = samplePayload();
    payload.items.find((i) => i.id === "ITEMSTEAK0001").price_cents = 3500;
    await db.rpc("menu_apply_sync", { p_restaurant: alpha, p_payload: payload, p_full: true });

    const steak = await db.rpc("dash_get_item", { p_restaurant: alpha, p_item: "ITEMSTEAK0001" });
    expect(steak.price_cents).toBe(3500);
    expect(steak.description).toBe("Dry aged.");
    expect(steak.featured).toBe(true);
    expect(steak.dietary).toEqual(["gluten-free"]);
    expect(steak.image_path).toBe("x/y.webp");
  });

  it("marks items missing from a full sync as removed instead of deleting them", async () => {
    const payload = samplePayload();
    payload.items = payload.items.filter((i) => i.id !== "ITEMSOUP00001");
    const stats = await db.rpc("menu_apply_sync", { p_restaurant: alpha, p_payload: payload, p_full: true });
    expect(stats.removed).toBe(1);

    const soup = await db.rpc("dash_get_item", { p_restaurant: alpha, p_item: "ITEMSOUP00001" });
    expect(soup.removed_from_clover).toBe(true);
    expect(soup.on_website).toBe(false);
    expect(await listNames(alpha)).not.toContain("Soup");
    expect(await listNames(alpha, { status: "removed" })).toEqual(["Soup"]);

    await db.rpc("menu_apply_sync", { p_restaurant: alpha, p_payload: samplePayload(), p_full: true });
    expect((await db.rpc("dash_get_item", { p_restaurant: alpha, p_item: "ITEMSOUP00001" })).removed_from_clover).toBe(false);
  });

  it("does not mark anything removed on a partial sync", async () => {
    const stats = await db.rpc("menu_apply_sync", {
      p_restaurant: alpha, p_full: false,
      p_payload: { items: [{ id: "ITEMSOUP00001", name: "Soup of the day", price_cents: 750, category_ids: ["CATMAINS00001"] }] },
    });
    expect(stats.removed).toBe(0);
    expect(await listNames(alpha)).toEqual(["Salad", "Soup of the day", "Staff meal", "Steak"]);
    const soup = await db.rpc("dash_get_item", { p_restaurant: alpha, p_item: "ITEMSOUP00001" });
    expect(soup.categories.map((c) => c.name)).toEqual(["Mains"]);
    await db.rpc("menu_apply_sync", { p_restaurant: alpha, p_payload: samplePayload(), p_full: true });
  });

  it("keeps the owner's item order across syncs and appends new items at the end", async () => {
    await db.rpc("web_reorder_category_items", {
      p_restaurant: alpha, p_category: "CATSTARTERS01", p_items: ["ITEMSALAD0001", "ITEMSOUP00001"],
    });
    const payload = samplePayload();
    payload.items.push({ id: "ITEMBREAD0001", name: "Bread", price_cents: 300, category_ids: ["CATSTARTERS01"], modifier_group_ids: [] });
    await db.rpc("menu_apply_sync", { p_restaurant: alpha, p_payload: payload, p_full: true });

    // The new arrival is not public until the owner shows it.
    let menu = await db.rpc("public_menu", { p_restaurant: alpha });
    expect(menu.categories[0].items.map((i) => i.name)).toEqual(["Salad", "Soup"]);
    await db.rpc("web_update_item", { p_restaurant: alpha, p_item: "ITEMBREAD0001", p_patch: { web_hidden: false } });
    menu = await db.rpc("public_menu", { p_restaurant: alpha });
    expect(menu.categories[0].items.map((i) => i.name)).toEqual(["Salad", "Soup", "Bread"]);
    await db.rpc("menu_apply_sync", { p_restaurant: alpha, p_payload: samplePayload(), p_full: true });
  });
});

describe("overview", () => {
  it("counts what the owner sees", async () => {
    const overview = await db.rpc("dash_overview", { p_restaurant: alpha });
    expect(overview.counts.items).toBe(4);
    expect(overview.counts.hidden).toBe(1);
    expect(overview.counts.unavailable).toBe(1);
    expect(overview.counts.on_website).toBe(3);
    expect(overview.categories).toBe(2);
    expect(overview.connection.connected).toBe(true);
    expect(JSON.stringify(overview)).not.toContain("enc-access");
  });
});

describe("locks, limits and idempotency", () => {
  it("lets exactly one caller refresh the Clover token at a time", async () => {
    expect(await db.rpc("clover_refresh_claim", { p_restaurant: alpha, p_lock_seconds: 30 })).toBe(true);
    expect(await db.rpc("clover_refresh_claim", { p_restaurant: alpha, p_lock_seconds: 30 })).toBe(false);
    await db.rpc("clover_refresh_release", { p_restaurant: alpha });
    expect(await db.rpc("clover_refresh_claim", { p_restaurant: alpha, p_lock_seconds: 30 })).toBe(true);
    await db.rpc("clover_refresh_release", { p_restaurant: alpha });
  });

  it("runs one sync at a time and records the outcome", async () => {
    const run = await db.rpc("sync_claim", { p_restaurant: alpha, p_trigger: "manual", p_lock_seconds: 60 });
    expect(run).toBeTruthy();
    expect(await db.rpc("sync_claim", { p_restaurant: alpha, p_trigger: "manual", p_lock_seconds: 60 })).toBeNull();
    expect((await db.rpc("clover_connection_status", { p_restaurant: alpha })).syncing).toBe(true);

    await db.rpc("sync_finish", { p_run: run, p_status: "failed", p_stats: null, p_error_code: "clover_unavailable", p_error_message: "x" });
    let status = await db.rpc("clover_connection_status", { p_restaurant: alpha });
    expect(status.syncing).toBe(false);
    expect(status.last_error_code).toBe("clover_unavailable");

    const second = await db.rpc("sync_claim", { p_restaurant: alpha, p_trigger: "manual", p_lock_seconds: 60 });
    await db.rpc("sync_finish", { p_run: second, p_status: "succeeded", p_stats: {}, p_error_code: null, p_error_message: null });
    status = await db.rpc("clover_connection_status", { p_restaurant: alpha });
    expect(status.last_error_code).toBeNull();
    expect(status.last_success_at).toBeTruthy();
  });

  it("refuses to sync a restaurant that is not connected", async () => {
    expect(await db.rpc("sync_claim", { p_restaurant: beta, p_trigger: "manual", p_lock_seconds: 60 })).toBeNull();
    expect(await db.rpc("sync_due", { p_restaurant: beta, p_ttl_seconds: 300 })).toBe(false);
  });

  it("reports a sync as due only when stale or requested", async () => {
    expect(await db.rpc("sync_due", { p_restaurant: alpha, p_ttl_seconds: 300 })).toBe(false);
    await db.rpc("sync_request", { p_restaurant: alpha });
    expect(await db.rpc("sync_due", { p_restaurant: alpha, p_ttl_seconds: 300 })).toBe(true);
  });

  it("allows up to the limit inside a window", async () => {
    const hit = () => db.rpc("rate_limit_hit", { p_key: "test:1", p_max: 2, p_window_seconds: 3600 });
    expect(await hit()).toBe(true);
    expect(await hit()).toBe(true);
    expect(await hit()).toBe(false);
  });

  it("replays a completed idempotent request and detects key reuse", async () => {
    const begin = (hash) => db.rpc("idem_begin", { p_restaurant: alpha, p_key: "key-0001", p_hash: hash });
    expect(await begin("h1")).toEqual({ state: "new" });
    expect(await begin("h1")).toEqual({ state: "in_progress" });
    await db.rpc("idem_finish", { p_restaurant: alpha, p_key: "key-0001", p_status: "completed", p_response_status: 201, p_response_body: { id: "X" } });
    expect(await begin("h1")).toEqual({ state: "replay", response_status: 201, response_body: { id: "X" } });
    expect(await begin("h2")).toEqual({ state: "mismatch" });
  });

  it("asks the caller to reconcile after an unknown outcome", async () => {
    const begin = () => db.rpc("idem_begin", { p_restaurant: alpha, p_key: "key-0002", p_hash: "h" });
    await begin();
    await db.rpc("idem_finish", { p_restaurant: alpha, p_key: "key-0002", p_status: "unknown", p_response_status: null, p_response_body: null });
    expect((await begin()).state).toBe("reconcile");
  });

  it("consumes an OAuth state exactly once and only for the same user and restaurant", async () => {
    const user = await createUser(pg, alpha);
    const other = await createUser(pg, alpha);
    await db.rpc("oauth_state_create", { p_restaurant: alpha, p_user: user.id, p_nonce_hash: "hash-1", p_ttl_seconds: 600 });
    expect(await db.rpc("oauth_state_consume", { p_restaurant: alpha, p_user: other.id, p_nonce_hash: "hash-1" })).toBe(false);
    expect(await db.rpc("oauth_state_consume", { p_restaurant: beta, p_user: user.id, p_nonce_hash: "hash-1" })).toBe(false);
    expect(await db.rpc("oauth_state_consume", { p_restaurant: alpha, p_user: user.id, p_nonce_hash: "hash-1" })).toBe(true);
    expect(await db.rpc("oauth_state_consume", { p_restaurant: alpha, p_user: user.id, p_nonce_hash: "hash-1" })).toBe(false);
  });
});
