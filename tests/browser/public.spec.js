// The public website as it will be deployed: the production build (real content, no
// sample data), served with the production security headers, in a real browser.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessibilityViolations, describeViolations, hasHorizontalOverflow, launchBrowser, openPage, ROOT, serveBuild, VIEWPORT_WIDTHS,
} from "./helpers/site.js";

const BUILD = join(ROOT, ".cache", "e2e", "production");

const PAGES = [
  { path: "/", name: "Home" },
  { path: "/menu/", name: "Menu" },
  { path: "/about/", name: "About" },
  { path: "/locations/", name: "Locations" },
  { path: "/gallery/", name: "Gallery" },
  { path: "/contact/", name: "Contact" },
  { path: "/careers/", name: "Join Our Team" },
  { path: "/order/", name: "Order Online" },
  { path: "/privacy/", name: "Privacy" },
  { path: "/this-page-does-not-exist/", name: "404", status: 404 },
];

let site, browser;

beforeAll(async () => {
  site = await serveBuild("production");
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

describe.each(PAGES)("$name page ($path)", ({ path, status = 200 }) => {
  let opened;

  beforeAll(async () => {
    // A page that is meant to answer 404 makes the browser log exactly that; nothing else.
    const expected = status === 404 ? [/the server responded with a status of 404/] : [];
    opened = await openPage(browser, `${site.url}${path}`, { allowRequestFailures: expected });
    // The menu page settles into its "unavailable" state: no backend is configured here.
    await opened.page.waitForFunction(() => document.querySelector("[data-menu]")?.getAttribute("aria-busy") !== "true");
  });

  afterAll(async () => opened?.context.close());

  it("loads without script errors, blocked resources or policy violations", () => {
    expect(opened.status).toBe(status);
    expect(opened.problems).toEqual([]);
  });

  it("has one main heading, a title, a language and a skip link", async () => {
    const facts = await opened.page.evaluate(() => ({
      h1: document.querySelectorAll("h1").length,
      title: document.title,
      lang: document.documentElement.lang,
      skip: document.querySelector("a.skip-link")?.getAttribute("href"),
      main: document.querySelectorAll("main#main").length,
    }));
    expect(facts.h1).toBe(1);
    expect(facts.title).toMatch(/Luzena Restaurant & Cafe/);
    expect(facts.lang).toBe("en");
    expect(facts.skip).toBe("#main");
    expect(facts.main).toBe(1);
  });

  it("does not skip heading levels", async () => {
    const levels = await opened.page.evaluate(() =>
      [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")]
        .filter((heading) => !heading.closest("dialog, template") && heading.getClientRects().length > 0)
        .map((heading) => Number(heading.tagName[1])));
    const jumps = levels.filter((level, index) => index > 0 && level > levels[index - 1] + 1);
    expect(jumps, `heading order: ${levels.join(" ")}`).toEqual([]);
  });

  it("passes the WCAG 2.2 AA accessibility scan", async () => {
    const violations = await accessibilityViolations(opened.page);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it.each(VIEWPORT_WIDTHS)("fits a %ipx wide screen without sideways scrolling", async (width) => {
    await opened.page.setViewportSize({ width, height: 900 });
    expect(await hasHorizontalOverflow(opened.page)).toBe(false);
  });
});

describe("search engine metadata", () => {
  const meta = async (path) => {
    const { page, context } = await openPage(browser, `${site.url}${path}`);
    const data = await page.evaluate(() => ({
      canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
      robots: document.querySelector('meta[name="robots"]')?.content ?? null,
      description: document.querySelector('meta[name="description"]')?.content ?? null,
      ogUrl: document.querySelector('meta[property="og:url"]')?.content ?? null,
      ogImage: document.querySelector('meta[property="og:image"]')?.content ?? null,
      ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? null,
      twitter: document.querySelector('meta[name="twitter:card"]')?.content ?? null,
      jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((node) => JSON.parse(node.textContent)),
      html: document.documentElement.outerHTML,
    }));
    await context.close();
    return data;
  };

  it("gives every indexable page a canonical URL on the confirmed domain", async () => {
    for (const path of ["/", "/menu/", "/about/", "/locations/", "/gallery/", "/contact/", "/careers/", "/order/", "/privacy/"]) {
      const data = await meta(path);
      expect(data.canonical, path).toBe(`https://luzenarestaurant.com${path}`);
      expect(data.ogUrl, path).toBe(`https://luzenarestaurant.com${path}`);
      expect(data.robots, path).toBeNull();
      expect(data.description?.length, path).toBeGreaterThan(40);
      expect(data.ogTitle, path).toMatch(/Luzena/);
      expect(data.twitter, path).toBe("summary_large_image");
      expect(data.html, path).not.toMatch(/luznarestaurant|example\.com|Sample/);
    }
  });

  it("keeps the private page out of search", async () => {
    for (const path of ["/dashboard/"]) {
      expect((await meta(path)).robots, path).toMatch(/noindex/);
    }
  });

  it("serves a share image, a sitemap and robots rules that all exist", async () => {
    const home = await meta("/");
    expect(home.ogImage).toBe("https://luzenarestaurant.com/media/og-default.png");
    for (const [path, type] of [["/media/og-default.png", "image/png"], ["/sitemap.xml", "application/xml"], ["/robots.txt", "text/plain"], ["/favicon.svg", "image/svg+xml"]]) {
      const response = await fetch(`${site.url}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toContain(type);
    }
    const sitemap = await (await fetch(`${site.url}/sitemap.xml`)).text();
    expect(sitemap.match(/<loc>/g)).toHaveLength(9);
    expect(sitemap).not.toMatch(/dashboard|luznarestaurant/);
    const robots = await (await fetch(`${site.url}/robots.txt`)).text();
    expect(robots).toContain("Sitemap: https://luzenarestaurant.com/sitemap.xml");
    expect(robots).toContain("Disallow: /dashboard/");
  });

  it("tells search engines the restaurant's real name, address, phone and hours", async () => {
    const restaurant = (await meta("/")).jsonLd[0]["@graph"][0];
    expect(restaurant.name).toBe("Luzena Restaurant & Cafe");
    expect(restaurant.telephone).toBe("+1 619-499-5779");
    expect(restaurant.address.streetAddress).toBe("315 El Cajon Blvd");
    expect(restaurant.address.postalCode).toBe("92020");
    expect(restaurant.openingHoursSpecification).toHaveLength(2);
  });
});

describe("security headers", () => {
  it("sends the policy, and the pages work under it", async () => {
    const response = await fetch(`${site.url}/`);
    const policy = response.headers.get("content-security-policy");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
  });

  it("does not let the dashboard be cached or indexed", async () => {
    const response = await fetch(`${site.url}/dashboard/`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toMatch(/noindex/);
  });
});

describe("links and contact details", () => {
  it("has no broken internal link on any page", async () => {
    const seen = new Set();
    const broken = [];
    for (const { path } of PAGES.filter((entry) => !entry.status)) {
      const { page, context } = await openPage(browser, `${site.url}${path}`);
      const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")));
      await context.close();
      for (const href of links) {
        if (!href.startsWith("/") || seen.has(href)) continue;
        seen.add(href);
        const response = await fetch(`${site.url}${href.split("#")[0]}`);
        if (response.status !== 200) broken.push(`${href} on ${path} -> ${response.status}`);
      }
    }
    expect(broken).toEqual([]);
    expect(seen.size).toBeGreaterThan(6);
  });

  it("makes the phone number, map and Instagram work as links", async () => {
    const { page, context } = await openPage(browser, `${site.url}/contact/`);
    const hrefs = await page.evaluate(() => [...document.querySelectorAll("main a[href], footer a[href]")].map((a) => a.href));
    expect(hrefs).toContain("tel:+16194995779");
    expect(hrefs).toContain("https://maps.app.goo.gl/WTwNqRWv3dyaetAQ8");
    expect(hrefs).toContain("https://www.instagram.com/luzenarestaurant/");
    // Links that leave the site open safely in a new tab.
    const unsafe = await page.evaluate(() => [...document.querySelectorAll('a[target="_blank"]')].filter((a) => !a.rel.includes("noopener")).length);
    expect(unsafe).toBe(0);
    await context.close();
  });

  // Job applications are reported to the owner's inbox. That address is the server's
  // business: it must not be in anything a visitor's browser is sent, on any page, in any
  // script, stylesheet or data file, in either build.
  it("publishes no email address anywhere: not on a page, not in a link, not in any file sent to a browser", async () => {
    for (const { path } of PAGES.filter((entry) => !entry.status)) {
      const { page, context } = await openPage(browser, `${site.url}${path}`);
      const found = await page.evaluate(() => ({
        mailto: [...document.querySelectorAll('a[href^="mailto:" i]')].map((a) => a.getAttribute("href")),
        text: document.documentElement.outerHTML.match(/[A-Z0-9._%+-]+@[A-Z0-9-]+\.[A-Z]{2,}/gi) ?? [],
      }));
      expect(found.mailto, path).toEqual([]);
      expect(found.text, path).toEqual([]);
      await context.close();
    }

    const leaks = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(html|js|css|json|xml|txt|svg|map)$/i.test(entry.name) && /fadi\.?auchi|@gmail\.com/i.test(readFileSync(file, "utf8"))) {
          leaks.push(relative(ROOT, file).replaceAll("\\", "/"));
        }
      }
    };
    walk(BUILD);
    walk(join(ROOT, ".cache", "e2e", "demo"));
    expect(leaks).toEqual([]);
  });

  it("shows the address, every day's hours and breakfast on the locations page", async () => {
    const { page, context } = await openPage(browser, `${site.url}/locations/`);
    const text = await page.locator("main").innerText();
    expect(text).toContain("315 El Cajon Blvd");
    expect(text).toContain("El Cajon, CA 92020");
    expect(text).toContain("+1 619-499-5779");
    expect(text).toMatch(/Sunday\s+8 AM – 12 AM/);
    expect(text).toMatch(/Friday\s+8 AM – 2 AM/);
    expect(text).toMatch(/Saturday\s+8 AM – 2 AM/);
    expect(text).toContain("Breakfast: Every day, 8 AM – 12 PM");
    expect(await page.locator("main .hours-row").count()).toBe(7);
    await context.close();
  });

  it("shows a Google map of the address on the home page and the locations page", async () => {
    for (const path of ["/", "/locations/"]) {
      const { page, context } = await openPage(browser, `${site.url}${path}`);
      const map = page.locator("main iframe");
      expect(await map.count(), path).toBe(1);
      expect(decodeURIComponent(await map.getAttribute("src")), path).toMatch(/^https:\/\/www\.google\.com\/maps\?q=Luzena Restaurant & Cafe, 315 El Cajon Blvd, El Cajon, CA 92020&output=embed$/);
      expect(await map.getAttribute("title"), path).toContain("315 El Cajon Blvd");
      // Below the first screen it must not load, and so not contact Google, until it is near.
      expect(await map.getAttribute("loading"), path).toBe("lazy");
      await context.close();
    }
  });

  it("puts the map beside the visit details on a laptop and below them on a phone", async () => {
    const boxes = async (width) => {
      const { page, context } = await openPage(browser, `${site.url}/`, { width, height: 900 });
      const visit = page.locator('section[aria-labelledby="visit-title"]');
      const found = { map: await visit.locator("iframe").boundingBox(), call: await visit.locator('a.btn[href^="tel:"]').boundingBox() };
      await context.close();
      return found;
    };
    const laptop = await boxes(1280);
    expect(laptop.map.x).toBeGreaterThan(laptop.call.x + laptop.call.width);
    expect(laptop.map.y).toBeLessThan(laptop.call.y);
    expect(laptop.map.height).toBeGreaterThan(300);
    const phone = await boxes(390);
    expect(phone.map.y).toBeGreaterThan(phone.call.y + phone.call.height);
    expect(phone.map.x).toBeGreaterThanOrEqual(16);
    expect(phone.map.x + phone.map.width).toBeLessThanOrEqual(390 - 16);
    expect(phone.map.height).toBeGreaterThan(200);
  });

  it("shows the address and hours in the footer of every page", async () => {
    const { page, context } = await openPage(browser, `${site.url}/about/`);
    const text = await page.locator("footer").innerText();
    expect(text).toContain("315 El Cajon Blvd");
    expect(text).toMatch(/Sun – Thu\s+8 AM – 12 AM/);
    expect(text).toMatch(/Fri – Sat\s+8 AM – 2 AM/);
    expect(text).toContain("Breakfast: Every day, 8 AM – 12 PM");
    await context.close();
  });
});

describe("ORDER ONLINE before the Clover link exists", () => {
  it("sends every ORDER ONLINE button to the on-site page, never to an invented address", async () => {
    const { page, context } = await openPage(browser, `${site.url}/`);
    const targets = await page.evaluate(() =>
      [...document.querySelectorAll("a")].filter((a) => /order online/i.test(a.textContent)).map((a) => a.getAttribute("href")));
    expect(targets.length).toBeGreaterThanOrEqual(3);
    expect(new Set(targets)).toEqual(new Set(["/order/"]));
    await context.close();
  });

  it("explains on the order page that ordering opens soon, and offers the phone", async () => {
    const { page, context } = await openPage(browser, `${site.url}/order/`);
    const text = await page.locator("main").innerText();
    expect(text).toContain("Online ordering is opening soon.");
    expect(await page.locator('main a[href="tel:+16194995779"]').count()).toBeGreaterThan(0);
    expect(await page.locator('main a[href*="clover"]').count()).toBe(0);
    await context.close();
  });
});

describe("the menu page without a backend", () => {
  it("shows the unavailable message with a way to retry and to call", async () => {
    const { page, context, problems } = await openPage(browser, `${site.url}/menu/`);
    await page.waitForSelector("[data-menu-retry]");
    expect(await page.locator("[data-menu]").innerText()).toContain("Menu temporarily unavailable");
    expect(await page.locator('[data-menu] a[href="tel:+16194995779"]').count()).toBe(1);
    await page.click("[data-menu-retry]");
    await page.waitForSelector("[data-menu-retry]");
    expect(problems).toEqual([]);
    await context.close();
  });
});

describe("join our team, with applications open", () => {
  it("lists all 18 roles and publishes the application form, with its privacy policy", async () => {
    const { page, context } = await openPage(browser, `${site.url}/careers/`);
    expect(await page.locator("details.position").count()).toBe(18);
    expect(await page.locator("form[data-apply-form]").count()).toBe(1);
    expect(await page.locator('input[type="file"]').count()).toBe(1);
    expect(await page.locator("#apply").innerText()).not.toContain("open soon");
    // Each role offers to apply for it, and the form says what happens to the details.
    expect(await page.locator("details.position [data-apply-for]").count()).toBe(18);
    expect(await page.locator('form a[href="/privacy/"]').count()).toBe(1);
    // The page that receives applications is told to the form by the build, never the inbox.
    expect(await page.content()).not.toMatch(/recruitment|@gmail/i);
    await context.close();
  });

  it("publishes the privacy policy the form links to: what is collected, who sees it, for how long", async () => {
    const { page, context } = await openPage(browser, `${site.url}/privacy/`);
    const text = await page.locator("main").innerText();
    for (const expected of [
      "Applying for a job", "resume or CV", "authorized to work in the United States",
      "only by the people at the restaurant who are responsible for hiring",
      "for 90 days after you apply", "ask us to delete your application", "+1 619-499-5779",
    ]) expect(text, expected).toContain(expected);
    expect(await page.locator("main h2").count()).toBe(7);
    await context.close();
  });

  it("opens a role with the mouse and with the keyboard", async () => {
    const { page, context } = await openPage(browser, `${site.url}/careers/`);
    const first = page.locator("details.position").first();
    expect(await first.getAttribute("open")).toBeNull();
    await first.locator("summary").click();
    expect(await first.getAttribute("open")).not.toBeNull();
    // The small headings are set in capitals by CSS, so compare without regard to case.
    expect(await first.innerText()).toMatch(/what you will do/i);
    expect(await first.innerText()).toMatch(/what we look for/i);

    const second = page.locator("details.position").nth(1);
    await second.locator("summary").focus();
    await page.keyboard.press("Enter");
    expect(await second.getAttribute("open")).not.toBeNull();
    await context.close();
  });
});

describe("keyboard and phone navigation", () => {
  it("offers a skip link first, and it moves to the content", async () => {
    const { page, context } = await openPage(browser, `${site.url}/about/`);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement.className)).toContain("skip-link");
    await page.keyboard.press("Enter");
    expect(new URL(page.url()).hash).toBe("#main");
    await context.close();
  });

  it("shows a visible focus ring on links and buttons", async () => {
    const { page, context } = await openPage(browser, `${site.url}/`);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { width: parseFloat(style.outlineWidth), style: style.outlineStyle };
    });
    expect(outline.style).toBe("solid");
    expect(outline.width).toBeGreaterThanOrEqual(2);
    await context.close();
  });

  it("opens the phone menu, keeps focus inside it, closes with Escape and returns focus", async () => {
    const { page, context } = await openPage(browser, `${site.url}/`, { width: 390, height: 844 });
    const opener = page.locator("[data-nav-open]");
    expect(await opener.isVisible()).toBe(true);
    expect(await page.locator("header nav").isVisible()).toBe(false);

    await opener.click();
    expect(await page.locator("#mobile-nav").evaluate((dialog) => dialog.open)).toBe(true);
    expect(await page.locator("#mobile-nav a").count()).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.getElementById("mobile-nav").contains(document.activeElement))).toBe(true);

    await page.keyboard.press("Escape");
    expect(await page.locator("#mobile-nav").evaluate((dialog) => dialog.open)).toBe(false);
    expect(await page.evaluate(() => document.activeElement.hasAttribute("data-nav-open"))).toBe(true);

    await opener.click();
    await page.locator('#mobile-nav a[href="/menu/"]').click();
    await page.waitForURL("**/menu/");
    await context.close();
  });

  it("uses the full navigation bar on a laptop and marks the current page", async () => {
    const { page, context } = await openPage(browser, `${site.url}/about/`, { width: 1280 });
    expect(await page.locator("[data-nav-open]").isVisible()).toBe(false);
    expect(await page.locator('header nav a[aria-current="page"]').innerText()).toMatch(/about/i);
    await page.locator('header nav a[href="/contact/"]').click();
    await page.waitForURL("**/contact/");
    await context.close();
  });

  it("makes every button and link big enough to tap on a phone", async () => {
    const { page, context } = await openPage(browser, `${site.url}/`, { width: 390, height: 844 });
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("a.btn, button, .icon-button, .chip")]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({ text: element.textContent.trim().slice(0, 30), height: Math.round(element.getBoundingClientRect().height) }))
        .filter((entry) => entry.height < 44));
    expect(small).toEqual([]);
    await context.close();
  });
});

describe("images in the production build", () => {
  // Until the restaurant supplies its own photos, the live site shows the placeholder
  // photos named in content/site.json (content/media/placeholder-*). Nothing else may ship:
  // every image file is the logo, the icon, the logo's leaf, the share image made from the
  // logo, or one size of one of those placeholders. Any other photo fails this test. When
  // real photos replace the placeholders, widen the pattern below to their names.
  it("ships the brand files and the placeholder photos, and no other image", () => {
    const images = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (/\.(jpe?g|png|webp|avif|gif|svg)$/i.test(entry.name)) images.push(relative(BUILD, join(dir, entry.name)).replaceAll("\\", "/"));
      }
    };
    walk(BUILD);
    const brand = ["favicon.svg", "leaf.svg", "media/logo.svg", "media/og-default.png"];
    const placeholder = /^media\/placeholder-(hero|story|location|gallery-[1-5])-\d+\.(avif|webp|jpg)$/;
    expect(images.filter((file) => !brand.includes(file) && !placeholder.test(file))).toEqual([]);
    expect(brand.filter((file) => !images.includes(file))).toEqual([]);
    expect(images.filter((file) => placeholder.test(file)).length).toBeGreaterThan(8);
  });

  it("puts no broken image on any page, and describes every content photo", async () => {
    for (const { path } of PAGES.filter((entry) => !entry.status)) {
      const { page, context } = await openPage(browser, `${site.url}${path}`);
      // Images below the fold load lazily, so ask for each one before judging it.
      const broken = await page.evaluate(async () => {
        const failed = [];
        await Promise.all([...document.images].map(async (image) => {
          image.loading = "eager";
          await image.decode().catch(() => failed.push(image.getAttribute("src")));
        }));
        return failed;
      });
      expect(broken, path).toEqual([]);
      // Dish photos from the menu sit beside the dish's name and are rightly left without
      // alternative text; the photos the content file names must each be described.
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll("main picture img")].filter((image) => !image.alt).map((image) => new URL(image.src).pathname));
      expect(unnamed, path).toEqual([]);
      await context.close();
    }
  });
});
