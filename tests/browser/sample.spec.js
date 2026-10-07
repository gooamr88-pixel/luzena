// The parts of the public site that need data to exist: the menu, the featured strip, the
// gallery viewer and the application form. Run against the sample build, which adds a
// sample menu, sample photos and a sample privacy policy to the real content.
//
// The application form posts to a fake backend address that the test intercepts, so the
// success and failure states are exercised without any server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessibilityViolations, describeViolations, hasHorizontalOverflow, launchBrowser, openPage, serveBuild, VIEWPORT_WIDTHS,
} from "./helpers/site.js";

let site, browser;

beforeAll(async () => {
  site = await serveBuild("demo");
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

describe("the sample build is clearly not production", () => {
  it("carries a banner and blocks search engines on every page", async () => {
    for (const path of ["/", "/menu/", "/careers/"]) {
      const { page, context } = await openPage(browser, `${site.url}${path}`);
      expect(await page.locator(".sample-banner").count(), path).toBe(1);
      expect(await page.locator('meta[name="robots"]').getAttribute("content"), path).toMatch(/noindex/);
      await context.close();
    }
    expect(await (await fetch(`${site.url}/robots.txt`)).text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("still shows the real address and hours, not sample ones", async () => {
    const { page, context } = await openPage(browser, `${site.url}/locations/`);
    expect(await page.locator("main").innerText()).toContain("315 El Cajon Blvd");
    await context.close();
  });
});

describe("menu page with a menu", () => {
  let opened;

  beforeAll(async () => {
    opened = await openPage(browser, `${site.url}/menu/`);
    await opened.page.waitForSelector(".menu-item");
  });

  afterAll(async () => opened?.context.close());

  it("renders every category and item with prices, and no errors", async () => {
    expect(opened.problems).toEqual([]);
    expect(await opened.page.locator("[data-menu] section").count()).toBe(4);
    expect(await opened.page.locator(".menu-item").count()).toBe(12);
    const first = await opened.page.locator(".menu-item").first().innerText();
    expect(first).toContain("Roasted Tomato Soup");
    expect(first).toContain("$9.00");
    expect(await opened.page.locator("[data-menu]").getAttribute("aria-busy")).toBe("false");
  });

  it("marks an out-of-stock item and leaves a market-price item without a price", async () => {
    const unavailable = opened.page.locator(".menu-item", { hasText: "Burrata" });
    expect(await unavailable.innerText()).toMatch(/Unavailable today/i);
    // Stepped back by colour, never by fading the row: opacity cost it its text contrast.
    expect(await unavailable.evaluate((item) => getComputedStyle(item).opacity)).toBe("1");
    expect(await unavailable.locator(".menu-item-name").evaluate((name) => getComputedStyle(name).color)).toBe("rgb(110, 100, 92)");
    const marketPrice = opened.page.locator(".menu-item", { hasText: "Catch of the Day" });
    expect(await marketPrice.locator(".menu-item-price").count()).toBe(0);
    expect(await marketPrice.locator(".menu-item-leader").count()).toBe(0);
  });

  it("lists options behind a disclosure and shows their extra charge", async () => {
    const ribeye = opened.page.locator(".menu-item", { hasText: "Grilled Ribeye" });
    await ribeye.locator("summary").click();
    const text = await ribeye.innerText();
    // The group's name is set in capitals by the stylesheet.
    expect(text).toMatch(/doneness/i);
    expect(text).toContain("Truffle fries (+$6.00)");
  });

  it("jumps to a category from the chips and highlights where the reader is", async () => {
    await opened.page.setViewportSize({ width: 1280, height: 700 });
    await opened.page.locator('[data-menu-nav] a[href^="#menu-"]', { hasText: "Desserts" }).click();
    await opened.page.waitForFunction(() => {
      const current = document.querySelector('[data-menu-nav] a[aria-current="true"]');
      return current && /desserts/i.test(current.textContent);
    });
    const top = await opened.page.locator("[data-menu] section", { hasText: "Dark Chocolate Tart" }).evaluate((section) => section.getBoundingClientRect().top);
    // The heading lands below the sticky header and chip bar, not underneath them.
    expect(top).toBeGreaterThan(100);
    expect(top).toBeLessThan(400);
  });

  it("passes the accessibility scan and fits every screen width", async () => {
    const violations = await accessibilityViolations(opened.page);
    expect(violations, describeViolations(violations)).toEqual([]);
    for (const width of VIEWPORT_WIDTHS) {
      await opened.page.setViewportSize({ width, height: 900 });
      expect(await hasHorizontalOverflow(opened.page), `${width}px`).toBe(false);
    }
  });
});

describe("home page with a menu and photos", () => {
  it("shows the categories, the featured dishes, the photo hero and passes the accessibility scan", async () => {
    const { page, context, problems } = await openPage(browser, `${site.url}/`);
    await page.waitForSelector("[data-featured]:not([hidden]) .dish-card");
    // Six dishes are marked as featured; the home page shows one row of four.
    expect(await page.locator("[data-featured-list] .dish-card").count()).toBe(4);
    const first = page.locator("[data-featured-list] .dish-card").first();
    expect(await first.innerText()).toContain("Roasted Tomato Soup");
    expect(await first.innerText()).toContain("$9.00");
    expect(await first.locator("a").getAttribute("href")).toBe("/menu/#menu-SAMPLECAT0001");
    // Featured dishes never show the long options list.
    expect(await page.locator("[data-featured-list] details").count()).toBe(0);
    // One tile per category, each leading to that category on the menu page.
    expect(await page.locator("[data-categories]:not([hidden]) .category-tile").count()).toBe(4);
    expect(await page.locator(".category-tile").nth(2).innerText()).toMatch(/Desserts\s+2 items/);
    // No sample dish has a photo of its own, so every tile and card shows a default photo.
    // They load lazily, so ask for each one before judging it.
    const failed = await page.evaluate(async () => {
      const broken = [];
      await Promise.all([...document.querySelectorAll(".category-tile img, .dish-card img")].map(async (image) => {
        image.loading = "eager";
        await image.decode().catch(() => broken.push(image.getAttribute("src")));
      }));
      return broken;
    });
    expect(failed).toEqual([]);
    expect(await page.locator(".category-tile img").count()).toBe(4);
    expect(await page.locator(".dish-card img").count()).toBe(4);
    expect(await page.locator(".category-tile img").first().getAttribute("src")).toBe("/media/gallery-1-480.jpg");
    const hero = await page.locator("main section").first().evaluate((section) => ({
      hasPhoto: section.querySelector("picture img") !== null,
      headingColour: getComputedStyle(section.querySelector("h1")).color,
      alt: section.querySelector("picture img")?.alt,
    }));
    expect(hero.hasPhoto).toBe(true);
    expect(hero.headingColour).toBe("rgb(255, 255, 255)");
    expect(hero.alt.length).toBeGreaterThan(5);
    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("gives every photo dimensions and alternative text", async () => {
    const { page, context } = await openPage(browser, `${site.url}/gallery/`);
    const images = await page.evaluate(() => [...document.querySelectorAll("main img")].map((img) => ({
      alt: img.getAttribute("alt"), width: img.getAttribute("width"), height: img.getAttribute("height"), lazy: img.loading,
    })));
    expect(images.length).toBe(6);
    expect(images.every((img) => img.alt && img.width && img.height)).toBe(true);
    await context.close();
  });
});

describe("gallery viewer", () => {
  it("opens, moves with the arrow keys, closes with Escape and returns focus to the photo", async () => {
    const { page, context, problems } = await openPage(browser, `${site.url}/gallery/`);
    const tiles = page.locator("[data-gallery-open]");
    expect(await tiles.count()).toBe(6);

    await tiles.nth(1).focus();
    await page.keyboard.press("Enter");
    const viewer = page.locator("[data-lightbox]");
    expect(await viewer.evaluate((dialog) => dialog.open)).toBe(true);
    expect(await page.locator("[data-lightbox-count]").innerText()).toBe("Photo 2 of 6");
    expect(await page.locator("[data-lightbox-stage] img").count()).toBe(1);

    await page.keyboard.press("ArrowRight");
    expect(await page.locator("[data-lightbox-count]").innerText()).toBe("Photo 3 of 6");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    expect(await page.locator("[data-lightbox-count]").innerText()).toBe("Photo 1 of 6");
    await page.keyboard.press("ArrowLeft");
    expect(await page.locator("[data-lightbox-count]").innerText()).toBe("Photo 6 of 6");

    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);

    await page.keyboard.press("Escape");
    expect(await viewer.evaluate((dialog) => dialog.open)).toBe(false);
    // Focus lands on the photo that was on screen, not on the one that opened the viewer.
    await page.waitForFunction(() => document.activeElement.getAttribute("data-gallery-open") === "5");
    expect(problems).toEqual([]);
    await context.close();
  });
});

// The owner's own photos, chosen in the dashboard. The pages ask the backend which photos to
// show; here the test answers that question in the backend's place.
describe("photos the owner has chosen in the dashboard", () => {
  // Files that the sample build is known to contain, standing in for the owner's uploads.
  const photo = (name, alt) => ({
    src: `/media/${name}-800.jpg`, srcset: `/media/${name}-480.jpg 480w, /media/${name}-800.jpg 800w`,
    width: 800, height: 600, alt,
  });
  const chosen = {
    hero: photo("team", "The owner's own hero photo"),
    story: photo("location", "The owner's own story photo"),
    gallery: ["gallery-1", "gallery-2", "gallery-6", "team", "location", "hero", "gallery-1", "gallery-2", "gallery-6"]
      .map((name, index) => photo(name, `Owner photo ${index + 1}`)),
  };
  const answerWith = (photos, status = 200) => (context) => context.route("**/sample-api/site.json", (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ version: 1, photos }) }));

  it("replaces the hero, the story photo and the home page's row of photos", async () => {
    const { page, context, problems } = await openPage(browser, `${site.url}/`, { prepare: answerWith(chosen) });
    await page.waitForSelector('[data-site-photo="hero"][data-photo-ready]');

    const hero = page.locator('[data-site-photo="hero"] picture');
    // The built photo's sources are gone: a browser would have gone on preferring them.
    expect(await hero.locator("source").count()).toBe(0);
    expect(await hero.locator("img").getAttribute("src")).toBe("/media/team-800.jpg");
    expect(await hero.locator("img").getAttribute("alt")).toBe("The owner's own hero photo");
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-site-photo="hero"] picture img')).opacity === "1");

    const story = page.locator('[data-site-photo="story"] picture');
    expect(await story.locator("source").count()).toBe(0);
    expect(await story.locator("img").getAttribute("src")).toBe("/media/location-800.jpg");

    // Nine photos in the gallery; the home page shows the first eight, each a link to it.
    const strip = page.locator('[data-site-gallery="strip"] > li');
    expect(await strip.count()).toBe(8);
    expect(await strip.first().locator("img").getAttribute("alt")).toBe("Owner photo 1");
    expect(await strip.first().locator("a").getAttribute("href")).toBe("/gallery/");

    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("replaces the story photo on the About page", async () => {
    const { page, context, problems } = await openPage(browser, `${site.url}/about/`, { prepare: answerWith(chosen) });
    await page.waitForFunction(() => document.querySelector('[data-site-photo="story"] img')?.getAttribute("src") === "/media/location-800.jpg");
    expect(await page.locator('[data-site-photo="story"] img').getAttribute("alt")).toBe("The owner's own story photo");
    expect(problems).toEqual([]);
    await context.close();
  });

  it("replaces the whole gallery, and the viewer walks through the owner's photos", async () => {
    const { page, context, problems } = await openPage(browser, `${site.url}/gallery/`, { prepare: answerWith(chosen) });
    await page.waitForFunction(() => document.querySelectorAll("[data-gallery-open]").length === 9);
    const images = await page.evaluate(() => [...document.querySelectorAll("[data-gallery] img")].map((img) => ({
      alt: img.alt, width: img.getAttribute("width"), height: img.getAttribute("height"),
    })));
    expect(images.every((img) => img.alt && img.width === "800" && img.height === "600")).toBe(true);

    await page.locator("[data-gallery-open]").nth(8).click();
    expect(await page.locator("[data-lightbox-count]").innerText()).toBe("Photo 9 of 9");
    expect(await page.locator("[data-lightbox-caption]").innerText()).toBe("Owner photo 9");
    await page.keyboard.press("ArrowRight");
    expect(await page.locator("[data-lightbox-count]").innerText()).toBe("Photo 1 of 9");
    expect(await page.locator("[data-lightbox-stage] img").getAttribute("src")).toBe("/media/gallery-1-800.jpg");

    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("keeps the photos the site was built with when only some have been chosen", async () => {
    const { page, context } = await openPage(browser, `${site.url}/`, {
      prepare: answerWith({ hero: null, story: photo("location", "Only the story"), gallery: [] }),
    });
    await page.waitForSelector('[data-site-photo="hero"][data-photo-ready]');
    expect(await page.locator('[data-site-photo="hero"] picture source').count()).toBeGreaterThan(0);
    expect(await page.locator('[data-site-photo="story"] img').getAttribute("alt")).toBe("Only the story");
    expect(await page.locator('[data-site-gallery="strip"] > li').count()).toBe(6);
    await context.close();
  });

  it("keeps every built photo, and still shows the hero, when the answer is an error", async () => {
    const { page, context, problems } = await openPage(browser, `${site.url}/`, {
      prepare: answerWith(null, 503), allowRequestFailures: [/sample-api\/site\.json/, /status of 503/],
    });
    await page.waitForSelector('[data-site-photo="hero"][data-photo-ready]');
    expect(await page.locator('[data-site-photo="hero"] picture source').count()).toBeGreaterThan(0);
    expect(await page.locator('[data-site-gallery="strip"] > li').count()).toBe(6);
    expect(problems).toEqual([]);
    await context.close();
  });
});

describe("job application form (applications switched on)", () => {
  const API = "https://e2e-project.supabase.co/functions/v1/job-application";

  const open = async (respond) => {
    const opened = await openPage(browser, `${site.url}/careers/`, { allowRequestFailures: [/e2e-project\.supabase\.co/] });
    const requests = [];
    await opened.page.route(API, async (route) => {
      requests.push(route.request());
      await respond(route);
    });
    return { ...opened, requests };
  };

  const fill = async (page) => {
    await page.fill("#full_name", "Sam Rivera");
    await page.selectOption("#position", "Barista");
    await page.fill("#email", "sam@example.test");
    await page.fill("#phone", "+1 619 555 0100");
    await page.selectOption("#employment_type", "part_time");
    await page.selectOption("#start_when", "two_weeks");
    await page.check('input[name="availability"][value="weekday_days"]');
    await page.check('input[name="availability"][value="weekend_days"]');
    await page.selectOption("#experience_level", "1_2");
    await page.fill("#experience", "Two years behind an espresso machine at a busy cafe.");
    await page.selectOption("#work_authorized", "yes");
    await page.fill("#message", "I live nearby and would like to help open the cafe side.");
    await page.check("#consent");
  };

  it("has a labelled control for every field and a link to the privacy policy", async () => {
    const { page, context } = await open((route) => route.fulfill({ status: 200, json: { ok: true } }));
    const unlabelled = await page.evaluate(() =>
      [...document.querySelectorAll("form input, form select, form textarea")]
        .filter((control) => control.name !== "company_website" && control.labels.length === 0)
        .map((control) => control.name));
    expect(unlabelled).toEqual([]);
    expect(await page.locator('form a[href="/privacy/"]').count()).toBe(1);
    expect(await page.locator("#position optgroup").count()).toBe(5);
    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);
    await context.close();
  });

  it("is the form and nothing else: no page header above it, no list of roles below it", async () => {
    const { page, context } = await open((route) => route.fulfill({ status: 200, json: { ok: true } }));
    const box = (selector) => page.locator(selector).first().evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY, left: rect.left, right: rect.right };
    });
    expect(await page.locator("main .page-hero, main aside, main details").count()).toBe(0);
    // One section in <main>, holding one card; the card's head carries the page's title.
    expect(await page.locator("main > *").count()).toBe(1);
    expect(await page.locator(".form-card h1").innerText()).toBe("Join Our Team");
    expect(await page.locator(".form-card").locator("[data-apply-form]").count()).toBe(1);
    const headings = await page.locator("main h2, main h3").evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).length);
    expect(headings).toBe(0);
    // A laptop screen, 1280 x 900: the card starts just under the site's header, the first
    // question is on the first screen, and the card sits in the middle of the page.
    const header = await box(".site-header");
    const card = await box(".form-card");
    expect(card.top - header.bottom).toBeLessThan(90);
    expect((await box("#full_name")).top).toBeLessThan(900);
    expect(Math.abs(card.left - (1280 - card.right))).toBeLessThan(20);
    expect(card.right - card.left).toBeLessThanOrEqual(768);
    // The form is in four numbered parts.
    const parts = (await page.locator("form legend.form-part-title").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
    expect(parts).toEqual(["1 About you", "2 The role", "3 Your experience", "4 A little more"]);
    // After the card comes the site's footer, and nothing else.
    expect((await box(".site-footer")).top - card.bottom).toBeLessThan(90);
    await context.close();
  });

  it("on a phone, starts the questions within the first scroll and keeps every control thumb-sized", async () => {
    const opened = await openPage(browser, `${site.url}/careers/`, { width: 390, height: 844, allowRequestFailures: [/e2e-project\.supabase\.co/] });
    const { page, context } = opened;
    const top = (selector) => page.locator(selector).first().evaluate((node) => node.getBoundingClientRect().top + window.scrollY);
    expect(await top(".form-card h1")).toBeLessThan(400);
    expect(await top("#full_name")).toBeLessThan(844 * 1.2);
    // The send button spans the card, and every control is at least 44px tall.
    const button = await page.locator("[data-apply-submit]").boundingBox();
    expect(button.width).toBeGreaterThan(280);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("form select, form textarea, form input:not([type=checkbox]):not([type=file]):not([name=company_website]), form button, form label.choice")]
        .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().height < 44).map((node) => node.id || node.textContent.trim()));
    expect(small).toEqual([]);
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await hasHorizontalOverflow(page), `${width}px`).toBe(false);
    }
    await context.close();
  });

  // Seen on a phone on the live site: a chosen file's name is kept on one line, and the group
  // of questions around it would not shrink below that line, so the page grew wider than the
  // screen and slid sideways.
  it("keeps the page the width of a phone when a file with a long name is chosen", async () => {
    for (const width of [320, 360, 390]) {
      const opened = await openPage(browser, `${site.url}/careers/`, { width, height: 800, allowRequestFailures: [/e2e-project\.supabase\.co/] });
      const { page, context } = opened;
      await page.setInputFiles("#cv", {
        name: "Curriculum-Vitae-Alexandria-Montgomery-Fitzgerald-2026-final-version.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 test"),
      });
      await page.waitForSelector("[data-file-chosen]:not([hidden])");
      expect(await hasHorizontalOverflow(page), `${width}px`).toBe(false);
      // The row stays inside the card, with the name cut short and Remove still in reach.
      const card = await page.locator(".form-card").boundingBox();
      const row = await page.locator("[data-file-chosen]").boundingBox();
      const remove = await page.locator("[data-file-remove]").boundingBox();
      expect(row.x + row.width, `${width}px row`).toBeLessThanOrEqual(card.x + card.width);
      expect(remove.x + remove.width, `${width}px button`).toBeLessThanOrEqual(width);
      // The name takes two lines at most; the rest of a very long one is cut off.
      const name = page.locator("[data-file-name]");
      expect(await name.evaluate((node) => node.scrollHeight > node.clientHeight), `${width}px name`).toBe(true);
      expect(await name.evaluate((node) => Math.round(node.clientHeight / parseFloat(getComputedStyle(node).lineHeight))), `${width}px lines`).toBe(2);
      // The whole name is still there for anyone who needs it.
      expect(await name.getAttribute("title")).toMatch(/final-version\.pdf$/);
      await context.close();
    }
  });

  it("has its own file control, in English whatever the browser's language, that shows the chosen file", async () => {
    const { page, context } = await open((route) => route.fulfill({ status: 200, json: { ok: true } }));
    // The browser's control would say "No file chosen" in the browser's own language. It is
    // kept for its behaviour and hidden; the words on the page are the site's.
    const native = await page.locator("#cv").boundingBox();
    expect(native.width).toBeLessThanOrEqual(1);
    const zone = page.locator("[data-file-empty]");
    expect(await zone.innerText()).toMatch(/Choose a file\s+or drop it here\s+No file chosen/);
    expect(await page.locator("[data-file-chosen]").isHidden()).toBe(true);

    await page.setInputFiles("#cv", { name: "Sam Rivera CV.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 test") });
    expect(await zone.isHidden()).toBe(true);
    const chosen = page.locator("[data-file-chosen]");
    expect(await chosen.innerText()).toContain("Sam Rivera CV.pdf");
    expect(await chosen.innerText()).toContain("13 bytes");
    expect(await page.locator("#cv-error").isHidden()).toBe(true);

    await chosen.getByRole("button", { name: /Remove/ }).click();
    expect(await zone.isVisible()).toBe(true);
    expect(await page.locator("#cv").evaluate((input) => input.files.length)).toBe(0);

    // A file that cannot be accepted is said to be so as soon as it is chosen.
    await page.setInputFiles("#cv", { name: "holiday.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") });
    expect(await page.locator("#cv-error").innerText()).toMatch(/PDF, DOC or DOCX/);
    expect(await page.locator("#cv").getAttribute("aria-describedby")).toBe("cv-hint cv-error");

    // The keyboard reaches it, and the ring is drawn on the part that can be seen.
    await page.locator("#cv").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const outline = await page.locator("[data-file-chosen]").evaluate((node) => getComputedStyle(node).outlineStyle);
    expect(outline).toBe("solid");
    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);
    await context.close();
  });

  it("explains each missing field, marks it invalid and focuses the first one, without sending anything", async () => {
    const { page, context, requests } = await open((route) => route.fulfill({ status: 200, json: { ok: true } }));
    await page.click("[data-apply-submit]");
    expect(await page.locator("#full_name-error").innerText()).toBe("Enter your full name.");
    expect(await page.locator("#position-error").innerText()).toMatch(/Choose the position/);
    expect(await page.locator("#email-error").innerText()).toMatch(/valid email/);
    expect(await page.locator("#consent-error").innerText()).toMatch(/confirm/);
    expect(await page.locator("#employment_type-error").innerText()).toMatch(/full-time, part-time or either/);
    expect(await page.locator("#start_when-error").innerText()).toMatch(/when you could start/);
    expect(await page.locator("#experience_level-error").innerText()).toMatch(/how much experience/);
    expect(await page.locator("#work_authorized-error").innerText()).toMatch(/authorized to work/);
    // A group of boxes is one question: one message, and every box marked.
    expect(await page.locator("#availability-error").innerText()).toBe("Choose at least one time you could work.");
    expect(await page.locator('input[name="availability"][aria-invalid="true"]').count()).toBe(5);
    // The optional questions raise nothing.
    for (const name of ["experience", "cv", "message"]) expect(await page.locator(`#${name}-error`).isHidden(), name).toBe(true);
    expect(await page.locator("#full_name").getAttribute("aria-invalid")).toBe("true");
    expect(await page.locator("#full_name").getAttribute("aria-describedby")).toBe("full_name-error");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("full_name");
    expect(requests).toHaveLength(0);

    // An error clears as soon as the field is corrected.
    await page.fill("#full_name", "Sam Rivera");
    expect(await page.locator("#full_name-error").isHidden()).toBe(true);
    await page.check('input[name="availability"][value="late_nights"]');
    expect(await page.locator("#availability-error").isHidden()).toBe(true);
    expect(await page.locator('input[name="availability"][aria-invalid="true"]').count()).toBe(0);
    await context.close();
  });

  it("refuses a file that is not a PDF or Word document before uploading it", async () => {
    const { page, context, requests } = await open((route) => route.fulfill({ status: 200, json: { ok: true } }));
    await fill(page);
    await page.setInputFiles("#cv", { name: "photo.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await page.click("[data-apply-submit]");
    expect(await page.locator("#cv-error").innerText()).toMatch(/PDF, DOC or DOCX/);
    expect(requests).toHaveLength(0);
    await context.close();
  });

  it("offers every role in the position list, by department, and a way to name another", async () => {
    const { page, context } = await open((route) => route.fulfill({ status: 200, json: { ok: true } }));
    const groups = await page.locator("#position optgroup").evaluateAll((nodes) => nodes.map((node) => [node.label, node.children.length]));
    expect(groups.map(([label]) => label)).toEqual(["Management", "Kitchen", "Cafe", "Front of House", "Support"]);
    expect(groups.reduce((total, [, count]) => total + count, 0)).toBe(18);
    expect(await page.locator('#position > option[value="Other"]').count()).toBe(1);
    await page.selectOption("#position", "Pastry Chef / Baker");
    expect(await page.locator("#position").inputValue()).toBe("Pastry Chef / Baker");
    await context.close();
  });

  it("sends the application with the CV and shows the confirmation", async () => {
    const { page, context, requests, problems } = await open((route) => route.fulfill({ status: 200, json: { ok: true } }));
    await fill(page);
    await page.setInputFiles("#cv", { name: "cv.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 test") });
    await page.click("[data-apply-submit]");
    await page.waitForSelector("[data-apply-success]:not([hidden])");

    expect(await page.locator("[data-apply-success]").innerText()).toContain("Your application has been received");
    expect(await page.locator("[data-apply-form]").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement.hasAttribute("data-apply-success"))).toBe(true);

    expect(requests).toHaveLength(1);
    expect(requests[0].method()).toBe("POST");
    const body = requests[0].postData();
    expect(body).toContain('name="restaurant"');
    expect(body).toContain("luzena");
    expect(body).toContain('name="position"');
    expect(body).toContain("Barista");
    expect(body).toContain('filename="cv.pdf"');
    expect(body).toContain('name="started_at"');
    // Every answer travels, both availability boxes included, with an id for this visit.
    for (const name of ["full_name", "email", "phone", "employment_type", "start_when", "experience_level", "experience", "work_authorized", "message", "consent"]) {
      expect(body, name).toContain(`name="${name}"`);
    }
    expect(body.match(/name="availability"/g)).toHaveLength(2);
    expect(body).toMatch(/name="submission_id"\r\n\r\n[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    // Nothing about where the application is reported: the form does not know.
    expect(body).not.toMatch(/@gmail|recipient|notify/i);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("shows that it is sending, and sends once however often the button is pressed", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const { page, context, requests } = await open(async (route) => {
      await held;
      await route.fulfill({ status: 200, json: { ok: true } });
    });
    await fill(page);
    const button = page.locator("[data-apply-submit]");
    await button.click();
    await page.waitForFunction(() => document.querySelector("[data-apply-submit]").disabled);
    expect(await button.innerText()).toMatch(/sending/i);
    expect(await page.locator("[data-apply-form]").getAttribute("aria-busy")).toBe("true");
    // Pressing Enter in a field while the first send is on its way must not send a second.
    await page.locator("#full_name").press("Enter");
    release();
    await page.waitForSelector("[data-apply-success]:not([hidden])");
    expect(requests).toHaveLength(1);
    await context.close();
  });

  it("works from start to finish on a phone", async () => {
    const opened = await openPage(browser, `${site.url}/careers/`, { width: 390, height: 844, allowRequestFailures: [/e2e-project\.supabase\.co/] });
    const { page, context, problems } = opened;
    let sent = 0;
    await page.route(API, async (route) => {
      sent += 1;
      await route.fulfill({ status: 200, json: { ok: true } });
    });
    await fill(page);
    // Every control is as wide as the form and tall enough for a thumb.
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll("[data-apply-form] .field-input, [data-apply-form] .choice, [data-apply-submit]")]
        .map((node) => node.getBoundingClientRect()).map((box) => ({ height: Math.round(box.height), right: Math.round(box.right) })));
    expect(boxes.every((box) => box.height >= 44 && box.right <= 390)).toBe(true);
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await page.click("[data-apply-submit]");
    await page.waitForSelector("[data-apply-success]:not([hidden])");
    expect(sent).toBe(1);
    expect(await hasHorizontalOverflow(page)).toBe(false);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("shows the server's message beside the field it is about", async () => {
    const { page, context } = await open((route) => route.fulfill({
      status: 422, json: { error: { code: "validation_failed", message: "Please check the highlighted fields.", fields: { phone: "Phone is not in a valid format." } } },
    }));
    await fill(page);
    await page.click("[data-apply-submit]");
    await page.waitForSelector("#phone-error:not([hidden])");
    expect(await page.locator("#phone-error").innerText()).toBe("Phone is not in a valid format.");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("phone");
    expect(await page.locator("[data-apply-form]").isVisible()).toBe(true);
    await context.close();
  });

  it("keeps what was typed and says so when the server cannot be reached", async () => {
    const { page, context } = await open((route) => route.abort("failed"));
    await fill(page);
    await page.click("[data-apply-submit]");
    await page.waitForSelector("[data-apply-error]:not([hidden])");
    expect(await page.locator("[data-apply-error]").innerText()).toContain("could not reach the server");
    expect(await page.locator("#full_name").inputValue()).toBe("Sam Rivera");
    expect(await page.locator("[data-apply-submit]").isEnabled()).toBe(true);
    expect(await page.locator("[data-apply-submit]").innerText()).toMatch(/send application/i);
    await context.close();
  });

  it("shows a safe message when the server fails, with nothing technical in it", async () => {
    const { page, context } = await open((route) => route.fulfill({
      status: 502, json: { error: { code: "delivery_failed", message: "We could not send your application right now. Please try again later." } },
    }));
    await fill(page);
    await page.click("[data-apply-submit]");
    await page.waitForSelector("[data-apply-error]:not([hidden])");
    const text = await page.locator("[data-apply-error]").innerText();
    expect(text).toBe("We could not send your application right now. Please try again later.");
    await context.close();
  });

  it("fits a phone screen", async () => {
    const { page, context } = await openPage(browser, `${site.url}/careers/`, { width: 360, height: 800 });
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await context.close();
  });
});
