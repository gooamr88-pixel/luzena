// Loads, validates and enriches the site content.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const contentPaths = (profile) => ({
  file: resolve(ROOT, "content", profile === "sample" ? "site.sample.json" : "site.json"),
  media: resolve(ROOT, "content", profile === "sample" ? "sample-media" : "media"),
});

// Sunday first: the restaurant is in the United States.
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const filled = (value) => typeof value === "string" && value.trim() !== "";

export function formatTime(time) {
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${display} ${suffix}` : `${display}:${String(minute).padStart(2, "0")} ${suffix}`;
}

// ["Sunday","Monday","Tuesday"] -> "Sun – Tue"; non-consecutive days are listed; all seven
// days read "Every day".
export function formatDays(days) {
  const indexes = [...new Set(days.map((day) => DAYS.indexOf(day)))].sort((a, b) => a - b);
  if (indexes.length === DAYS.length) return "Every day";
  const short = (index) => DAYS[index].slice(0, 3);
  const runs = [];
  for (const index of indexes) {
    const last = runs[runs.length - 1];
    if (last && index === last[1] + 1) last[1] = index;
    else runs.push([index, index]);
  }
  return runs.map(([from, to]) => (from === to ? short(from) : `${short(from)} – ${short(to)}`)).join(", ");
}

const range = (slot) => `${formatTime(slot.opens)} – ${formatTime(slot.closes)}`;

// One line per day of the week, so a visitor can find today without decoding ranges.
export function hoursByDay(hours) {
  return DAYS.map((day) => {
    const entry = hours.find((slot) => slot.days.includes(day));
    return { day, time: entry ? range(entry) : "Closed" };
  });
}

export const telHref = (phone) => `tel:${phone.replace(/[^\d+]/g, "")}`;

// Hosts that can only be placeholders. A production build refuses them for any link a
// customer would follow, so a sample or made-up address can never be published.
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$|\.(test|invalid|example|local)$|^localhost$|^127\.|sample|placeholder/i;

export function isPlaceholderUrl(url) {
  try {
    return PLACEHOLDER_HOST.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

const validSlot = (slot) =>
  Array.isArray(slot?.days) && slot.days.length > 0 && slot.days.every((day) => DAYS.includes(day)) &&
  TIME.test(slot.opens ?? "") && TIME.test(slot.closes ?? "");

const hasPrivacyPolicy = (site) =>
  filled(site.legal?.privacyPolicyUrl) || (site.legal?.privacy?.sections ?? []).length > 0;

// Returns { errors, warnings }. Errors block a production build; warnings are features
// that will be absent from the site until the content is supplied.
export function validateContent(site, mediaDir, { profile = "production" } = {}) {
  const errors = [];
  const warnings = [];
  const production = profile === "production";
  const image = (name, label, level = errors) => {
    if (!filled(name)) return level.push(`${label} is missing`);
    if (!existsSync(resolve(mediaDir, name))) errors.push(`${label}: file "${name}" not found in ${mediaDir}`);
  };

  if (!filled(site.name)) errors.push("name is missing");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site.siteUrl ?? "")) {
    errors.push("siteUrl must be a lowercase https origin without a trailing slash");
  } else if (production && isPlaceholderUrl(site.siteUrl)) {
    errors.push("siteUrl is a placeholder address");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/.test(site.restaurantSlug ?? "")) errors.push("restaurantSlug is missing or invalid");
  if (!filled(site.description)) errors.push("description is missing (used for search results and link previews)");
  else if (site.description.length > 170) warnings.push("description is longer than 170 characters and will be cut off in search results");

  if (!filled(site.hero?.headline)) errors.push("hero.headline is missing");
  // Without a hero photo the home page uses a text-only hero, so this is not a blocker.
  if (!filled(site.hero?.image)) warnings.push("hero.image is missing: the home page opens with a text-only hero instead of a photo");
  else image(site.hero.image, "hero.image");
  if (filled(site.hero?.image) && !filled(site.hero?.imageAlt)) errors.push("hero.imageAlt is missing (needed for screen readers)");

  if (!Array.isArray(site.about?.paragraphs) || site.about.paragraphs.length === 0) errors.push("about.paragraphs is empty (the restaurant's story)");
  image(site.about?.image, "about.image", warnings);

  if (!Array.isArray(site.locations) || site.locations.length === 0) {
    // A restaurant that has not opened yet can still publish its site, so a missing
    // location is a warning. A location that IS listed must be complete: errors below.
    warnings.push("locations is empty: the site says \"address and hours coming soon\" and search engines get no address, phone or opening hours");
  } else {
    site.locations.forEach((location, index) => {
      const at = `locations[${index}]`;
      for (const field of ["street", "city", "phone"]) {
        if (!filled(location[field])) errors.push(`${at}.${field} is missing`);
      }
      if (!Array.isArray(location.hours) || location.hours.length === 0) {
        errors.push(`${at}.hours is empty`);
      } else {
        for (const slot of location.hours) {
          if (!validSlot(slot)) errors.push(`${at}.hours has an invalid entry: ${JSON.stringify(slot)}`);
        }
      }
      for (const service of location.services ?? []) {
        if (!filled(service.name) || !validSlot(service)) errors.push(`${at}.services has an invalid entry: ${JSON.stringify(service)}`);
      }
      if (filled(location.mapsUrl)) {
        if (!/^https:\/\//.test(location.mapsUrl)) errors.push(`${at}.mapsUrl must start with https://`);
        else if (production && isPlaceholderUrl(location.mapsUrl)) errors.push(`${at}.mapsUrl is a placeholder address`);
      }
      if (!location.geo) warnings.push(`${at}.geo is missing (latitude/longitude help local search)`);
      if (filled(location.image)) image(location.image, `${at}.image`);
    });
  }

  // ORDER ONLINE. One value: ordering.url, which the CLOVER_ORDERING_URL build variable
  // overrides. See docs/CONFIGURATION.md.
  if (!filled(site.ordering?.url)) {
    warnings.push("ordering.url is not set: ORDER ONLINE leads to the on-site \"ordering opens soon\" page instead of Clover");
  } else if (!/^https:\/\//.test(site.ordering.url)) {
    errors.push("ordering.url must start with https://");
  } else if (production && isPlaceholderUrl(site.ordering.url)) {
    errors.push(`ordering.url is a placeholder address (${site.ordering.url}); set the restaurant's real Clover ordering link or leave it empty`);
  } else if (production && !/(^|\.)clover\.com$/i.test(new URL(site.ordering.url).hostname)) {
    warnings.push(`ordering.url does not point to clover.com (${new URL(site.ordering.url).hostname}); check that it is the restaurant's own ordering page`);
  }

  if (!filled(site.logo)) warnings.push("logo is missing: the restaurant name is shown as text instead");
  else image(site.logo, "logo");
  if (!filled(site.ogImage)) warnings.push("ogImage is missing: shared links use a preview image made from the logo instead of a photo");
  else image(site.ogImage, "ogImage");
  for (const [network, url] of Object.entries(site.social ?? {})) {
    if (!filled(url)) continue;
    if (!/^https:\/\//.test(url)) errors.push(`social.${network} must start with https://`);
    else if (production && isPlaceholderUrl(url)) errors.push(`social.${network} is a placeholder address`);
  }
  if (!Object.values(site.social ?? {}).some(filled)) warnings.push("social links are missing");

  if (!Array.isArray(site.gallery) || site.gallery.length === 0) {
    warnings.push("gallery is empty: the Gallery link is left out of the navigation and the page is hidden from search engines");
  } else {
    site.gallery.forEach((entry, index) => {
      image(entry.image, `gallery[${index}].image`);
      if (!filled(entry.alt)) errors.push(`gallery[${index}].alt is missing (needed for screen readers)`);
    });
  }

  const positions = site.careers?.positions ?? [];
  if (positions.length === 0) warnings.push("careers.positions is empty");
  positions.forEach((position, index) => {
    if (!filled(position.title) || !/^[a-z0-9-]+$/.test(position.slug ?? "")) errors.push(`careers.positions[${index}] needs a title and a slug`);
    if (!filled(position.summary)) warnings.push(`careers.positions[${index}] (${position.title}) has no description, responsibilities or requirements yet`);
  });
  if (positions.length > 0 && positions.every((position) => !filled(position.type))) {
    warnings.push("careers.positions: no position says whether it is full-time or part-time (`type`)");
  }
  if (filled(site.careers?.image)) image(site.careers.image, "careers.image");

  // Job applications collect personal data. The form may only be switched on once a
  // privacy policy is published.
  if (site.careers?.applications?.enabled === true) {
    if (!hasPrivacyPolicy(site)) {
      errors.push("careers.applications.enabled is true but there is no privacy policy (set legal.privacyPolicyUrl or fill legal.privacy.sections)");
    }
  } else {
    warnings.push("careers.applications.enabled is false: the Join Our Team page lists the roles but does not accept online applications");
  }
  if (filled(site.legal?.privacyPolicyUrl)) {
    if (!/^(https:\/\/|\/)/.test(site.legal.privacyPolicyUrl)) errors.push("legal.privacyPolicyUrl must start with https:// or /");
    else if (production && site.legal.privacyPolicyUrl.startsWith("https://") && isPlaceholderUrl(site.legal.privacyPolicyUrl)) {
      errors.push("legal.privacyPolicyUrl is a placeholder address");
    }
  }
  if (!hasPrivacyPolicy(site)) warnings.push("no privacy policy: required before online job applications can be switched on");

  return { errors, warnings };
}

