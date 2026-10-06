// DEMO MODE. An in-memory stand-in for Supabase Auth and the dashboard API, so the
// dashboard can be reviewed before any backend exists.
//
// It is loaded only when the site is built with VITE_DASHBOARD_DEMO=1, which the build
// allows only for the sample profile. It is never part of a production bundle. Nothing here
// talks to Clover or a database, and nothing is saved: a reload resets everything.
import sample from "../../content/sample-menu.json";
import { ApiFailure } from "./api.js";

const DIETARY = ["vegetarian", "vegan", "gluten-free", "dairy-free", "nut-free", "halal", "spicy"];

export function installDemo(state) {
  const stamp = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  let sequence = 0;
  const newId = (prefix) => `${prefix}${String(++sequence).padStart(13 - prefix.length, "0")}`;

  const categories = sample.categories.map((category, index) => ({
    id: category.id, name: category.name, sort_order: index + 1, web_hidden: false, archived: false,
    removed_from_clover: false, updated_at: stamp(600),
  }));
  const groups = new Map();
  const items = [];
  sample.categories.forEach((category) => category.items.forEach((item, index) => {
    for (const group of item.modifier_groups) groups.set(group.id, { ...group, show_by_default: true });
    items.push({
      id: item.id, name: item.name, price_cents: item.price_cents, price_type: item.price_type, unit_name: item.unit_name,
      hidden: false, available: item.available, modified_time: Date.now(), removed_from_clover: false,
      description: item.description, image_path: null, featured: item.featured, web_hidden: false,
      dietary: item.dietary, archived: false, synced_at: stamp(4), updated_at: stamp(30 + index * 95),
      categories: [{ id: category.id, name: category.name }],
      modifier_groups: item.modifier_groups.map((group) => ({ id: group.id, name: group.name })),
    });
  }));

  const connection = {
    connected: true, status: "active", merchant_id: "DEMOMERCHANT1", merchant_name: "Demo merchant", environment: "sandbox",
    connected_at: stamp(60 * 24 * 12), syncing: false, last_sync_started_at: stamp(4), last_sync_finished_at: stamp(4),
    last_success_at: stamp(4), last_error_code: null, last_error_at: null,
  };
  const activity = [];
  const log = (action, entityType, entityId, newValues, result = "success", syncStatus = null) =>
    activity.unshift({
      id: activity.length + 1, actor_email: "owner@example.com", action, entity_type: entityType, entity_id: entityId,
      old_values: null, new_values: newValues, result, sync_status: syncStatus, request_id: null, created_at: stamp(),
    });
  log("CLOVER_CONNECTED", "clover_connection", connection.merchant_id, null);
  log("SYNC_COMPLETED", "sync", null, { items: items.length }, "success", "SYNCED");

  const view = (item) => ({
    ...item,
    on_website: !item.hidden && !item.web_hidden && !item.archived && !item.removed_from_clover,
  });
  const find = (id) => {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new ApiFailure(404, { code: "not_found", message: "This item does not exist." });
    return item;
  };
  const categoryList = () => [...categories].sort((a, b) => a.sort_order - b.sort_order).map((category) => ({
    ...category,
    item_count: items.filter((item) => !item.archived && item.categories.some((c) => c.id === category.id)).length,
  }));
  const groupList = () => [...groups.values()].map((group) => ({
    ...group, item_count: items.filter((item) => item.modifier_groups.some((g) => g.id === group.id)).length,
  }));

  function applyItem(item, body) {
    const clover = body.clover ?? {};
    for (const key of ["name", "price_cents", "available", "hidden"]) if (key in clover) item[key] = clover[key];
    if (clover.category_ids) item.categories = categories.filter((c) => clover.category_ids.includes(c.id)).map((c) => ({ id: c.id, name: c.name }));
    if (clover.modifier_group_ids) item.modifier_groups = [...groups.values()].filter((g) => clover.modifier_group_ids.includes(g.id)).map((g) => ({ id: g.id, name: g.name }));
    const website = body.website ?? {};
    for (const key of ["description", "featured", "web_hidden", "dietary", "archived"]) if (key in website) item[key] = website[key];
    item.updated_at = stamp();
    return item;
  }

  function listItems(query) {
    const status = query.get("status") ?? "active";
    const search = (query.get("search") ?? "").toLowerCase();
    const category = query.get("category");
    let list = items.filter((item) => (status === "archived" ? item.archived : status === "removed" ? item.removed_from_clover : !item.archived));
    if (search) list = list.filter((item) => item.name.toLowerCase().includes(search) || item.categories.some((c) => c.name.toLowerCase().includes(search)));
    if (category === "none") list = list.filter((item) => item.categories.length === 0);
    else if (category) list = list.filter((item) => item.categories.some((c) => c.id === category));
    if (query.get("availability")) list = list.filter((item) => item.available === (query.get("availability") === "available"));
    if (query.get("visibility")) list = list.filter((item) => (!item.hidden && !item.web_hidden) === (query.get("visibility") === "visible"));
    if (query.get("featured")) list = list.filter((item) => item.featured === (query.get("featured") === "true"));
    const direction = query.get("dir") === "desc" ? -1 : 1;
    const sorters = {
      // An item without a price goes last in both directions, as the real query does.
      price: (a, b) => (a.price_cents === null) - (b.price_cents === null) || (a.price_cents - b.price_cents) * direction,
      updated: (a, b) => a.updated_at.localeCompare(b.updated_at) * direction,
      category: (a, b) => (a.categories[0]?.name ?? "~").localeCompare(b.categories[0]?.name ?? "~") * direction,
    };
    list = [...list].sort(sorters[query.get("sort")] ?? ((a, b) => a.name.localeCompare(b.name) * direction));
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 25);
    return { total: list.length, limit, offset, items: list.slice(offset, offset + limit).map(view) };
  }

  async function demoApi(method, fullPath, body) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    const [path, queryString = ""] = fullPath.split("?");
    const query = new URLSearchParams(queryString);
    let match;

    if (path === "/me") {
      return {
        user: { email: "owner@example.com" },
        restaurant: { id: "demo", name: document.documentElement.dataset.restaurantName || "Restaurant", slug: "demo", currency: sample.currency },
        role: "owner", permissions: ["menu.read", "menu.write", "clover.manage", "activity.read"], dietary_tags: DIETARY,
      };
    }
    if (path === "/overview") {
      const live = items.filter((item) => !item.archived);
      return {
        counts: {
          items: live.length,
          on_website: live.filter((item) => !item.hidden && !item.web_hidden).length,
          hidden: live.filter((item) => item.hidden || item.web_hidden).length,
          unavailable: live.filter((item) => !item.available).length,
          archived: items.length - live.length,
          featured: live.filter((item) => item.featured).length,
        },
        categories: categories.filter((c) => !c.archived).length,
        recent_items: [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6),
        connection, sync_errors: [], recent_activity: activity.slice(0, 8),
      };
    }
    if (path === "/items" && method === "GET") return listItems(query);
    if (path === "/items" && method === "POST") {
      const item = applyItem({
        id: newId("DEMOITEM"), price_type: "FIXED", unit_name: null, hidden: false, available: true,
        modified_time: Date.now(), removed_from_clover: false, description: null, image_path: null,
        featured: false, web_hidden: false, dietary: [], archived: false, synced_at: stamp(), categories: [], modifier_groups: [],
      }, body);
      items.push(item);
      log("ITEM_CREATED", "item", item.id, body, "success", "SYNCED");
      return { result: "synced", item: view(item), clover_changed: true, website_changed: true, failed_parts: [], message: "Demo: item created. Nothing was sent to Clover." };
    }
    if (path === "/items/bulk") {
      const patch = {
        show: { web_hidden: false }, hide: { web_hidden: true }, archive: { archived: true }, restore: { archived: false },
        available: { available: true }, unavailable: { available: false },
      }[body.action];
      for (const id of body.ids) Object.assign(find(id), patch, { updated_at: stamp() });
      log(`ITEMS_BULK_${body.action.toUpperCase()}`, "item", null, { ids: body.ids });
      return { result: "saved", succeeded: body.ids, failed: [], message: `Demo: ${body.ids.length} items updated.` };
    }
    if ((match = path.match(/^\/items\/([A-Z0-9]{13})$/))) {
      const item = find(match[1]);
      if (method === "GET") return { item: view(item) };
      applyItem(item, body);
      log("ITEM_UPDATED", "item", item.id, body, "success", body.clover ? "SYNCED" : null);
      return {
        result: body.clover ? "synced" : "saved", item: view(item), clover_changed: Boolean(body.clover),
        website_changed: Boolean(body.website), failed_parts: [], message: "Demo: saved in this browser tab only.",
      };
    }
    if (/^\/items\/[A-Z0-9]{13}\/image$/.test(path)) {
      throw new ApiFailure(503, { code: "demo", message: "Photos cannot be uploaded in demo mode, because there is no storage to put them in." });
    }

    if (path === "/categories" && method === "GET") return { categories: categoryList() };
    if (path === "/categories" && method === "POST") {
      categories.push({ id: newId("DEMOCAT"), name: body.name, sort_order: categories.length + 1, web_hidden: false, archived: false, removed_from_clover: false, updated_at: stamp() });
      log("CATEGORY_CREATED", "category", null, body, "success", "SYNCED");
      return { result: "synced", categories: categoryList(), message: "Demo: category created." };
    }
    if (path === "/categories/reorder") {
      body.ids.forEach((id, index) => { categories.find((c) => c.id === id).sort_order = index + 1; });
      log("CATEGORY_REORDERED", "category", null, body, "success", "SYNCED");
      return { result: "synced", categories: categoryList(), message: "Demo: order saved." };
    }
    if ((match = path.match(/^\/categories\/([A-Z0-9]{13})$/))) {
      const category = categories.find((c) => c.id === match[1]);
      Object.assign(category, body.clover ?? {}, body.website ?? {}, { updated_at: stamp() });
      for (const item of items) for (const link of item.categories) if (link.id === category.id) link.name = category.name;
      log("CATEGORY_UPDATED", "category", category.id, body, "success", body.clover ? "SYNCED" : null);
      return { result: body.clover ? "synced" : "saved", categories: categoryList(), message: "Demo: saved." };
    }

    if (path === "/modifier-groups" && method === "GET") return { modifier_groups: groupList() };
    if (path === "/modifier-groups" && method === "POST") {
      const id = newId("DEMOGRP");
      groups.set(id, { id, name: body.name, min_required: body.min_required ?? null, max_allowed: body.max_allowed ?? null, show_by_default: true, modifiers: [] });
      return { result: "synced", modifier_groups: groupList(), message: "Demo: modifier group created." };
    }
    if ((match = path.match(/^\/modifier-groups\/([A-Z0-9]{13})$/))) {
      Object.assign(groups.get(match[1]), body.clover);
      return { result: "synced", modifier_groups: groupList(), message: "Demo: saved." };
    }
    if ((match = path.match(/^\/modifier-groups\/([A-Z0-9]{13})\/modifiers$/))) {
      groups.get(match[1]).modifiers.push({ id: newId("DEMOMOD"), name: body.name, price_cents: body.price_cents, available: true });
      return { result: "synced", modifier_groups: groupList(), message: "Demo: modifier created." };
    }
    if ((match = path.match(/^\/modifier-groups\/([A-Z0-9]{13})\/modifiers\/([A-Z0-9]{13})$/))) {
      Object.assign(groups.get(match[1]).modifiers.find((m) => m.id === match[2]), body.clover);
      return { result: "synced", modifier_groups: groupList(), message: "Demo: saved." };
    }

    if (path === "/clover" && method === "GET") return { connection, configured: true };
    if (path === "/clover/sync") {
      Object.assign(connection, { last_sync_started_at: stamp(), last_sync_finished_at: stamp(), last_success_at: stamp() });
      log("SYNC_COMPLETED", "sync", null, { items: items.length }, "success", "SYNCED");
      return { result: "synced", stats: { items: items.length }, connection, message: "Demo: nothing was synced, because there is no Clover connection." };
    }
    if (path.startsWith("/clover/")) {
      throw new ApiFailure(503, { code: "demo", message: "Connecting and disconnecting Clover is not available in demo mode." });
    }
    if (path === "/activity") return { entries: query.get("before") ? [] : activity.slice(0, 30) };

    throw new ApiFailure(404, { code: "not_found", message: "Not found." });
  }

  // The smallest slice of the Supabase Auth client that the dashboard uses.
  let listener = () => {};
  const session = { access_token: "demo", user: { id: "demo-user" } };
  let signedIn = true;
  state.supabase = {
    auth: {
      onAuthStateChange(callback) { listener = callback; callback(signedIn ? "SIGNED_IN" : "SIGNED_OUT", signedIn ? session : null); },
      getSession: async () => ({ data: { session: signedIn ? session : null } }),
      refreshSession: async () => ({ data: { session: signedIn ? session : null } }),
      signInWithPassword: async () => { signedIn = true; listener("SIGNED_IN", session); return { error: null }; },
      signOut: async () => { signedIn = false; listener("SIGNED_OUT", null); },
      resetPasswordForEmail: async () => ({ error: null }),
      updateUser: async () => ({ error: null }),
    },
  };
  state.demo = demoApi;
  state.storageBase = "";
}
