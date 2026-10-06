// Every HTML entry point, with its SEO metadata. Titles and descriptions are built from the
// content file so nothing about the restaurant is hardcoded in templates.

const fallback = (site) => site.description ?? "";

export const PAGES = [
  {
    id: "home", file: "index.html", path: "/",
    // The town in the title is what people search with: "restaurant El Cajon".
    title: (site) => {
      const place = site.primaryLocation ? [site.primaryLocation.city, site.primaryLocation.region].filter(Boolean).join(", ") : "";
      return [site.fullName, site.tagline || place].filter(Boolean).join(" | ");
    },
    description: fallback,
  },
  {
    id: "menu", file: "menu/index.html", path: "/menu/",
    title: (site) => `Menu | ${site.fullName}`,
    description: (site) => `See the full menu at ${site.fullName}, with current prices and availability. Order online.`,
  },
  {
    id: "about", file: "about/index.html", path: "/about/",
    title: (site) => `About Us | ${site.fullName}`,
    description: (site) => site.about?.paragraphs?.[0]?.slice(0, 155) ?? fallback(site),
  },
  {
    id: "locations", file: "locations/index.html", path: "/locations/",
    title: (site) => `Location & Hours | ${site.fullName}`,
    description: (site) =>
      site.primaryLocation
        ? `Find ${site.fullName} at ${site.primaryLocation.addressLine}. Opening hours, phone and directions.`
        : fallback(site),
  },
  {
    id: "gallery", file: "gallery/index.html", path: "/gallery/",
    title: (site) => `Gallery | ${site.fullName}`,
    description: (site) => `Photos of the food and the dining room at ${site.fullName}.`,
    // An empty gallery page is kept out of search results and the sitemap.
    noindex: (site) => !site.hasGallery,
  },
  {
    id: "contact", file: "contact/index.html", path: "/contact/",
    title: (site) => `Contact | ${site.fullName}`,
    description: (site) => `Call or visit ${site.fullName}. Phone, address and opening hours.`,
  },
  {
    id: "careers", file: "careers/index.html", path: "/careers/",
    title: (site) => `Join Our Team | ${site.fullName}`,
    description: (site) => `Open positions at ${site.fullName}. Apply online in a few minutes.`,
  },
  {
    id: "order", file: "order/index.html", path: "/order/",
    title: (site) => `Order Online | ${site.fullName}`,
    description: (site) => `Order from ${site.fullName} online. Ordering and payment are handled by Clover.`,
  },
  {
    id: "privacy", file: "privacy/index.html", path: "/privacy/",
    title: (site) => `Privacy Policy | ${site.fullName}`,
    description: (site) => `How ${site.fullName} handles personal information.`,
    // Until the policy text exists the page is an empty shell: keep it out of search.
    noindex: (site) => site.legal.privacy.sections.length === 0,
  },
  {
    id: "notfound", file: "404.html", path: "/404.html",
    title: (site) => `Page not found | ${site.fullName}`,
    description: () => "",
    noindex: () => true,
  },
  {
    id: "dashboard", file: "dashboard/index.html", path: "/dashboard/",
    title: (site) => `Dashboard | ${site.fullName}`,
    description: () => "",
    noindex: () => true,
  },
];

export const pageMeta = (page, site) => ({
  id: page.id,
  path: page.path,
  title: page.title(site),
  description: page.description(site),
  canonical: `${site.siteUrl}${page.path}`,
  noindex: page.noindex ? page.noindex(site) : false,
});