// Lays sample values over the real content. Objects merge key by key. A list whose entries
// all carry an `id` is merged entry by entry onto the real entries with the same id (so a
// sample photo can be added to a real location without restating its address). Any other
// list, and any plain value, replaces the real one.
function overlay(base, extra) {
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const keyed = (list) => Array.isArray(list) && list.length > 0 && list.every((entry) => isObject(entry) && filled(entry.id));
  if (keyed(extra) && Array.isArray(base)) {
    return base.map((entry) => {
      const match = extra.find((candidate) => candidate.id === entry?.id);
      return match ? overlay(entry, match) : entry;
    });
  }
  if (!isObject(base) || !isObject(extra)) return extra;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = overlay(base[key], value);
  return out;
}

const readJson = (path) => {
  const data = JSON.parse(readFileSync(path, "utf8"));
  delete data._readme;
  return data;
};

// Positions grouped by department, in the order departments first appear.
function byDepartment(positions) {
  const groups = [];
  for (const position of positions) {
    const name = filled(position.department) ? position.department : "Open positions";
    let group = groups.find((entry) => entry.name === name);
    if (!group) groups.push((group = { name, positions: [] }));
    group.positions.push(position);
  }
  return groups;
}

// `env` is the build environment. Only CLOVER_ORDERING_URL is read from it.
export function loadContent(profile, env = process.env) {
  const paths = contentPaths(profile);
  // The sample profile is the real content with the sample overrides laid on top, so
  // real text is never duplicated and only the genuinely missing parts are sample data.
  const site = profile === "sample"
    ? overlay(readJson(contentPaths("production").file), readJson(paths.file))
    : readJson(paths.file);

  // The ordering link can be set in the hosting dashboard without touching the repository.
  if (filled(env.CLOVER_ORDERING_URL)) {
    site.ordering = { ...site.ordering, url: env.CLOVER_ORDERING_URL.trim() };
  }

  const issues = validateContent(site, paths.media, { profile });

  const fullName = filled(site.fullName) ? site.fullName : site.name;
  const hasGallery = Array.isArray(site.gallery) && site.gallery.length > 0;
  const orderUrl = filled(site.ordering?.url) ? site.ordering.url : null;
  const positions = site.careers?.positions ?? [];
  const privacySections = site.legal?.privacy?.sections ?? [];
  // An external policy wins; otherwise the on-site page, when it has any text.
  const privacyUrl = filled(site.legal?.privacyPolicyUrl)
    ? site.legal.privacyPolicyUrl
    : privacySections.length > 0 ? "/privacy/" : null;

  const locations = (site.locations ?? []).map((location) => {
    const address = [location.street, [location.city, location.region].filter(Boolean).join(", "), location.postalCode]
      .filter(Boolean).join(", ");
    const hours = Array.isArray(location.hours) ? location.hours : [];
    return {
      ...location,
      addressLine: address,
      cityLine: [[location.city, location.region].filter(Boolean).join(", "), location.postalCode].filter(Boolean).join(" "),
      phoneHref: filled(location.phone) ? telHref(location.phone) : null,
      // A search link built from the address works without any client-supplied map link.
      directionsUrl: filled(location.mapsUrl)
        ? location.mapsUrl
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${fullName} ${address}`)}`,
      hoursSummary: hours.map((slot) => ({ days: formatDays(slot.days), time: range(slot) })),
      hoursByDay: hoursByDay(hours),
      // Named services inside opening hours, such as breakfast.
      servicesSummary: (location.services ?? []).map((service) => ({
        name: service.name, days: formatDays(service.days), time: range(service),
      })),
    };
  });

  return {
    issues,
    site: {
      ...site,
      fullName,
      careers: {
        ...site.careers,
        positions,
        departments: byDepartment(positions),
        applicationsOpen: site.careers?.applications?.enabled === true && privacyUrl !== null,
      },
      legal: { privacyUrl, privacyIsExternal: privacyUrl !== null && privacyUrl.startsWith("https://"), privacy: { updated: site.legal?.privacy?.updated ?? null, sections: privacySections } },
      locations,
      primaryLocation: locations[0] ?? null,
      hasGallery,
      orderUrl,
      // Until Clover ordering is configured, ORDER ONLINE leads to the on-site page.
      orderHref: orderUrl ?? "/order/",
      orderIsExternal: orderUrl !== null,
      socialLinks: Object.entries(site.social ?? {})
        .filter(([, url]) => filled(url))
        .map(([network, url]) => ({ network, label: network[0].toUpperCase() + network.slice(1), url })),
      nav: [
        { href: "/menu/", label: "Menu" },
        { href: "/about/", label: "About" },
        { href: "/locations/", label: "Locations" },
        ...(hasGallery ? [{ href: "/gallery/", label: "Gallery" }] : []),
        { href: "/contact/", label: "Contact" },
        { href: "/careers/", label: "Join Our Team" },
      ],
    },
  };
}
