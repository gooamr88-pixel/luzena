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

  // Job applications. Invented people at an address that cannot exist, so the screens can
  // be reviewed with no real applicant's details anywhere near a demo.
  let eventId = 0;
  const event = (kind, minutesAgo, extra = {}) => ({
    id: ++eventId, kind, from_status: null, to_status: null, note: null, actor_email: null, created_at: stamp(minutesAgo), ...extra,
  });
  const person = (number, fullName, position, minutesAgo, answers, events = []) => ({
    id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    full_name: fullName, email: `${fullName.toLowerCase().replace(/[^a-z]+/g, ".")}@example.test`,
    phone: `+1 619 555 01${String(10 + number)}`, position, status: "new", status_changed_at: null, email_status: "sent",
    employment_type: "full_time", availability: ["weekday_evenings", "weekend_evenings"], start_when: "two_weeks",
    experience_level: "1_2", experience: null, work_authorized: true, message: null, cv: null,
    created_at: stamp(minutesAgo),
    events: [event("submitted", minutesAgo, { to_status: "new" }), event("email_sent", minutesAgo), ...events],
    ...answers,
  });
  const applications = [
    person(1, "Maya Thompson", "Barista", 35, {
      experience_level: "3_5", employment_type: "part_time", availability: ["weekday_days", "weekend_days"], start_when: "immediately",
      experience: "Three years behind the bar at a neighbourhood cafe: espresso, pour-over, opening and closing.\nTrained two new baristas.",
      message: "I live ten minutes away and would love to help open the cafe side.",
      cv: { name: "Maya-Thompson-CV.pdf", mime: "application/pdf", size: 184_320 },
    }),
    person(2, "Daniel Ortiz", "Line Cook", 190, {
      experience_level: "over_5", availability: ["weekday_evenings", "weekend_evenings", "late_nights"],
      experience: "Six years on grill and saute in two busy kitchens.",
      cv: { name: "Daniel-Ortiz-Resume.pdf", mime: "application/pdf", size: 96_200 },
    }),
    person(3, "Priya Nair", "Waiter / Waitress", 60 * 26, {
      status: "reviewing", status_changed_at: stamp(60 * 20), employment_type: "either", experience_level: "1_2",
      message: "Available most evenings. Happy to start with a trial shift.",
    }, [event("status_changed", 60 * 20, { from_status: "new", to_status: "reviewing", actor_email: "owner@example.com" })]),
    person(4, "Omar Haddad", "Head Chef", 60 * 50, {
      status: "interview", status_changed_at: stamp(60 * 30), experience_level: "over_5", start_when: "one_month",
      experience: "Twelve years in Mediterranean kitchens, the last four as sous chef.",
      cv: { name: "Omar-Haddad-CV.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 48_100 },
    }, [
      event("status_changed", 60 * 44, { from_status: "new", to_status: "shortlisted", actor_email: "owner@example.com" }),
      event("cv_downloaded", 60 * 43, { actor_email: "owner@example.com" }),
      event("status_changed", 60 * 30, { from_status: "shortlisted", to_status: "interview", actor_email: "owner@example.com", note: "Interview on Thursday at 3 PM." }),
    ]),
    person(5, "Lena Fischer", "Host / Hostess", 60 * 24 * 6, {
      status: "hired", status_changed_at: stamp(60 * 24 * 2), employment_type: "part_time", experience_level: "under_1",
    }, [
      event("status_changed", 60 * 24 * 5, { from_status: "new", to_status: "interview", actor_email: "owner@example.com" }),
      event("status_changed", 60 * 24 * 2, { from_status: "interview", to_status: "hired", actor_email: "owner@example.com", note: "Starts on the 15th." }),
    ]),
    person(6, "Chris Wallace", "Dishwasher / Kitchen Steward", 60 * 24 * 9, {
      status: "rejected", status_changed_at: stamp(60 * 24 * 7), experience_level: "none", work_authorized: false, email_status: "failed",
    }, [event("status_changed", 60 * 24 * 7, { from_status: "new", to_status: "rejected", actor_email: "owner@example.com" })]),
  ];
  // The second event of the last applicant is the email that did not go out.
  applications[5].events[1].kind = "email_failed";

  const findApplication = (id) => {
    const application = applications.find((entry) => entry.id === id);
    if (!application) throw new ApiFailure(404, { code: "not_found", message: "This application does not exist." });
    return application;
  };
  const applicationDetail = (application) => ({
    ...application,
    other_applications: applications.filter((entry) => entry.email === application.email && entry.id !== application.id).length,
  });
  function listApplications(query) {
    const search = (query.get("search") ?? "").toLowerCase();
    const from = query.get("from");
    const to = query.get("to");
    const matching = applications
      .filter((entry) => !query.get("status") || entry.status === query.get("status"))
      .filter((entry) => !query.get("position") || entry.position === query.get("position"))
      .filter((entry) => (!from || entry.created_at >= from) && (!to || entry.created_at < to))
      .filter((entry) => !search || [entry.full_name, entry.email, entry.position, entry.phone].some((text) => text.toLowerCase().includes(search)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 25);
    const counts = {};
    for (const entry of applications) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return {
      total: matching.length, limit, offset, counts,
      positions: [...new Set(applications.map((entry) => entry.position))].sort(),
      applications: matching.slice(offset, offset + limit).map((entry) => ({
        id: entry.id, full_name: entry.full_name, position: entry.position, status: entry.status,
        employment_type: entry.employment_type, experience_level: entry.experience_level,
        has_cv: entry.cv !== null, email_status: entry.email_status, created_at: entry.created_at,
      })),
    };
  }

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
        role: "owner", permissions: ["menu.read", "menu.write", "clover.manage", "activity.read", "applications.read", "applications.manage"], dietary_tags: DIETARY,
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

    if (path === "/clover" && method === "GET") return { connection, configured: true, token_connect: true };
    if (path === "/clover/disconnect") {
      Object.assign(connection, { connected: false, merchant_id: null, merchant_name: null, environment: null, connected_at: null });
      log("CLOVER_DISCONNECTED", "clover_connection", null, null);
      return { result: "disconnected", connection, message: "Demo: disconnected. Nothing was changed in Clover." };
    }
    if (path === "/clover/connect-token") {
      // The demo accepts any token except one that starts with "wrong", so both answers
      // of the real backend can be seen. Nothing is sent anywhere and nothing is kept.
      if (String(body.token).startsWith("wrong")) {
        throw new ApiFailure(400, { code: "clover_token_rejected", message: "Clover did not accept this merchant ID and token. Check both and try again." });
      }
      Object.assign(connection, { connected: true, status: "active", merchant_id: body.merchant_id, merchant_name: "Demo merchant", environment: "sandbox", connected_at: stamp() });
      log("CLOVER_CONNECTED", "clover_connection", body.merchant_id, { method: "api_token" });
      return { result: "connected", connection, message: "Demo: connected. Imported items stay hidden from the website until you show them." };
    }
    if (path === "/clover/sync") {
      Object.assign(connection, { last_sync_started_at: stamp(), last_sync_finished_at: stamp(), last_success_at: stamp() });
      log("SYNC_COMPLETED", "sync", null, { items: items.length }, "success", "SYNCED");
      return { result: "synced", stats: { items: items.length }, connection, message: "Demo: nothing was synced, because there is no Clover connection." };
    }
    if (path.startsWith("/clover/")) {
      throw new ApiFailure(503, { code: "demo", message: "Connecting and disconnecting Clover is not available in demo mode." });
    }
    if (path === "/applications") return listApplications(query);
    if (path === "/applications/summary") {
      return { new: applications.filter((entry) => entry.status === "new").length, total: applications.length };
    }
    if ((match = path.match(/^\/applications\/([0-9a-f-]{36})\/cv$/))) {
      const application = findApplication(match[1]);
      if (!application.cv) throw new ApiFailure(404, { code: "not_found", message: "This application has no CV." });
      application.events.push(event("cv_downloaded", 0, { actor_email: "owner@example.com" }));
      log("APPLICATION_CV_DOWNLOADED", "application", application.id, null);
      // A one-page stand-in, so the download can be tried. It is not anyone's CV.
      return new Blob(["%PDF-1.4\n% Demo file. Not a real CV.\n"], { type: "application/pdf" });
    }
    if ((match = path.match(/^\/applications\/([0-9a-f-]{36})$/))) {
      const application = findApplication(match[1]);
      if (method === "GET") return { application: applicationDetail(application) };
      const note = body.note?.trim() || null;
      const changed = body.status !== application.status;
      if (changed) {
        application.events.push(event("status_changed", 0, { from_status: application.status, to_status: body.status, note, actor_email: "owner@example.com" }));
        log("APPLICATION_STATUS_CHANGED", "application", application.id, { status: body.status });
        Object.assign(application, { status: body.status, status_changed_at: stamp() });
      } else if (note) {
        application.events.push(event("note", 0, { note, actor_email: "owner@example.com" }));
      }
      return {
        result: "saved", application: applicationDetail(application),
        message: changed ? "Demo: status changed in this browser tab only." : note ? "Demo: note added." : "Nothing changed.",
      };
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
