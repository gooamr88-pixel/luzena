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
    removed_from_clover: false, updated_at: stamp(600), image_path: null, dish_image_path: null,
  }));
  const groups = new Map();
  const items = [];
  // The website order of the items inside each category, as the real menu_item_categories
  // positions: the sample's own order to begin with.
  const itemOrder = new Map(sample.categories.map((category) => [category.id, category.items.map((item) => item.id)]));
  const positionIn = (categoryId, itemId) => {
    const index = (itemOrder.get(categoryId) ?? []).indexOf(itemId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  sample.categories.forEach((category) => category.items.forEach((item, index) => {
    for (const group of item.modifier_groups) groups.set(group.id, { ...group, show_by_default: true });
    items.push({
      id: item.id, name: item.name, price_cents: item.price_cents, price_type: item.price_type, unit_name: item.unit_name,
      hidden: false, available: item.available, modified_time: Date.now(), removed_from_clover: false,
      description: item.description, image_path: null, featured: item.featured, web_hidden: false,
      dietary: [], label_ids: [], archived: false, synced_at: stamp(4), updated_at: stamp(30 + index * 95),
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

  // Menu labels: a new restaurant's starting nine, on no dish. And the allergy notice: off.
  const LABEL_ICONS = ["flame", "leaf", "sprout", "nut", "milk", "wheat", "egg", "fish", "shell", "star", "sparkle", "chef-hat", "seal", "heart", "sun", "clock", "drop", "cup"];
  let labels = [["Spicy", "flame"], ["Vegetarian", "leaf"], ["Vegan", "sprout"], ["Contains Nuts", "nut"], ["Contains Dairy", "milk"],
    ["Contains Gluten", "wheat"], ["Popular", "star"], ["New", "sparkle"], ["Chef's Choice", "chef-hat"]]
    .map(([name, icon], index) => ({ id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, name, icon, description: null, active: true, sort_order: index + 1, updated_at: stamp(900) }));
  const labelList = () => labels.map((label) => ({ ...label, item_count: items.filter((item) => item.label_ids.includes(label.id)).length }));
  let notice = { enabled: false, entries: [], updated_at: null };
  const NOTICE_LANGUAGES = ["en", "ar", "es", "fr", "tr", "zh"];

  // The website's own photos. None chosen to begin with, as on a new site.
  const GALLERY_LIMIT = 24;
  const sitePhotos = { hero: null, story: null, gallery: [] };

  const view = (item) => ({
    ...item,
    on_website: !item.hidden && !item.web_hidden && !item.archived && !item.removed_from_clover,
  });
  const find = (id) => {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new ApiFailure(404, { code: "not_found", message: "This item does not exist." });
    return item;
  };
  const categoryList = () => [...categories].sort((a, b) => a.sort_order - b.sort_order).map((category) => {
    const own = items.filter((item) => !item.archived && item.categories.some((c) => c.id === category.id));
    return {
      ...category, item_count: own.length,
      on_website_count: own.filter((item) => !item.hidden && !item.web_hidden).length,
    };
  });
  const groupList = () => [...groups.values()].map((group) => ({
    ...group, item_count: items.filter((item) => item.modifier_groups.some((g) => g.id === group.id)).length,
  }));

  function applyItem(item, body) {
    const clover = body.clover ?? {};
    for (const key of ["name", "price_cents", "available", "hidden"]) if (key in clover) item[key] = clover[key];
    if (clover.category_ids) item.categories = categories.filter((c) => clover.category_ids.includes(c.id)).map((c) => ({ id: c.id, name: c.name }));
    if (clover.modifier_group_ids) item.modifier_groups = [...groups.values()].filter((g) => clover.modifier_group_ids.includes(g.id)).map((g) => ({ id: g.id, name: g.name }));
    const website = body.website ?? {};
    for (const key of ["description", "featured", "web_hidden", "dietary", "label_ids", "archived"]) if (key in website) item[key] = website[key];
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
      // An item the owner has not placed goes last, by name, as the real query does.
      custom: (a, b) => positionIn(category, a.id) - positionIn(category, b.id) || a.name.localeCompare(b.name),
    };
    list = [...list].sort(sorters[query.get("sort")] ?? ((a, b) => a.name.localeCompare(b.name) * direction));
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 25);
    return { total: list.length, limit, offset, items: list.slice(offset, offset + limit).map(view) };
  }

  async function demoApi(method, fullPath, body) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (factors.some((factor) => factor.status === "verified") && level !== "aal2") {
      throw new ApiFailure(403, { code: "mfa_required", message: "Enter the code from your authenticator app to continue." });
    }
    const [path, queryString = ""] = fullPath.split("?");
    const query = new URLSearchParams(queryString);
    let match;

    if (path === "/me") {
      return {
        user: { email: "owner@example.com" },
        restaurant: { id: "demo", name: document.documentElement.dataset.restaurantName || "Restaurant", slug: "demo", currency: sample.currency },
        role: "owner", permissions: ["menu.read", "menu.write", "clover.manage", "activity.read", "applications.read", "applications.manage", "site.manage"], dietary_tags: DIETARY,
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
        featured: false, web_hidden: false, dietary: [], label_ids: [], archived: false, synced_at: stamp(), categories: [], modifier_groups: [],
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
      categories.push({ id: newId("DEMOCAT"), name: body.name, sort_order: categories.length + 1, web_hidden: false, archived: false, removed_from_clover: false, updated_at: stamp(), image_path: null, dish_image_path: null });
      log("CATEGORY_CREATED", "category", null, body, "success", "SYNCED");
      return { result: "synced", categories: categoryList(), message: "Demo: category created." };
    }
    if (path === "/categories/reorder") {
      body.ids.forEach((id, index) => { categories.find((c) => c.id === id).sort_order = index + 1; });
      log("CATEGORY_REORDERED", "category", null, body, "success", "SYNCED");
      return { result: "synced", categories: categoryList(), message: "Demo: order saved." };
    }
    if ((match = path.match(/^\/categories\/([A-Z0-9]{13})\/items\/reorder$/))) {
      if (!categories.some((c) => c.id === match[1])) throw new ApiFailure(404, { code: "not_found", message: "This category does not exist." });
      // Listed items first, in the order sent; any other item of the category after them.
      const rest = (itemOrder.get(match[1]) ?? []).filter((id) => !body.ids.includes(id));
      itemOrder.set(match[1], [...body.ids, ...rest]);
      log("ITEMS_REORDERED", "category", match[1], { count: body.ids.length });
      return { result: "saved", message: "Item order saved." };
    }
    if ((match = path.match(/^\/categories\/([A-Z0-9]{13})\/image$/))) {
      const category = categories.find((c) => c.id === match[1]);
      if (!category) throw new ApiFailure(404, { code: "not_found", message: "This category does not exist." });
      // The chosen file is shown straight from the browser's memory. It is uploaded nowhere.
      category.image_path = method === "DELETE" ? null : URL.createObjectURL(body.get("file"));
      log(method === "DELETE" ? "CATEGORY_IMAGE_REMOVED" : "CATEGORY_IMAGE_UPDATED", "category", category.id, null);
      return {
        result: "saved", categories: categoryList(),
        message: method === "DELETE" ? "Demo: photo removed." : "Demo: photo set in this browser tab only.",
      };
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
      if (method === "DELETE") {
        applications.splice(applications.indexOf(application), 1);
        log("APPLICATION_DELETED", "application", application.id, null);
        return { result: "deleted", message: "Demo: deleted in this browser tab only." };
      }
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

    if (path === "/labels" && method === "GET") return { labels: labelList(), icons: LABEL_ICONS, limits: { labels: 40, per_item: 12 } };
    if (path === "/labels" && method === "POST") {
      if (labels.some((label) => label.name.toLowerCase() === body.name.toLowerCase())) {
        throw new ApiFailure(409, { code: "duplicate", message: "There is already a label with this name." });
      }
      const label = { id: crypto.randomUUID(), name: body.name, icon: body.icon, description: body.description ?? null, active: true, sort_order: labels.length + 1, updated_at: stamp() };
      labels.push(label);
      log("LABEL_CREATED", "label", label.id, { name: label.name });
      return { result: "saved", labels: labelList(), id: label.id, message: "Demo: label added in this browser tab only." };
    }
    if (path === "/labels/reorder") {
      labels = body.ids.map((id) => labels.find((label) => label.id === id));
      return { result: "saved", labels: labelList(), message: "Demo: order saved." };
    }
    if ((match = path.match(/^\/labels\/([0-9a-f-]{36})$/))) {
      const label = labels.find((entry) => entry.id === match[1]);
      if (!label) throw new ApiFailure(404, { code: "not_found", message: "This label does not exist." });
      if (method === "DELETE") {
        const dishes = items.filter((item) => item.label_ids.includes(label.id));
        for (const item of dishes) item.label_ids = item.label_ids.filter((id) => id !== label.id);
        labels = labels.filter((entry) => entry !== label);
        log("LABEL_DELETED", "label", label.id, null);
        return { result: "saved", labels: labelList(), message: dishes.length === 0 ? "Demo: label deleted." : `Demo: label deleted and taken off ${dishes.length} ${dishes.length === 1 ? "dish" : "dishes"}.` };
      }
      if (body.name && labels.some((entry) => entry !== label && entry.name.toLowerCase() === body.name.toLowerCase())) {
        throw new ApiFailure(409, { code: "duplicate", message: "There is already a label with this name." });
      }
      Object.assign(label, body, { updated_at: stamp() });
      log("LABEL_UPDATED", "label", label.id, body);
      return { result: "saved", labels: labelList(), message: body.active === false ? "Demo: label switched off." : body.active === true ? "Demo: label switched on." : "Demo: label saved." };
    }
    if (path === "/site/notice" && method === "GET") return { notice, languages: NOTICE_LANGUAGES, limits: { text: 600 } };
    if (path === "/site/notice" && method === "PUT") {
      const entries = body.entries.filter((entry) => entry.text !== "");
      if (body.enabled && entries.length === 0) throw new ApiFailure(422, { code: "validation_failed", message: "Write the notice before turning it on." });
      notice = { enabled: body.enabled, entries, updated_at: stamp() };
      log("ALLERGY_NOTICE_UPDATED", "site_settings", "allergy_notice", { enabled: body.enabled });
      return { result: "saved", notice, message: body.enabled ? "Demo: notice saved in this browser tab only." : "Demo: notice saved, switched off." };
    }

    if (path === "/site/photos" && method === "GET") return { photos: sitePhotos, limits: { gallery: GALLERY_LIMIT } };
    if (path === "/site/photos" && method === "POST") {
      const slot = body.get("slot");
      if (slot === "gallery" && sitePhotos.gallery.length >= GALLERY_LIMIT) {
        throw new ApiFailure(409, { code: "gallery_full", message: `The gallery holds ${GALLERY_LIMIT} photos. Remove one to add another.` });
      }
      // The chosen file is shown straight from the browser's memory. It is uploaded nowhere.
      const small = body.get("file_small");
      const photo = {
        id: crypto.randomUUID(), path: URL.createObjectURL(body.get("file")), small_path: small ? URL.createObjectURL(small) : null,
        width: Number(body.get("width")), height: Number(body.get("height")), small_width: Number(body.get("small_width")) || null,
        alt: body.get("alt") ?? "", updated_at: stamp(),
      };
      if (slot === "gallery") sitePhotos.gallery.push(photo);
      else sitePhotos[slot] = photo;
      log("SITE_PHOTO_SET", "site_photo", slot, { slot });
      return { result: "saved", photos: sitePhotos, message: slot === "gallery" ? "Demo: photo added in this browser tab only." : "Demo: photo set in this browser tab only." };
    }
    if (path === "/site/photos/reorder") {
      sitePhotos.gallery = body.ids.map((id) => sitePhotos.gallery.find((photo) => photo.id === id));
      return { result: "saved", photos: sitePhotos, message: "Demo: order saved." };
    }
    if ((match = path.match(/^\/site\/photos\/([0-9a-f-]{36})$/))) {
      const slot = ["hero", "story"].find((name) => sitePhotos[name]?.id === match[1]);
      const photo = slot ? sitePhotos[slot] : sitePhotos.gallery.find((entry) => entry.id === match[1]);
      if (!photo) throw new ApiFailure(404, { code: "not_found", message: "This photo does not exist." });
      if (method === "PATCH") {
        photo.alt = body.alt;
        return { result: "saved", photos: sitePhotos, message: "Demo: description saved." };
      }
      if (slot) sitePhotos[slot] = null;
      else sitePhotos.gallery = sitePhotos.gallery.filter((entry) => entry !== photo);
      log("SITE_PHOTO_REMOVED", "site_photo", photo.id, null);
      return { result: "saved", photos: sitePhotos, message: "Demo: photo removed." };
    }

    if (path === "/activity") return { entries: query.get("before") ? [] : activity.slice(0, 30) };

    throw new ApiFailure(404, { code: "not_found", message: "Not found." });
  }

  // The smallest slice of the Supabase Auth client that the dashboard uses.
  let listener = () => {};
  const session = { access_token: "demo", user: { id: "demo-user" } };
  let signedIn = true;

  // Two-step sign-in, as far as the screens need it. A stand-in for Supabase Auth's own:
  // nothing here is a real secret, and the only code it accepts is 123456.
  const DEMO_CODE = "123456";
  const QR = "data:image/svg+xml;utf-8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#fff"/>'
    + '<path fill="#18120f" d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1zM10 1h1v3h-1zM10 6h2v2h-2zM9 10h3v1H9zM13 10h2v2h-2zM17 10h3v1h-3zM10 13h2v3h-2zM14 14h3v2h-3zM18 13h2v2h-2zM13 18h3v2h-3zM18 17h2v3h-2z"/>'
    + '<path fill="#fff" d="M2 2h5v5H2zM14 2h5v5h-5zM2 14h5v5H2z"/><path fill="#18120f" d="M3 3h3v3H3zM15 3h3v3h-3zM3 15h3v3H3z"/></svg>');
  let factors = [];
  let level = "aal1";
  const refused = (message) => ({ data: null, error: { message } });
  const mfa = {
    listFactors: async () => ({
      data: { all: factors.map((factor) => ({ ...factor })), totp: factors.filter((factor) => factor.status === "verified").map((factor) => ({ ...factor })) },
      error: null,
    }),
    enroll: async ({ friendlyName }) => {
      const factor = { id: crypto.randomUUID(), factor_type: "totp", friendly_name: friendlyName, status: "unverified", created_at: stamp() };
      factors.push(factor);
      return { data: { id: factor.id, type: "totp", totp: { qr_code: QR, secret: "DEMO KEY 2345 6723 4567 ABCD", uri: "otpauth://totp/demo" } }, error: null };
    },
    challengeAndVerify: async ({ factorId, code }) => {
      const factor = factors.find((entry) => entry.id === factorId);
      if (!factor || code !== DEMO_CODE) return refused("Invalid TOTP code entered");
      factor.status = "verified";
      level = "aal2";
      return { data: { user: session.user }, error: null };
    },
    unenroll: async ({ factorId }) => {
      const factor = factors.find((entry) => entry.id === factorId);
      // As Supabase does: a factor that is in use is only removed by a session that used it.
      if (factor?.status === "verified" && level !== "aal2") return refused("AAL2 required");
      factors = factors.filter((entry) => entry.id !== factorId);
      return { data: { id: factorId }, error: null };
    },
    getAuthenticatorAssuranceLevel: async () => ({
      data: { currentLevel: signedIn ? level : null, nextLevel: factors.some((factor) => factor.status === "verified") ? "aal2" : "aal1" },
      error: null,
    }),
  };
  state.supabase = {
    auth: {
      onAuthStateChange(callback) {
        listener = callback;
        // ?demo=reset-two-step opens the dashboard as a reset link would, for an account that
        // has two-step sign-in on: the way to review that screen without an email.
        if (new URLSearchParams(window.location.search).get("demo") === "reset-two-step") {
          signedIn = true;
          level = "aal1";
          factors = [{ id: crypto.randomUUID(), factor_type: "totp", friendly_name: "Authenticator app", status: "verified", created_at: stamp() }];
          return callback("PASSWORD_RECOVERY", session);
        }
        callback(signedIn ? "SIGNED_IN" : "SIGNED_OUT", signedIn ? session : null);
      },
      getSession: async () => ({ data: { session: signedIn ? session : null } }),
      refreshSession: async () => ({ data: { session: signedIn ? session : null } }),
      // A new sign-in starts at the password alone, as a real one does.
      signInWithPassword: async () => { signedIn = true; level = "aal1"; listener("SIGNED_IN", session); return { error: null }; },
      signOut: async () => { signedIn = false; level = "aal1"; listener("SIGNED_OUT", null); },
      mfa,
      resetPasswordForEmail: async () => ({ error: null }),
      // As Supabase does: with two-step sign-in on, the password changes only at aal2.
      updateUser: async ({ password }) =>
        (password && factors.some((factor) => factor.status === "verified") && level !== "aal2"
          ? { data: null, error: { message: "AAL2 session is required to update email or password when MFA is enabled." } }
          : { data: { user: session.user }, error: null }),
    },
  };
  state.demo = demoApi;
  state.storageBase = "";
}
