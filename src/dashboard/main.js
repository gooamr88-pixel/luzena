// Dashboard entry point: session, shell, and routing.
import { createClient } from "@supabase/supabase-js";
import { api, ApiFailure, explain } from "./api.js";
import { state } from "./state.js";
import { append, clear, h, icon, loadingBlock, stateBlock, toast } from "./ui.js";
import { activityView } from "./views/activity.js";
import { applicationDetailView, applicationsView } from "./views/applications.js";
import { categoriesView } from "./views/categories.js";
import { categoryOrderView } from "./views/category-order.js";
import { cloverView, completeCloverReturn } from "./views/clover.js";
import { itemEditorView } from "./views/item-editor.js";
import { itemsView } from "./views/items.js";
import { labelsView } from "./views/labels.js";
import { loginView, secondStepView, setPasswordView } from "./views/login.js";
import { modifiersView } from "./views/modifiers.js";
import { overviewView } from "./views/overview.js";
import { photosView } from "./views/photos.js";
import { securityView } from "./views/security.js";

const app = document.getElementById("app");
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const NAV = [
  { href: "#/", label: "Overview", icon: "overview", match: /^#\/$/ },
  { href: "#/items", label: "Items", icon: "items", match: /^#\/items/ },
  { href: "#/categories", label: "Categories", icon: "categories", match: /^#\/categories/ },
  { href: "#/modifiers", label: "Modifiers", icon: "modifiers", match: /^#\/modifiers/ },
  { href: "#/labels", label: "Labels", icon: "tag", match: /^#\/labels/ },
  { href: "#/photos", label: "Photos", icon: "image", match: /^#\/photos/, permission: "site.manage" },
  { href: "#/applications", label: "Applications", icon: "applications", match: /^#\/applications/, permission: "applications.read", count: true },
  { href: "#/clover", label: "Clover", icon: "clover", match: /^#\/clover/ },
  { href: "#/activity", label: "Activity", icon: "activity", match: /^#\/activity/, permission: "activity.read" },
  { href: "#/security", label: "Security", icon: "lock", match: /^#\/security/ },
];

const ROUTES = [
  { pattern: /^#\/$/, view: overviewView },
  { pattern: /^#\/items$/, view: itemsView },
  { pattern: /^#\/items\/new$/, view: (outlet, _, query) => itemEditorView(outlet, null, query.get("from")) },
  { pattern: /^#\/items\/([A-Z0-9]{13})$/, view: (outlet, match) => itemEditorView(outlet, match[1], null) },
  { pattern: /^#\/categories$/, view: categoriesView },
  { pattern: /^#\/categories\/([A-Z0-9]{13})\/items$/, view: categoryOrderView },
  { pattern: /^#\/modifiers$/, view: modifiersView },
  { pattern: /^#\/labels$/, view: labelsView },
  { pattern: /^#\/photos$/, view: photosView },
  { pattern: /^#\/applications$/, view: applicationsView },
  { pattern: /^#\/applications\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, view: applicationDetailView },
  { pattern: /^#\/clover$/, view: cloverView },
  { pattern: /^#\/activity$/, view: activityView },
  { pattern: /^#\/security$/, view: securityView },
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
      icon(entry.icon), entry.label,
      // How many job applications nobody has looked at yet. Filled in by showNewApplications.
      entry.count && h("span", { class: "d-nav-count", dataset: { newApplications: "" }, hidden: true })))));
}

// Puts the number of new applications beside "Applications" in the sidebar and the drawer.
// Given no number, it asks the server. A failure only leaves the number out.
async function showNewApplications(count) {
  if (!state.me?.permissions.includes("applications.read")) return;
  let total = count;
  if (typeof total !== "number") {
    try {
      total = (await api("GET", "/applications/summary")).new;
    } catch {
      return;
    }
  }
  for (const node of document.querySelectorAll("[data-new-applications]")) {
    clear(node);
    node.hidden = !(total > 0);
    if (total > 0) append(node, String(total), h("span", { class: "sr-only" }, total === 1 ? " new application" : " new applications"));
  }
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
  // The site's logo when there is one; the restaurant's name otherwise. On the dark sidebar
  // and drawer the logo is shown in white, as in the public site's header.
  const logo = document.documentElement.dataset.logo;
  const brand = (size) => (logo
    ? h("img", { src: logo, alt: state.me.restaurant.name, class: `d-logo-light w-auto self-start ${size}` })
    : h("p", { class: "truncate font-display text-2xl" }, state.me.restaurant.name));
  const websiteLink = () => h("a", { href: "/", target: "_blank", rel: "noopener", class: "d-nav-link" }, icon("external"), "View website");

  const drawer = h("dialog", { class: "d-drawer d-dark", "aria-label": "Navigation" },
    h("div", { class: "d-sidebar flex h-full flex-col px-4 py-5" },
      h("div", { class: "mb-6 flex items-center justify-between gap-3 pl-3" },
        brand("h-10"),
        h("button", { type: "button", class: "d-icon-btn", "aria-label": "Close navigation", onClick: () => drawer.close() }, icon("close"))),
      h("nav", { "aria-label": "Dashboard" }, navLinks(() => drawer.close())),
      h("div", { class: "mt-auto border-t border-line pt-4" }, websiteLink())));

  const signOut = async () => {
    if (state.leaveGuard && !(await state.leaveGuard())) return;
    state.leaveGuard = null;
    await state.supabase.auth.signOut();
  };

  // Focus moves here after each navigation so screen readers start at the new page. It is
  // a container, not a control, so it shows no focus ring.
  outlet = h("main", { id: "main", class: "mx-auto w-full max-w-6xl px-4 py-7 outline-none sm:px-6 sm:py-9 lg:px-8", tabindex: "-1" });
  const email = state.me.user.email ?? "";
  clear(app);
  append(app,
    h("a", { href: "#main", class: "sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-gold focus:px-3 focus:py-2 focus:font-semibold focus:text-night" }, "Skip to content"),
    h("div", { class: "flex min-h-dvh" },
      h("aside", { class: "d-sidebar d-dark sticky top-0 hidden h-dvh w-60 shrink-0 flex-col px-3 py-6 lg:flex" },
        h("div", { class: "px-3" }, brand("h-12")),
        h("p", { class: "d-section-title mt-4 mb-6 px-3" }, "Dashboard"),
        h("nav", { "aria-label": "Dashboard" }, navLinks()),
        h("div", { class: "mt-auto border-t border-line pt-4" }, websiteLink())),
      h("div", { class: "flex min-w-0 flex-1 flex-col" },
        h("header", { class: "d-topbar" },
          h("button", { type: "button", class: "d-icon-btn -ml-2 lg:hidden", "aria-label": "Open navigation", onClick: () => drawer.showModal() }, icon("menu")),
          h("p", { class: "truncate font-display text-[1.2rem] lg:hidden" }, state.me.restaurant.name),
          h("div", { class: "ml-auto flex items-center gap-3" },
            // The account that is signed in: its initial in a ring, then the address.
            email && h("span", { class: "hidden size-8 shrink-0 items-center justify-center rounded-full border border-brand/35 text-[0.8rem] font-semibold text-brand uppercase sm:flex", "aria-hidden": "true" }, email[0]),
            h("span", { class: "hidden max-w-56 truncate text-sm text-muted sm:block", title: email }, email),
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

// Whether this session still owes the second step of signing in: the account has two-step
// sign-in on and only the password has been given. Asked of Supabase Auth. If the question
// cannot be answered the dashboard goes on, and the backend, which checks the same thing
// on every request, refuses the session and brings the owner to the code step that way.
async function owesSecondStep() {
  try {
    const { data, error } = await state.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return !error && data.nextLevel === "aal2" && data.currentLevel !== "aal2";
  } catch {
    return false;
  }
}

async function startSession() {
  clear(app);
  append(app, h("div", { class: "mx-auto max-w-3xl p-6" }, loadingBlock("Loading your restaurant")));
  if (await owesSecondStep()) return secondStepView(app, startSession);
  try {
    state.me = await api("GET", "/me");
  } catch (failure) {
    // The backend says the same thing in its own words.
    if (failure instanceof ApiFailure && failure.code === "mfa_required") return secondStepView(app, startSession);
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
  showNewApplications();

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
        // Supabase Auth lets an account with two-step sign-in on change its password only
        // from a session that has given the code. So the code is asked for first; an owner
        // who has lost the phone as well needs the factor removed in Supabase (CONFIGURATION.md).
        return owesSecondStep().then((owed) => (owed ? secondStepView(app, async () => setPasswordView(app)) : setPasswordView(app)));
      }
      if (!session) {
        // Said only when the password was in fact changed, not on any sign-out during a reset.
        const changed = state.passwordChanged;
        state.passwordChanged = false;
        recovering = false;
        signedInUser = null;
        state.me = null;
        state.leaveGuard = null;
        return loginView(app, changed ? "Your password has been changed. Sign in with the new password." : undefined);
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
  window.addEventListener("applications-changed", (event) => { if (state.me) showNewApplications(event.detail); });
  window.addEventListener("beforeunload", (event) => {
    if (state.leaveGuard) event.preventDefault();
  });
  window.addEventListener("offline", () => toast("You are offline. Changes cannot be saved until you reconnect.", "warn"));
  window.addEventListener("online", () => toast("You are back online."));
}

boot();
