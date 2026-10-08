// Home page: the menu's categories, and the dishes the owner marked as featured in the
// dashboard. Both come from the live menu. A section with nothing to show, or the whole
// pair when the menu cannot be loaded, simply stays hidden.
//
// The markup of a tile and of a card lives in the page, in <template> elements; this file
// only fills in the text, the link and the photo, so nothing from the API becomes markup.
import { priceLabel } from "./lib/format.js";
import { MAX_HOME_CATEGORIES } from "./lib/home.js";
import { fetchMenu, menuSettings } from "./lib/menu-api.js";

const MAX_DISHES = 4;

// Photos for a category or a dish that has none of its own (`defaultDishPhotos` in the
// content file). The build writes their addresses on <main>. The list may be empty.
const DEFAULT_PHOTOS = (document.querySelector("[data-default-photos]")?.dataset.defaultPhotos ?? "").split(/\s+/).filter(Boolean);
const defaultPhoto = (index) => (DEFAULT_PHOTOS.length > 0 ? DEFAULT_PHOTOS[index % DEFAULT_PHOTOS.length] : null);

const part = (root, name) => root.querySelector(`[data-${name}]`);
const menuLink = (category) => `/menu/#menu-${encodeURIComponent(category.id)}`;

// Fills a text slot, or removes it when there is nothing to put in it.
function setText(root, name, text) {
  const node = part(root, name);
  if (text) node.textContent = text;
  else node.remove();
}

// Shows the first photo in `urls` that loads: the item's own, then a default one. When none
// is given or none loads it calls `plain`, so a deleted or unreachable photo never leaves a
// broken image on the home page.
function setPhoto(image, urls, plain) {
  const queue = urls.filter(Boolean);
  const next = () => {
    if (queue.length === 0) return plain();
    image.src = queue.shift();
  };
  image.addEventListener("error", next);
  next();
}

function categoryTile(template, category, index) {
  const tile = template.content.cloneNode(true);
  part(tile, "link").href = menuLink(category);
  part(tile, "name").textContent = category.name;
  part(tile, "count").textContent = `${category.items.length} ${category.items.length === 1 ? "item" : "items"}`;
  // The photo the owner chose for the category in the dashboard comes first. Without one a
  // category borrows the photo of one of its dishes, then a default photo. With none of
  // these it is a green tile with the logo's leaf.
  const image = part(tile, "photo");
  const scrim = part(tile, "scrim");
  const leaf = part(tile, "leaf");
  leaf.hidden = true;
  setPhoto(image, [category.image_url, category.items.find((item) => item.image_url)?.image_url, defaultPhoto(index)], () => {
    image.remove();
    scrim.remove();
    leaf.hidden = false;
  });
  return tile;
}

function dishCard(template, { item, category }, index, settings, withPhotos) {
  const card = template.content.cloneNode(true);
  part(card, "link").href = menuLink(category);
  part(card, "name").textContent = item.name;
  setText(card, "description", item.description);
  setText(card, "price", priceLabel(item, settings.currency, settings.locale));
  // Photos are all or nothing, so the cards in a row stay the same shape: text-only cards
  // when no card has a photo to show, and the leaf for a card whose photo is missing.
  if (!withPhotos) {
    part(card, "media").remove();
    return card;
  }
  const image = part(card, "photo");
  const leaf = part(card, "leaf");
  leaf.hidden = true;
  // The cards start half-way round the default photos, so the first row of cards does not
  // repeat the first tiles above it.
  setPhoto(image, [item.image_url, defaultPhoto(index + Math.ceil(DEFAULT_PHOTOS.length / 2))], () => {
    image.remove();
    leaf.hidden = false;
  });
  return card;
}

function showCategories(categories) {
  const section = document.querySelector("[data-categories]");
  const template = document.querySelector("[data-category-template]");
  // A single category is not a choice; the menu page covers it.
  if (!section || !template || categories.length < 2) return;
  part(section, "categories-list").append(...categories.slice(0, MAX_HOME_CATEGORIES).map((category, index) => categoryTile(template, category, index)));
  section.hidden = false;
}

function showFeatured(categories, settings) {
  const section = document.querySelector("[data-featured]");
  const template = document.querySelector("[data-dish-template]");
  if (!section || !template) return;
  const seen = new Set();
  const featured = [];
  for (const category of categories) {
    for (const item of category.items) {
      if (item.featured && item.available !== false && !seen.has(item.id)) {
        seen.add(item.id);
        featured.push({ item, category });
      }
    }
  }
  if (featured.length === 0) return;
  const shown = featured.slice(0, MAX_DISHES);
  const withPhotos = DEFAULT_PHOTOS.length > 0 || shown.some(({ item }) => item.image_url);
  part(section, "featured-list").append(...shown.map((entry, index) => dishCard(template, entry, index, settings, withPhotos)));
  section.hidden = false;
}

async function show() {
  const settings = menuSettings();
  const menu = await fetchMenu(settings.menuUrl);
  const categories = menu.categories.filter((category) => category.items?.length > 0);
  showCategories(categories);
  showFeatured(categories, settings);
}

show().catch(() => {});
