import { formatDateTime, timeAgo } from "../../js/lib/format.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { append, clear, errorBlock, h, loadingBlock, pageHeader } from "../ui.js";
import { actionLabel, resultBadge } from "./activity.js";
import { connectionBadge } from "./clover.js";

const stat = (label, value, href, note) =>
  h("a", { href, class: "d-card block p-4 sm:p-5" },
    h("p", { class: "d-section-title" }, label),
    h("p", { class: "mt-2 font-display text-[2.4rem] leading-none tabular-nums lining-nums" }, String(value)),
    note && h("p", { class: "mt-2 text-[0.8rem] text-muted" }, note));

export async function overviewView(outlet) {
  const body = h("div", {}, loadingBlock("Loading overview"));
  append(outlet, pageHeader({ title: "Overview" }), body);

  let data;
  try {
    data = await api("GET", "/overview");
  } catch (failure) {
    clear(body);
    append(body, errorBlock(failure, () => { clear(outlet); overviewView(outlet); }));
    return;
  }

  const { counts, connection } = data;
  clear(body);
  append(body, 
    !connection.connected && h("div", { class: "d-alert d-alert-warn mb-5 flex flex-wrap items-center justify-between gap-3" },
      h("p", {}, "Clover is not connected, so the menu cannot be imported or edited yet."),
      h("a", { href: "#/clover", class: "d-btn d-btn-sm" }, "Connect Clover")),
    connection.status === "needs_reauth" && h("div", { class: "d-alert d-alert-bad mb-5 flex flex-wrap items-center justify-between gap-3" },
      h("p", {}, "The Clover connection has expired. The website shows the last synced menu until you reconnect."),
      h("a", { href: "#/clover", class: "d-btn d-btn-sm" }, "Reconnect")),
    // Items imported from Clover start hidden: say so while the public menu is still empty.
    connection.connected && counts.items > 0 && counts.on_website === 0 && h("div", { class: "d-alert d-alert-info mb-5 flex flex-wrap items-center justify-between gap-3" },
      h("p", {}, "Your Clover items are imported, but none is shown on the website yet. Choose which ones customers should see."),
      h("a", { href: "#/items?visibility=hidden", class: "d-btn d-btn-sm" }, "Choose items")),

    h("div", { class: "grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6" },
      stat("Categories", data.categories, "#/categories"),
      stat("Items", counts.items, "#/items"),
      stat("On website", counts.on_website, "#/items?visibility=visible", "Visible to customers"),
      stat("Hidden", counts.hidden, "#/items?visibility=hidden"),
      stat("Out of stock", counts.unavailable, "#/items?availability=unavailable"),
      stat("Featured", counts.featured, "#/items?featured=true", "Shown on the home page")),

    h("div", { class: "mt-6 grid gap-5 lg:grid-cols-2" },
      h("section", { class: "d-card p-5 sm:p-6", "aria-labelledby": "ov-clover" },
        h("div", { class: "flex items-center justify-between gap-3" },
          h("h2", { id: "ov-clover", class: "d-title" }, "Clover"), connectionBadge(connection)),
        h("dl", { class: "d-facts mt-4 text-sm" },
          [["Merchant", connection.merchant_name ?? connection.merchant_id ?? "Not connected"],
           ["Last sync", connection.last_sync_finished_at ? `${timeAgo(connection.last_sync_finished_at)} (${formatDateTime(connection.last_sync_finished_at, state.locale)})` : "Never"],
           ["Last successful sync", connection.last_success_at ? timeAgo(connection.last_success_at) : "Never"],
          ].map(([term, value]) => h("div", {}, h("dt", {}, term), h("dd", {}, value)))),
        data.sync_errors.length > 0 && h("div", { class: "mt-4 border-t border-line pt-4" },
          h("h3", { class: "d-section-title" }, "Sync errors in the last 7 days"),
          h("ul", { class: "mt-2 space-y-1.5 text-sm" }, data.sync_errors.map((error) =>
            h("li", { class: "flex justify-between gap-3" },
              h("span", { class: "text-bad" }, error.error_code), h("span", { class: "text-muted" }, timeAgo(error.started_at)))))),
        h("a", { href: "#/clover", class: "d-btn d-btn-sm mt-5" }, "Manage connection")),

      h("section", { class: "d-card p-5 sm:p-6", "aria-labelledby": "ov-recent" },
        h("h2", { id: "ov-recent", class: "d-title" }, "Recently updated items"),
        data.recent_items.length === 0
          ? h("p", { class: "mt-4 text-sm text-muted" }, "No items yet.")
          : h("ul", { class: "mt-3 divide-y divide-line text-sm" }, data.recent_items.map((item) =>
              h("li", { class: "flex items-center justify-between gap-3 py-2.5" },
                h("a", { href: `#/items/${item.id}`, class: "truncate font-medium hover:text-brand hover:underline" }, item.name),
                h("span", { class: "shrink-0 text-muted" }, timeAgo(item.updated_at)))))),
    ),

    state.me.permissions.includes("activity.read") && h("section", { class: "d-card mt-5 p-5 sm:p-6", "aria-labelledby": "ov-activity" },
      h("div", { class: "flex items-center justify-between gap-3" },
        h("h2", { id: "ov-activity", class: "d-title" }, "Recent activity"),
        h("a", { href: "#/activity", class: "text-sm font-semibold text-brand hover:text-brand-dark hover:underline" }, "View all")),
      data.recent_activity.length === 0
        ? h("p", { class: "mt-4 text-sm text-muted" }, "Nothing has been changed yet.")
        : h("ul", { class: "mt-3 divide-y divide-line text-sm" }, data.recent_activity.map((entry) =>
            h("li", { class: "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5" },
              h("span", {}, actionLabel(entry.action), " ", resultBadge(entry.result)),
              h("span", { class: "text-muted" }, `${entry.actor_email ?? "System"}, ${timeAgo(entry.created_at)}`))))),
  );
}
