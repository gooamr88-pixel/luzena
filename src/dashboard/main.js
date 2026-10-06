// Dashboard entry point: session, shell, and routing.
import { createClient } from "@supabase/supabase-js";
import { api, ApiFailure, explain } from "./api.js";
import { state } from "./state.js";
import { append, clear, h, icon, loadingBlock, stateBlock, toast } from "./ui.js";
import { activityView } from "./views/activity.js";
import { categoriesView } from "./views/categories.js";
import { cloverView, completeCloverReturn } from "./views/clover.js";
import { itemEditorView } from "./views/item-editor.js";
import { itemsView } from "./views/items.js";
import { loginView, setPasswordView } from "./views/login.js";
import { modifiersView } from "./views/modifiers.js";
import { overviewView } from "./views/overview.js";

const app = document.getElementById("app");
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const NAV = [
  { href: "#/", label: "Overview", icon: "overview", match: /^#\/$/ },
  { href: "#/items", label: "Items", icon: "items", match: /^#\/items/ },
  { href: "#/categories", label: "Categories", icon: "categories", match: /^#\/categories/ },
  { href: "#/modifiers", label: "Modifiers", icon: "modifiers", match: /^#\/modifiers/ },
  { href: "#/clover", label: "Clover", icon: "clover", match: /^#\/clover/ },
  { href: "#/activity", label: "Activity", icon: "activity", match: /^#\/activity/, permission: "activity.read" },
];

const ROUTES = [
  { pattern: /^#\/$/, view: overviewView },
  { pattern: /^#\/items$/, view: itemsView },
  { pattern: /^#\/items\/new$/, view: (outlet, _, query) => itemEditorView(outlet, null, query.get("from")) },
  { pattern: /^#\/items\/([A-Z0-9]{13})$/, view: (outlet, match) => itemEditorView(outlet, match[1], null) },
  { pattern: /^#\/categories$/, view: categoriesView },
  { pattern: /^#\/modifiers$/, view: modifiersView },
  { pattern: /^#\/clover$/, view: cloverView },
  { pattern: /^#\/activity$/, view: activityView },
];

let outlet = null;
let currentHash = "";
let pendingCloverMessage = null;
// True while the owner is setting a new password from a reset link. The link signs them
// in, but the dashboard must not open until the password is set.
let recovering = false;

function navLinks(onNavigate) {
  return h("ul", { class: "space-y-1" }, NAV
    .filter((entry) => !entry.permission || state.me.permissions.includes(entry.permission))
    .map((entry) => h("li", {}, h("a", { href: entry.href, class: "d-nav-link", dataset: { nav: entry.href }, onClick: onNavigate },
      icon(entry.icon), entry.label))));
}

function markCurrentNav() {
  const hash = location.hash || "#/";
  for (const link of document.querySelectorAll("[data-nav]")) {
    const entry = NAV.find((item) => item.href === link.dataset.nav);
    if (entry.match.test(hash)) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function renderShell() {
  const drawer = h("dialog", { class: "d-drawer", "aria-label": "Navigation" },
    h("div", { class: "flex h-full flex-col p-4" },
      h("div", { class: "mb-4 flex items-center justify-between" },
        h("p", { class: "font-semibold" }, state.me.restaurant.name),
        h("button", { type: "button", class: "d-icon-btn", "aria-label": "Close navigation", onClick: () => drawer.close() }, icon("close"))),
      h("nav", { "aria-label": "Dashboard" }, navLinks(() => drawer.close()))));

  const signOut = async () => {
    if (state.leaveGuard && !(await state.leaveGuard())) return;
    state.leaveGuard = null;
    await state.supabase.auth.signOut();
  };

  // Focus moves here after each navigation so screen readers start at the new page. It is
  // a container, not a control, so it shows no focus ring.
  outlet = h("main", { id: "main", class: "mx-auto w-full max-w-6xl px-4 py-6 outline-none sm:px-6 lg:px-8", tabindex: "-1" });
  clear(app);
  append(app, 
    h("a", { href: "#main", class: "sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-text focus:px-3 focus:py-2 focus:text-white" }, "Skip to content"),
    h("div", { class: "flex min-h-dvh" },
      h("aside", { class: "sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface p-4 lg:flex" },
        // The site's logo when there is one; the restaurant's name otherwise.
        document.documentElement.dataset.logo
          ? h("img", { src: document.documentElement.dataset.logo, alt: state.me.restaurant.name, class: "mx-3 mb-2 h-12 w-auto self-start" })
          : h("p", { class: "truncate px-3 text-lg font-semibold" }, state.me.restaurant.name),
        h("p", { class: "mb-5 px-3 text-[0.7rem] font-semibold tracking-widest text-muted uppercase" }, "Dashboard"),
        h("nav", { "aria-label": "Dashboard" }, navLinks()),
        h("div", { class: "mt-auto border-t border-line pt-3" },
          h("a", { href: "/", target: "_blank", rel: "noopener", class: "d-nav-link" }, icon("external"), "View website"))),
      h("div", { class: "flex min-w-0 flex-1 flex-col" },
        h("header", { class: "sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 sm:px-6" },
          h("button", { type: "button", class: "d-icon-btn lg:hidden", "aria-label": "Open navigation", onClick: () => drawer.showModal() }, icon("menu")),
          h("p", { class: "truncate font-semibold lg:hidden" }, state.me.restaurant.name),
          h("div", { class: "ml-auto flex items-center gap-3" },
            h("span", { class: "hidden max-w-56 truncate text-sm text-muted sm:block", title: state.me.user.email ?? "" }, state.me.user.email ?? ""),
            h("button", { type: "button", class: "d-btn d-btn-sm", onClick: signOut }, "Sign out"))),
        state.demo && h("p", { class: "border-b border-warn/30 bg-warn-bg px-4 py-2 text-center text-sm font-medium text-warn sm:px-6" },
          "Demo mode. Sample data only: not connected to Clover or a database, and nothing is saved."),
        outlet)),
    drawer,
  );
}

async function route() {
  const hash = location.hash.startsWith("#/") ? location.hash : "#/";
  const [path, queryString = ""] = hash.split("?");

  // A view with unsaved edits gets to veto leaving.
  if (state.leaveGuard && hash !== currentHash) {
    if (!(await state.leaveGuard())) {
      history.replaceState(null, "", currentHash);
      return;
    }
    state.leaveGuard = null;
  }
  currentHash = hash;
  markCurrentNav();

  const found = ROUTES.map((entry) => ({ entry, match: path.match(entry.pattern) })).find((candidate) => candidate.match);
  clear(outlet);
  if (!found) {
    append(outlet, stateBlock({ title: "Page not found", action: h("a", { href: "#/", class: "d-btn" }, "Go to overview") }));
    return;
  }
  await found.entry.view(outlet, found.match, new URLSearchParams(queryString));
  // A view that put focus on one of its own fields (the name of a new item) keeps it.
  if (!outlet.contains(document.activeElement)) outlet.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

async function startSession() {
  clear(app);
  append(app, h("div", { class: "mx-auto max-w-3xl p-6" }, loadingBlock("Loading your restaurant")));
  try {
    state.me = await api("GET", "/me");
  } catch (failure) {
    clear(app);
    const signOut = h("button", { type: "button", class: "d-btn", onClick: () => state.supabase.auth.signOut() }, "Sign out");
    if (failure instanceof ApiFailure && failure.status === 401) return;
    append(app, h("div", { class: "mx-auto max-w-xl p-6" }, stateBlock({
      tone: "bad",
      title: failure.code === "no_restaurant" ? "No restaurant is linked to this account" : "The dashboard could not be loaded",
      body: failure.code === "no_restaurant" ? "Ask the site administrator to give this account access." : explain(failure),
      action: [h("button", { type: "button", class: "d-btn d-btn-primary", onClick: startSession }, "Try again"), signOut],
    })));
    return;
  }
  if (recovering) return;

  renderShell();

  // Returning from Clover's authorisation page: ?code=...&merchant_id=...
  const returned = new URLSearchParams(location.search);
  if (returned.has("code") && returned.has("merchant_id")) {
    pendingCloverMessage = await completeCloverReturn(returned);
    history.replaceState(null, "", `${location.pathname}#/clover`);
  }
  await route();
  if (pendingCloverMessage) {
    toast(pendingCloverMessage.text, pendingCloverMessage.tone);
    pendingCloverMessage = null;
  }
}

async function boot() {
  state.apiBase = document.documentElement.dataset.api ?? "";
  // The whole branch, and demo.js with it, is removed from the bundle unless the build
  // sets VITE_DASHBOARD_DEMO=1, which is only allowed for the sample profile.
  if (import.meta.env.VITE_DASHBOARD_DEMO === "1") {
    const { installDemo } = await import("./demo.js");
    installDemo(state);
  } else if (!supabaseUrl || !supabaseKey || !state.apiBase) {
    clear(app);
    append(app, h("div", { class: "mx-auto max-w-xl p-6" }, stateBlock({
      tone: "bad",
      title: "The dashboard is not configured",
      body: "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set when the site is built. See DEPLOYMENT.md.",
    })));
    return;
  } else {
    state.storageBase = `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/menu-images`;
    state.supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }

  let signedInUser = null;
  state.supabase.auth.onAuthStateChange((event, session) => {
    // Supabase calls this inside its own lock; defer our work so we never call back into
    // the client from within it.
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY") {
        recovering = true;
        signedInUser = null;
        state.me = null;
        return setPasswordView(app);
      }
      if (!session) {
        const wasRecovering = recovering;
        recovering = false;
        signedInUser = null;
        state.me = null;
        state.leaveGuard = null;
        return loginView(app, wasRecovering ? "Your password has been changed. Sign in with the new password." : undefined);
      }
      if (recovering) return;
      // Token refreshes fire this event too; only a different user restarts the app.
      if (session.user.id !== signedInUser) {
        signedInUser = session.user.id;
        startSession();
      }
    }, 0);
  });

  window.addEventListener("hashchange", () => { if (state.me) route(); });
  window.addEventListener("beforeunload", (event) => {
    if (state.leaveGuard) event.preventDefault();
  });
  window.addEventListener("offline", () => toast("You are offline. Changes cannot be saved until you reconnect.", "warn"));
  window.addEventListener("online", () => toast("You are back online."));
}

boot();
