// The Menu page: loads the menu, renders it, and handles loading and failure.
import { clear, h } from "./lib/dom.js";
import { formatDateTime } from "./lib/format.js";
import { fetchMenu, menuSettings } from "./lib/menu-api.js";
import { menuItemElement } from "./lib/menu-item.js";

const root = document.querySelector("[data-menu]");
const nav = document.querySelector("[data-menu-nav]");
const navList = document.querySelector("[data-menu-nav-list]");
const errorTemplate = document.querySelector("[data-menu-error-template]");
const loadingMarkup = root.querySelector("[data-menu-loading]");
const settings = menuSettings();

// A menu older than this is still shown, with a note saying when it was last updated.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function showError() {
  nav.hidden = true;
  clear(root);
  root.append(errorTemplate.content.cloneNode(true));
  root.setAttribute("aria-busy", "false");
  root.querySelector("[data-menu-retry]").addEventListener("click", load);
}

function render(menu) {
  const categories = menu.categories.filter((category) => category.items?.length > 0);
  if (categories.length === 0) return showError();

  clear(navList);
  for (const category of categories) {
    navList.append(h("li", {}, h("a", { class: "chip", href: `#menu-${category.id}` }, category.name)));
  }
  nav.hidden = categories.length < 2;

  clear(root);
  const stale = menu.synced_at && Date.now() - new Date(menu.synced_at).getTime() > STALE_AFTER_MS;
  if (stale) {
    root.append(h("p", { class: "mb-10 text-sm text-muted" },
      `Last updated ${formatDateTime(menu.synced_at, settings.locale)}. Prices and availability may have changed.`));
  }
  categories.forEach((category, index) => {
    root.append(h("section", {
      id: `menu-${category.id}`, "aria-labelledby": `menu-title-${category.id}`,
      class: index === 0 ? "" : "mt-16 sm:mt-20",
    },
      h("h2", { id: `menu-title-${category.id}`, class: "h-section" }, category.name),
      h("div", { class: "rule mt-5" }),
      h("ul", { class: "mt-4 grid gap-x-14 divide-y divide-ink/10 md:grid-cols-2 md:divide-y-0" },
        category.items.map((item) => menuItemElement(item, settings))),
    ));
  });
  root.setAttribute("aria-busy", "false");
  trackCurrentCategory(categories);
  // A link from the home page names a category (/menu/#menu-ID). The category did not exist
  // when the page opened, so the browser could not go to it; go there now.
  if (location.hash.startsWith("#menu-")) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}

// Marks the chip of the category being read, and keeps that chip in view.
function trackCurrentCategory(categories) {
  if (!("IntersectionObserver" in window) || categories.length < 2) return;
  const chips = new Map([...navList.querySelectorAll("a")].map((chip) => [chip.getAttribute("href").slice(1), chip]));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const chip of chips.values()) chip.removeAttribute("aria-current");
      const chip = chips.get(entry.target.id);
      if (!chip) continue;
      chip.setAttribute("aria-current", "true");
      // Only the row of chips moves. scrollIntoView would also start a scroll on the page
      // itself, and that cancels the smooth scroll a press on a chip has just begun, leaving
      // the reader at whichever category happened to be passing.
      const row = navList.getBoundingClientRect();
      const box = chip.getBoundingClientRect();
      navList.scrollBy({ left: box.left + box.width / 2 - (row.left + row.width / 2) });
    }
  }, { rootMargin: "-30% 0px -60% 0px" });
  for (const id of chips.keys()) observer.observe(document.getElementById(id));
}

async function load() {
  clear(root);
  root.append(loadingMarkup);
  root.setAttribute("aria-busy", "true");
  try {
    render(await fetchMenu(settings.menuUrl));
  } catch {
    showError();
  }
}

load();
