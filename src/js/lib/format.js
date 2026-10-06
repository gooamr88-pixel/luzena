// Money and date formatting shared by the public site and the dashboard.

export function formatPrice(cents, currency = "USD", locale = "en-US") {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

// What to print next to an item. Clover's VARIABLE price type means the price is entered at
// the register, so there is no price to show.
export function priceLabel(item, currency, locale) {
  if (item.price_type === "VARIABLE" || item.price_cents === null || item.price_cents === undefined) return "";
  const price = formatPrice(item.price_cents, currency, locale);
  return item.price_type === "PER_UNIT" && item.unit_name ? `${price} / ${item.unit_name}` : price;
}

// "12.50" -> 1250. Returns null for anything that is not a plain non-negative amount with
// at most two decimals. No floating point arithmetic on money.
export function parsePriceToCents(text) {
  const match = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*$/.exec(String(text));
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export const centsToInput = (cents) => (typeof cents === "number" ? (cents / 100).toFixed(2) : "");

export function formatDateTime(value, locale = "en-US") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function timeAgo(value, now = Date.now()) {
  if (!value) return "never";
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const units = [[60, "minute"], [3600, "hour"], [86400, "day"]];
  let label = "";
  for (const [size, name] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      label = `${count} ${name}${count === 1 ? "" : "s"} ago`;
    }
  }
  return label;
}

const DIETARY_LABELS = {
  vegetarian: "Vegetarian", vegan: "Vegan", "gluten-free": "Gluten-free", "dairy-free": "Dairy-free",
  "nut-free": "Nut-free", halal: "Halal", spicy: "Spicy",
};
export const dietaryLabel = (tag) => DIETARY_LABELS[tag] ?? tag;
