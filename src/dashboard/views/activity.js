import { formatDateTime } from "../../js/lib/format.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { append, badge, clear, errorBlock, h, loadingBlock, pageHeader, stateBlock, toastFailure } from "../ui.js";

const LABELS = {
  ITEM_CREATED: "Item created", ITEM_UPDATED: "Item updated", ITEM_IMAGE_UPDATED: "Item photo changed",
  ITEM_IMAGE_REMOVED: "Item photo removed", ITEMS_REORDERED: "Items reordered",
  CATEGORY_CREATED: "Category created", CATEGORY_UPDATED: "Category updated", CATEGORY_REORDERED: "Categories reordered",
  MODIFIER_GROUP_CREATED: "Modifier group created", MODIFIER_GROUP_UPDATED: "Modifier group updated",
  MODIFIER_CREATED: "Modifier created", MODIFIER_UPDATED: "Modifier updated",
  SYNC_STARTED: "Sync started", SYNC_COMPLETED: "Sync completed", SYNC_FAILED: "Sync failed",
  APPLICATION_STATUS_CHANGED: "Job application status changed", APPLICATION_CV_DOWNLOADED: "Job application CV downloaded",
  APPLICATION_DELETED: "Job application deleted",
  CLOVER_CONNECTED: "Clover connected", CLOVER_DISCONNECTED: "Clover disconnected", CLOVER_CONNECT_FAILED: "Clover connection failed",
};

export function actionLabel(action) {
  if (LABELS[action]) return LABELS[action];
  const bulk = /^ITEMS_BULK_(.+)$/.exec(action);
  return bulk ? `Bulk: ${bulk[1].toLowerCase()}` : action;
}

const RESULT_TONE = { success: "ok", failed: "bad", partial: "warn", conflict: "warn" };
export const resultBadge = (result) => badge(result === "success" ? "Done" : result[0].toUpperCase() + result.slice(1), RESULT_TONE[result]);

export async function activityView(outlet) {
  const region = h("div", {}, loadingBlock("Loading activity"));
  append(outlet, pageHeader({ title: "Activity" }), region);
  const entries = [];

  const draw = (hasMore) => {
    clear(region);
    if (entries.length === 0) {
      append(region, stateBlock({ title: "No activity yet", body: "Changes made in this dashboard are recorded here." }));
      return;
    }
    const more = h("button", { type: "button", class: "d-btn" }, "Load older activity");
    more.addEventListener("click", async () => {
      more.disabled = true;
      await load(entries[entries.length - 1].id).catch(toastFailure);
    });
    append(region, 
      h("div", { class: "d-card overflow-x-auto" },
        h("table", { class: "d-table" },
          h("caption", { class: "sr-only" }, "Changes made in the dashboard, newest first"),
          h("thead", {}, h("tr", {}, ["When", "Who", "Action", "Record", "Result", "Clover"].map((title) => h("th", { scope: "col" }, title)))),
          h("tbody", {}, entries.map((entry) => h("tr", {},
            h("td", { class: "whitespace-nowrap text-muted" }, formatDateTime(entry.created_at, state.locale)),
            h("td", { class: "max-w-48 truncate" }, entry.actor_email ?? "System"),
            h("td", { class: "font-medium" }, actionLabel(entry.action)),
            h("td", { class: "text-muted" }, entry.entity_type === "item" && entry.entity_id
              ? h("a", { href: `#/items/${entry.entity_id}`, class: "hover:underline" }, entry.new_values?.clover?.name ?? entry.entity_id)
              // The log names no applicant. The link opens the application for those allowed to read it.
              : entry.entity_type === "application" && entry.entity_id && entry.action !== "APPLICATION_DELETED"
                ? h("a", { href: `#/applications/${entry.entity_id}`, class: "hover:underline" }, "Open application")
                : entry.entity_id ?? ""),
            h("td", {}, resultBadge(entry.result)),
            h("td", { class: "text-muted" }, entry.sync_status ?? "")))))),
      hasMore && h("div", { class: "mt-4 text-center" }, more));
  };

  async function load(before) {
    const data = await api("GET", `/activity${before ? `?before=${before}` : ""}`);
    entries.push(...data.entries);
    draw(data.entries.length === 30);
  }

  try {
    await load(null);
  } catch (failure) {
    clear(region);
    append(region, errorBlock(failure, () => { clear(outlet); activityView(outlet); }));
  }
}
