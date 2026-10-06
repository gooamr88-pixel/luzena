// Pure logic used by the pages and the build: money, hours, content validation, SEO.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_DIR, CONFIG_PATH, DOMAIN, nginxConfig, OLD_DOMAIN, REDIRECT_CONFIG_PATH, redirectConfig,
} from "../scripts/build-nginx-config.mjs";
import { formatDays, formatTime, hoursByDay, isPlaceholderUrl, loadContent, telHref, validateContent } from "../build/content.js";
import { PAGES, pageMeta } from "../build/pages.js";
import { jsonLdScript, restaurantJsonLd, robotsTxt, sitemapXml } from "../build/seo.js";
import { centsToInput, formatPrice, parsePriceToCents, priceLabel } from "../src/js/lib/format.js";

describe("money", () => {
  it("parses typed prices into whole cents without floating point", () => {
    expect(parsePriceToCents("12.50")).toBe(1250);
    expect(parsePriceToCents("12,5")).toBe(1250);
    expect(parsePriceToCents("12")).toBe(1200);
    expect(parsePriceToCents(" 0.07 ")).toBe(7);
    expect(parsePriceToCents("19.99")).toBe(1999);
    expect(parsePriceToCents("1005.10")).toBe(100510);
  });

  it("rejects anything that is not a plain amount", () => {
    for (const bad of ["", "abc", "-1", "1.234", "1e3", "$5", "5.", ".5", "1 000"]) {
      expect(parsePriceToCents(bad), bad).toBeNull();
    }
  });

  it("round-trips through the input format", () => {
    for (const cents of [0, 7, 350, 1999, 100510]) expect(parsePriceToCents(centsToInput(cents))).toBe(cents);
  });

  it("formats prices and leaves variable prices blank", () => {
    expect(formatPrice(1250, "USD", "en-US")).toBe("$12.50");
    expect(priceLabel({ price_cents: 900, price_type: "FIXED" }, "USD", "en-US")).toBe("$9.00");
    expect(priceLabel({ price_cents: 900, price_type: "PER_UNIT", unit_name: "lb" }, "USD", "en-US")).toBe("$9.00 / lb");
    expect(priceLabel({ price_cents: 0, price_type: "VARIABLE" }, "USD", "en-US")).toBe("");
    expect(priceLabel({ price_cents: null, price_type: "FIXED" }, "USD", "en-US")).toBe("");
  });
});

