// Structured data, sitemap and robots.txt, generated from the content file.
import { largestJpeg } from "./media.js";
import { PAGES, pageMeta } from "./pages.js";

// schema.org/Restaurant is a subtype of LocalBusiness, so one object serves both.
export function restaurantJsonLd(site, manifest) {
  // A real photo when there is one; otherwise the image made from the logo.
  const image = (site.hero?.image ? largestJpeg(manifest, site.hero.image) : null) ?? manifest.__og?.url ?? null;
  const entries = site.locations.map((location) => {
    const entry = {
      "@type": "Restaurant",
      "@id": `${site.siteUrl}/#${location.id ?? "restaurant"}`,
      name: site.locations.length > 1 && location.name ? `${site.fullName} - ${location.name}` : site.fullName,
      url: site.siteUrl,
      telephone: location.phone,
      address: {
        "@type": "PostalAddress",
        streetAddress: location.street,
        addressLocality: location.city,
        addressRegion: location.region ?? undefined,
        postalCode: location.postalCode ?? undefined,
        addressCountry: location.country ?? undefined,
      },
      openingHoursSpecification: (location.hours ?? []).map((slot) => ({
        "@type": "OpeningHoursSpecification",
        dayOfWeek: slot.days,
        opens: slot.opens,
        closes: slot.closes,
      })),
      hasMenu: `${site.siteUrl}/menu/`,
    };
    if (site.description) entry.description = site.description;
    if (image) entry.image = `${site.siteUrl}${image}`;
    if (site.cuisine?.length) entry.servesCuisine = site.cuisine;
    if (site.priceRange) entry.priceRange = site.priceRange;
    if (location.email) entry.email = location.email;
    if (location.mapsUrl) entry.hasMap = location.mapsUrl;
    if (location.geo) {
      entry.geo = { "@type": "GeoCoordinates", latitude: location.geo.lat, longitude: location.geo.lng };
    }
    if (site.orderUrl) {
      // No deliveryMethod: whether the restaurant offers pickup, delivery or both is set
      // in Clover and is not known to this site.
      entry.potentialAction = { "@type": "OrderAction", target: site.orderUrl };
    }
    if (site.socialLinks.length) entry.sameAs = site.socialLinks.map((link) => link.url);
    return entry;
  });
  if (entries.length === 0) return null;
  return { "@context": "https://schema.org", "@graph": entries };
}

// "<" is escaped so content can never close the script element.
export const jsonLdScript = (data) =>
  data ? `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>` : "";

export function sitemapXml(site) {
  const urls = PAGES.map((page) => pageMeta(page, site))
    .filter((meta) => !meta.noindex)
    .map((meta) => `  <url><loc>${meta.canonical}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(site, sample) {
  if (sample) return "User-agent: *\nDisallow: /\n";
  return `User-agent: *\nAllow: /\nDisallow: /dashboard/\n\nSitemap: ${site.siteUrl}/sitemap.xml\n`;
}
