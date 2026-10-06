// Home page: shows the items the owner marked as featured in the dashboard. If none are
// marked, or the menu cannot be loaded, the section simply stays hidden.
import { fetchMenu, menuSettings } from "./lib/menu-api.js";
import { menuItemElement } from "./lib/menu-item.js";

const section = document.querySelector("[data-featured]");
const list = document.querySelector("[data-featured-list]");
const MAX_ITEMS = 6;

async function show() {
  const settings = menuSettings();
  const menu = await fetchMenu(settings.menuUrl);
  const seen = new Set();
  const featured = [];
  for (const category of menu.categories) {
    for (const item of category.items ?? []) {
      if (item.featured && item.available !== false && !seen.has(item.id)) {
        seen.add(item.id);
        featured.push(item);
      }
    }
  }
  if (featured.length === 0) return;
  for (const item of featured.slice(0, MAX_ITEMS)) {
    list.append(menuItemElement(item, { ...settings, showOptions: false }));
  }
  section.hidden = false;
}

if (section && list) show().catch(() => {});