describe("opening hours", () => {
  it("formats times and day ranges", () => {
    expect(formatTime("11:00")).toBe("11 AM");
    expect(formatTime("23:30")).toBe("11:30 PM");
    expect(formatTime("00:00")).toBe("12 AM");
    expect(formatTime("12:00")).toBe("12 PM");
    expect(formatDays(["Monday", "Tuesday", "Wednesday"])).toBe("Mon – Wed");
    expect(formatDays(["Sunday"])).toBe("Sun");
    expect(formatDays(["Monday", "Wednesday", "Thursday"])).toBe("Mon, Wed – Thu");
  });

  it("starts the week on Sunday and names a full week", () => {
    expect(formatDays(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"])).toBe("Sun – Thu");
    expect(formatDays(["Saturday", "Friday"])).toBe("Fri – Sat");
    expect(formatDays(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"])).toBe("Every day");
    expect(hoursByDay([]).map((entry) => entry.day)[0]).toBe("Sunday");
  });

  it("marks days without hours as closed", () => {
    const week = hoursByDay([{ days: ["Monday"], opens: "11:00", closes: "22:00" }]);
    expect(week[1]).toEqual({ day: "Monday", time: "11 AM – 10 PM" });
    expect(week[2]).toEqual({ day: "Tuesday", time: "Closed" });
    expect(week).toHaveLength(7);
  });

  it("shows closing times after midnight the way the restaurant writes them", () => {
    const week = hoursByDay([
      { days: ["Sunday"], opens: "08:00", closes: "00:00" },
      { days: ["Friday"], opens: "08:00", closes: "02:00" },
    ]);
    expect(week[0].time).toBe("8 AM – 12 AM");
    expect(week[5].time).toBe("8 AM – 2 AM");
  });

  it("builds a dialable phone link", () => {
    expect(telHref("+1 (555) 010-0100")).toBe("tel:+15550100100");
    expect(telHref("+1 619-499-5779")).toBe("tel:+16194995779");
  });
});

// Facts the client confirmed on 2026-10-05. If one of these fails, the content file was
// changed: check with the restaurant before changing the test.
describe("the restaurant's confirmed details", () => {
  const { site } = loadContent("production");
  const location = site.primaryLocation;

  it("uses the confirmed name and domain, and never the old spelling of the domain", () => {
    expect(site.fullName).toBe("Luzena Restaurant & Cafe");
    expect(site.siteUrl).toBe("https://luzenarestaurant.com");
    expect(JSON.stringify(site)).not.toMatch(/luznarestaurant/i);
  });

  it("has the confirmed address, phone and map link", () => {
    expect(location.addressLine).toBe("315 El Cajon Blvd, El Cajon, CA, 92020");
    expect(location.cityLine).toBe("El Cajon, CA 92020");
    expect(location.country).toBe("US");
    expect(location.phone).toBe("+1 619-499-5779");
    expect(location.phoneHref).toBe("tel:+16194995779");
    expect(location.directionsUrl).toBe("https://maps.app.goo.gl/WTwNqRWv3dyaetAQ8");
  });

  // The address that job applications are reported to is the owner's own inbox. It is kept
  // on the server, in the restaurant's row in the database, and is no part of the website:
  // not in the content the pages are built from, and so not in a page, a link or the data
  // given to search engines.
  it("publishes no email address: the one applications are reported to stays on the server", () => {
    expect(location.email).toBeNull();
    const raw = readFileSync(new URL("../content/site.json", import.meta.url), "utf8");
    expect(JSON.stringify(site) + raw).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(JSON.stringify(restaurantJsonLd(site, {}))).not.toMatch(/email|@gmail/i);
  });

  // The dashboard and the server word an application's answers and stages from two lists
  // that cannot share a file (one runs in the browser, one in the Edge Functions).
  it("words job application answers the same in the dashboard as on the server", async () => {
    const server = await import("../supabase/functions/_shared/public/application-fields.ts");
    const browser = await import("../src/js/lib/application.js");
    expect(browser.LABELS).toEqual(server.LABELS);
    expect(browser.STATUSES).toEqual([...server.STATUSES]);
    // Every choice the server accepts is one the form offers, and the other way round.
    const form = readFileSync(new URL("../careers/index.html", import.meta.url), "utf8");
    const offered = (name) => [...form.matchAll(new RegExp(`name="${name}"[^>]*>([\\s\\S]*?)</select>`, "g"))]
      .flatMap((match) => [...match[1].matchAll(/<option value="([^"]+)"/g)].map((option) => option[1]));
    expect(offered("employment_type")).toEqual([...server.EMPLOYMENT_TYPES]);
    expect(offered("start_when")).toEqual([...server.START_WHEN]);
    expect(offered("experience_level")).toEqual([...server.EXPERIENCE_LEVELS]);
    expect([...form.matchAll(/name="availability" value="([^"]+)"/g)].map((match) => match[1])).toEqual([...server.AVAILABILITY]);
  });

  it("has the confirmed opening hours", () => {
    expect(location.hoursSummary).toEqual([
      { days: "Sun – Thu", time: "8 AM – 12 AM" },
      { days: "Fri – Sat", time: "8 AM – 2 AM" },
    ]);
    expect(location.hoursByDay.map((entry) => `${entry.day}: ${entry.time}`)).toEqual([
      "Sunday: 8 AM – 12 AM", "Monday: 8 AM – 12 AM", "Tuesday: 8 AM – 12 AM", "Wednesday: 8 AM – 12 AM",
      "Thursday: 8 AM – 12 AM", "Friday: 8 AM – 2 AM", "Saturday: 8 AM – 2 AM",
    ]);
  });

  it("has breakfast every day from 8 AM to 12 PM", () => {
    expect(location.servicesSummary).toEqual([{ name: "Breakfast", days: "Every day", time: "8 AM – 12 PM" }]);
  });

  it("publishes them to search engines as structured data", () => {
    const restaurant = restaurantJsonLd(site, {})["@graph"][0];
    expect(restaurant).toMatchObject({
      "@type": "Restaurant",
      name: "Luzena Restaurant & Cafe",
      url: "https://luzenarestaurant.com",
      telephone: "+1 619-499-5779",
      hasMap: "https://maps.app.goo.gl/WTwNqRWv3dyaetAQ8",
      address: { streetAddress: "315 El Cajon Blvd", addressLocality: "El Cajon", addressRegion: "CA", postalCode: "92020", addressCountry: "US" },
    });
    expect(restaurant.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"], opens: "08:00", closes: "00:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Friday", "Saturday"], opens: "08:00", closes: "02:00" },
    ]);
    // Nothing the client has not supplied: no coordinates, no price range, no rating.
    expect(restaurant).not.toHaveProperty("geo");
    expect(restaurant).not.toHaveProperty("priceRange");
    expect(restaurant).not.toHaveProperty("aggregateRating");
  });

  it("puts the town in the home page title", () => {
    const home = pageMeta(PAGES.find((page) => page.id === "home"), site);
    expect(home.title).toBe("Luzena Restaurant & Cafe | El Cajon, CA");
    expect(home.canonical).toBe("https://luzenarestaurant.com/");
  });
});

describe("content gate", () => {
  // These build broken copies of the content rather than reading site.json, so they keep
  // passing as the client fills the real file in.
  const withChanges = (change, profile = "production") => {
    const site = structuredClone(loadContent("sample").site);
    // Start from content with no images and no sample link, so only the change under test
    // can produce an error.
    Object.assign(site, { logo: null, ogImage: null, gallery: [], defaultDishPhotos: [] });
    site.hero.image = null;
    site.about.image = null;
    site.careers.image = null;
    site.locations[0].image = null;
    site.ordering.url = null;
    change(site);
    return validateContent(site, "/nowhere", { profile });
  };

  it("has a clean baseline, so each test below fails only for its own reason", () => {
    expect(withChanges(() => {}).errors).toEqual([]);
  });

  it("blocks a build when the text every page depends on is missing", () => {
    const { errors } = withChanges((site) => {
      site.description = null;
      site.hero.headline = "";
      site.about.paragraphs = [];
    });
    expect(errors.join("\n")).toMatch(/description is missing/);
    expect(errors.join("\n")).toMatch(/hero\.headline is missing/);
    expect(errors.join("\n")).toMatch(/about\.paragraphs is empty/);
  });

  it("does not block on photos or a missing location: those are warnings", () => {
    const { errors, warnings } = withChanges((site) => { site.locations = []; });
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/locations is empty/);
    expect(warnings.join("\n")).toMatch(/hero\.image is missing/);
    expect(warnings.join("\n")).toMatch(/gallery is empty/);
  });

  it("refuses a photo that is named but not in the media folder", () => {
    const { errors } = withChanges((site) => {
      site.hero.image = "hero.jpg";
      site.hero.imageAlt = "A dish";
    });
    expect(errors.join("\n")).toMatch(/hero\.image: file "hero\.jpg" not found/);
  });

  it("refuses a default dish photo that is not in the media folder", () => {
    const { errors } = withChanges((site) => { site.defaultDishPhotos = ["missing.jpg"]; });
    expect(errors.join("\n")).toMatch(/defaultDishPhotos\[0\]: file "missing\.jpg" not found/);
  });

  it("still requires a listed location to be complete", () => {
    const { errors } = withChanges((site) => {
      site.locations[0].phone = "";
      site.locations[0].hours = [];
    });
    expect(errors.join("\n")).toMatch(/locations\[0\]\.phone is missing/);
    expect(errors.join("\n")).toMatch(/locations\[0\]\.hours is empty/);
  });

  it("accepts the sample profile and the real content as they are", () => {
    expect(loadContent("sample").issues.errors).toEqual([]);
    expect(loadContent("production").issues.errors).toEqual([]);
  });

  it("builds the sample profile from the real content, adding only what does not exist yet", () => {
    const real = loadContent("production").site;
    const sample = loadContent("sample").site;
    expect(sample.fullName).toBe(real.fullName);
    expect(sample.about.paragraphs).toEqual(real.about.paragraphs);
    expect(sample.careers.positions.length).toBe(real.careers.positions.length);
    // The real location keeps its real address and hours; the sample only changes its photo.
    expect(sample.locations).toHaveLength(real.locations.length);
    expect(sample.primaryLocation.street).toBe(real.primaryLocation.street);
    expect(sample.primaryLocation.phone).toBe(real.primaryLocation.phone);
    expect(sample.primaryLocation.hoursSummary).toEqual(real.primaryLocation.hoursSummary);
    expect(sample.primaryLocation.image).toBe("location.jpg");
    expect(real.primaryLocation.image).toBe("placeholder-location.jpg");
  });

  // Until the restaurant's own photos arrive, the real content shows placeholder photos.
  // They are named placeholder-* so that none can be mistaken for a real photo, and each
  // must exist in content/media. When a real photo replaces one, allow its name here.
  it("names only placeholder photos in the real content, and no sample link", () => {
    const real = loadContent("production", {}).site;
    const photos = [
      real.hero.image, real.about.image, ...real.locations.map((location) => location.image),
      ...real.gallery.map((entry) => entry.image), ...real.defaultDishPhotos,
    ];
    expect(photos.length).toBeGreaterThan(8);
    for (const name of photos) {
      expect(name).toMatch(/^placeholder-[a-z0-9-]+\.jpg$/);
      expect(existsSync(new URL(`../content/media/${name}`, import.meta.url)), name).toBe(true);
    }
    expect(real.gallery.every((entry) => entry.alt.length > 10)).toBe(true);
    // The share image stays the one made from the logo, and the careers photo stays out.
    expect([real.ogImage, real.careers.image]).toEqual([null, null]);
    expect(JSON.stringify(real)).not.toMatch(/example\.com|sample/i);
  });

  describe("ORDER ONLINE link", () => {
    it("leads to the on-site page while no Clover link is set", () => {
      const { site } = loadContent("production", {});
      expect(site.orderUrl).toBeNull();
      expect(site.orderHref).toBe("/order/");
      expect(site.orderIsExternal).toBe(false);
    });

    it("takes the link from the CLOVER_ORDERING_URL build variable without a code change", () => {
      const url = "https://www.clover.com/online-ordering/some-restaurant";
      const { site, issues } = loadContent("production", { CLOVER_ORDERING_URL: ` ${url} ` });
      expect(issues.errors).toEqual([]);
      expect(site.orderHref).toBe(url);
      expect(site.orderIsExternal).toBe(true);
      expect(restaurantJsonLd(site, {})["@graph"][0].potentialAction).toEqual({ "@type": "OrderAction", target: url });
    });

    it("refuses a placeholder or insecure link in a production build", () => {
      for (const url of ["https://example.com/order", "https://sample-ordering.test/x", "http://www.clover.com/x", "https://localhost/order", "not a url"]) {
        const { issues } = loadContent("production", { CLOVER_ORDERING_URL: url });
        expect(issues.errors.join("\n"), url).toMatch(/ordering\.url/);
      }
    });

    it("warns, without blocking, when the link is not on clover.com", () => {
      const { issues } = loadContent("production", { CLOVER_ORDERING_URL: "https://order.some-other-service.com/luzena" });
      expect(issues.errors).toEqual([]);
      expect(issues.warnings.join("\n")).toMatch(/does not point to clover\.com/);
    });

    it("allows the stand-in link only in the sample profile", () => {
      expect(loadContent("sample", {}).issues.errors).toEqual([]);
      expect(isPlaceholderUrl(loadContent("sample", {}).site.ordering.url)).toBe(true);
    });
  });

  describe("job applications switch", () => {
    it("is on in the real content, with the privacy policy the form links to", () => {
      const { site, issues } = loadContent("production", {});
      expect(issues.errors).toEqual([]);
      expect(site.careers.applicationsOpen).toBe(true);
      expect(site.legal.privacyUrl).toBe("/privacy/");
      expect(site.legal.privacy.updated).toBeTruthy();
      const policy = site.legal.privacy.sections.flatMap((section) => [section.heading, ...section.paragraphs]).join("\n");
      // What the form asks, the policy names. An applicant is told before they are asked.
      for (const collected of ["name", "email address", "phone number", "position", "full-time or part-time", "when you could work", "experience", "authorized to work in the United States", "resume or CV"]) {
        expect(policy, collected).toContain(collected);
      }
      // Who sees it, where it is kept, for how long, and how to have it deleted.
      expect(policy).toMatch(/only by the people at the restaurant who are responsible for hiring/);
      expect(policy).toMatch(/Supabase.*United States/);
      expect(policy).toMatch(/ask us to delete your application/);
      // The number here is a promise. It must equal JOB_APPLICATION_RETENTION_DAYS on the
      // server (docs/CONFIGURATION.md section 5): change one, change the other.
      expect(policy.match(/\b\d+ days\b/g)).toEqual(["90 days", "90 days"]);
    });

    it("cannot be switched on without a privacy policy", () => {
      const { errors } = withChanges((site) => {
        site.careers.applications = { enabled: true };
        site.legal = { privacyPolicyUrl: null, privacy: { sections: [] } };
      });
      expect(errors.join("\n")).toMatch(/enabled is true but there is no privacy policy/);
    });

    it("can be switched on once a policy exists, on this site or elsewhere", () => {
      const onSite = withChanges((site) => {
        site.careers.applications = { enabled: true };
        site.legal = { privacyPolicyUrl: null, privacy: { sections: [{ heading: "Privacy", paragraphs: ["Text."] }] } };
      });
      const external = withChanges((site) => {
        site.careers.applications = { enabled: true };
        site.legal = { privacyPolicyUrl: "https://luzenarestaurant.com/privacy.pdf", privacy: { sections: [] } };
      });
      expect(onSite.errors).toEqual([]);
      expect(external.errors).toEqual([]);
    });

    it("refuses a placeholder privacy link in production", () => {
      const { errors } = withChanges((site) => {
        site.careers.applications = { enabled: true };
        site.legal = { privacyPolicyUrl: "https://example.com/privacy", privacy: { sections: [] } };
      });
      expect(errors.join("\n")).toMatch(/privacyPolicyUrl is a placeholder/);
    });
  });

  it("groups positions by department, keeping every position", () => {
    const { careers } = loadContent("production").site;
    expect(careers.departments.map((department) => department.name))
      .toEqual(["Management", "Kitchen", "Cafe", "Front of House", "Support"]);
    expect(careers.departments.reduce((sum, department) => sum + department.positions.length, 0))
      .toBe(careers.positions.length);
    expect(new Set(careers.positions.map((position) => position.slug)).size).toBe(careers.positions.length);
  });

  it("rejects malformed hours, services and links", () => {
    const { errors } = withChanges((site) => {
      site.locations[0].hours = [{ days: ["Funday"], opens: "25:00", closes: "22:00" }];
      site.locations[0].services = [{ name: "", days: ["Monday"], opens: "08:00", closes: "12:00" }];
      site.locations[0].mapsUrl = "http://maps.example/x";
      site.social.instagram = "instagram.com/luzena";
    });
    expect(errors.join("\n")).toMatch(/hours has an invalid entry/);
    expect(errors.join("\n")).toMatch(/services has an invalid entry/);
    expect(errors.join("\n")).toMatch(/mapsUrl must start with https/);
    expect(errors.join("\n")).toMatch(/social\.instagram must start with https/);
  });
});

describe("SEO output", () => {
  const { site } = loadContent("sample");

  it("gives every page a unique title and canonical URL", () => {
    const metas = PAGES.map((page) => pageMeta(page, site));
    expect(new Set(metas.map((meta) => meta.title)).size).toBe(metas.length);
    expect(metas.every((meta) => meta.canonical.startsWith("https://"))).toBe(true);
  });

  it("keeps private and error pages out of the sitemap and robots", () => {
    const sitemap = sitemapXml(site);
    expect(sitemap).toContain("<loc>https://luzenarestaurant.com/menu/</loc>");
    expect(sitemap).not.toMatch(/dashboard|404/);
    expect(robotsTxt(site, false)).toContain("Disallow: /dashboard/");
    expect(robotsTxt(site, true)).toBe("User-agent: *\nDisallow: /\n");
  });

  it("links structured data to the menu page and to a share image", () => {
    const restaurant = restaurantJsonLd(site, { __og: { url: "/media/og-default.png" } })["@graph"][0];
    expect(restaurant.hasMenu).toBe("https://luzenarestaurant.com/menu/");
    expect(restaurant.image).toBe("https://luzenarestaurant.com/media/og-default.png");
  });

  it("leaves the privacy page out of search until it has text", () => {
    const real = loadContent("production", {}).site;
    const privacy = PAGES.find((page) => page.id === "privacy");
    // The real policy is published, so its page can be found.
    expect(pageMeta(privacy, real).noindex).toBe(false);
    expect(sitemapXml(real)).toContain("/privacy/");
    // Without its text the page is an empty shell, and stays out.
    const empty = { ...real, legal: { ...real.legal, privacy: { updated: null, sections: [] } } };
    expect(pageMeta(privacy, empty).noindex).toBe(true);
    expect(sitemapXml(empty)).not.toContain("/privacy/");
  });

  it("cannot be broken out of by content", () => {
    expect(jsonLdScript({ name: "</script><script>alert(1)</script>" })).not.toContain("</script><script>");
  });
});

describe("hosted Auth configuration (supabase/config.toml)", () => {
  // `supabase config push` applies this file to a hosted project as written.
  const toml = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const section = (name) => {
    const start = toml.indexOf(`\n[${name}]\n`);
    expect(start, `[${name}] exists`).toBeGreaterThan(-1);
    const rest = toml.slice(start + name.length + 4);
    const end = rest.search(/\n\[/);
    return end === -1 ? rest : rest.slice(0, end);
  };

  it("lets nobody sign up, and keeps a password of at least 12 characters", () => {
    expect(section("auth")).toMatch(/^enable_signup = false$/m);
    expect(section("auth")).toMatch(/^enable_anonymous_sign_ins = false$/m);
    expect(section("auth")).toMatch(/^minimum_password_length = 12$/m);
  });

  it("keeps the email provider on: switching it off locks the owner out", () => {
    expect(section("auth.email")).toMatch(/^enable_signup = true$/m);
  });

  it("gives each hosted project its own site address, and production the real domain", () => {
    expect(section("remotes.test")).toContain('project_id = "cgxhifkeoesvsycewwfs"');
    expect(section("remotes.production")).toContain('project_id = "xqzpuqjrlrxyitjubkqk"');
    expect(section("remotes.production.auth")).toContain('site_url = "https://luzenarestaurant.com/dashboard/"');
    expect(section("remotes.production.auth")).toContain('additional_redirect_urls = ["https://luzenarestaurant.com/dashboard/"]');
    expect(section("remotes.test.auth")).not.toContain("luzenarestaurant.com");
  });
});

describe("production web server configuration", () => {
  const config = nginxConfig();
  const { headers: rules } = JSON.parse(readFileSync(new URL("../deploy/headers.json", import.meta.url), "utf8"));
  const security = rules.find((rule) => rule.source === "/(.*)").headers.filter(({ key }) => key !== "Cache-Control");
  // The body of every `location` that answers with a file.
  const serving = [...config.matchAll(/location [^{]+\{([^}]*)\}/g)].map((match) => match[1])
    .filter((body) => /try_files|internal;/.test(body));

  it("is committed exactly as the generator writes it", () => {
    expect(readFileSync(CONFIG_PATH, "utf8").replace(/\r\n/g, "\n")).toBe(config);
  });

  it("sends every security header from every location, since Nginx does not inherit them", () => {
    expect(serving.length).toBeGreaterThanOrEqual(5);
    for (const body of serving) {
      for (const { key, value } of security) expect(body).toContain(`add_header ${key} "${value}" always;`);
      expect(body.match(/add_header Cache-Control /g)).toHaveLength(1);
    }
  });

  it("never caches the dashboard and keeps it out of search", () => {
    const dashboard = config.match(/location \/dashboard\/ \{([^}]*)\}/)[1];
    expect(dashboard).toContain('add_header Cache-Control "no-store" always;');
    expect(dashboard).toContain('add_header X-Robots-Tag "noindex, nofollow" always;');
  });

  it("serves the built release only, over https on the bare domain, and proxies nothing", () => {
    expect(config.match(/^\s*root .*;$/gm).map((line) => line.trim())).toEqual([
      `root ${APP_DIR}/acme;`, `root ${APP_DIR}/current;`,
    ]);
    expect(config).not.toMatch(/proxy_pass|fastcgi_pass|autoindex on/);
    expect(config).toContain(`return 301 https://${DOMAIN}$request_uri;`);
    expect(DOMAIN).toBe("luzenarestaurant.com");
    expect(config).not.toContain(OLD_DOMAIN);
  });

  it("sends the old spelling of the domain to the real one, and serves nothing from it", () => {
    const redirect = redirectConfig();
    expect(readFileSync(REDIRECT_CONFIG_PATH, "utf8").replace(/\r\n/g, "\n")).toBe(redirect);
    expect(redirect.match(/server_name [^;]+;/g)).toEqual([
      `server_name ${OLD_DOMAIN} www.${OLD_DOMAIN};`, `server_name ${OLD_DOMAIN} www.${OLD_DOMAIN};`,
    ]);
    expect(redirect.match(/return 301 https:\/\/luzenarestaurant\.com(\/|\$request_uri);/g)).toHaveLength(4);
    expect(redirect).not.toMatch(/\broot |proxy_pass|try_files/);
  });
});
