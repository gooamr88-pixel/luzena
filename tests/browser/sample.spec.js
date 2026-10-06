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
  it("shows the featured items, the photo hero and passes the accessibility scan", async () => {
    const { page, context, problems } = await openPage(browser, `${site.url}/`);
    await page.waitForSelector("[data-featured]:not([hidden]) .menu-item");
    expect(await page.locator("[data-featured-list] .menu-item").count()).toBe(6);
    // Featured items never show the long options list.
    expect(await page.locator("[data-featured-list] details").count()).toBe(0);
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
    await page.fill("#message", "I have two years behind an espresso machine.");
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

  it("explains each missing field, marks it invalid and focuses the first one, without sending anything", async () => {
    const { page, context, requests } = await open((route) => route.fulfill({ status: 200, json: { ok: true } }));
    await page.click("[data-apply-submit]");
    expect(await page.locator("#full_name-error").innerText()).toBe("Enter your full name.");
    expect(await page.locator("#position-error").innerText()).toMatch(/Choose the position/);
    expect(await page.locator("#email-error").innerText()).toMatch(/valid email/);
    expect(await page.locator("#consent-error").innerText()).toMatch(/confirm/);
    expect(await page.locator("#full_name").getAttribute("aria-invalid")).toBe("true");
    expect(await page.locator("#full_name").getAttribute("aria-describedby")).toBe("full_name-error");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("full_name");
    expect(requests).toHaveLength(0);

    // An error clears as soon as the field is corrected.
    await page.fill("#full_name", "Sam Rivera");
    expect(await page.locator("#full_name-error").isHidden()).toBe(true);
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

  it("pre-selects the role when Apply is pressed on a role", async () => {
    const { page, context } = await open((route) => route.fulfill({ status: 200, json: { ok: true } }));
    const role = page.locator("details.position", { hasText: "Pastry Chef" });
    await role.locator("summary").click();
    await role.locator("[data-apply-for]").click();
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
