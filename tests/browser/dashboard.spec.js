// The owner dashboard, driven in a real browser: clicking, typing, dialogs, keyboard.
//
// It runs in the dashboard's demo mode, where an in-memory stand-in answers for Supabase
// Auth and the dashboard API. So this file proves the INTERFACE behaves correctly: what is
// shown, when, and what is sent. What the real API then does with a request (permissions,
// Clover writes, conflicts, partial saves) is proven in tests/dashboard.test.js. Neither
// file talks to a real Supabase project or to Clover.
//
// Every test opens a fresh page, so the demo data starts from the same state each time.
import sharp from "sharp";
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

const dashboard = async (hash = "#/", size = {}) => {
  const opened = await openPage(browser, `${site.url}/dashboard/${hash}`, size);
  await opened.page.waitForSelector("main#main h1");
  return opened;
};

const dialog = (page) => page.locator("dialog.d-dialog[open]");
const toast = (page) => page.locator("#toasts > div").last();
const rows = (page) => page.locator("table.d-table tbody tr");
const row = (page, name) => page.locator("table.d-table tbody tr", { hasText: name });
const waitForRows = (page, count) => page.waitForFunction((expected) =>
  document.querySelectorAll("table.d-table tbody tr").length === expected, count);

describe("signing in and out", () => {
  it("opens on the overview with the restaurant's logo and a demo notice", async () => {
    const { page, context, problems } = await dashboard();
    expect(await page.locator("main#main h1").innerText()).toBe("Overview");
    expect(await page.locator("aside img").getAttribute("alt")).toBe("Luzena Restaurant & Cafe");
    expect(await page.locator("body").innerText()).toContain("Demo mode. Sample data only");
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toMatch(/noindex/);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("signs out to the sign-in form, shows nothing behind it, and signs back in", async () => {
    const { page, context } = await dashboard("#/items");
    await waitForRows(page, 12);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForSelector("#password");

    expect(await page.locator("h1").innerText()).toBe("Sign in");
    expect(await page.locator("table").count()).toBe(0);
    expect(await page.locator("aside").count()).toBe(0);
    // A protected address typed by hand still shows only the sign-in form.
    await page.evaluate(() => { location.hash = "#/clover"; });
    await page.waitForTimeout(400);
    expect(await page.locator("h1").innerText()).toBe("Sign in");
    expect(await page.locator("#email").getAttribute("autocomplete")).toBe("username");
    expect(await page.locator("#password").getAttribute("type")).toBe("password");
    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);

    await page.fill("#email", "owner@example.com");
    await page.fill("#password", "a-long-demo-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForSelector("aside nav");
    expect(await page.locator("main#main h1").count()).toBe(1);
    await context.close();
  });

  it("offers a password reset that does not reveal whether an account exists", async () => {
    const { page, context } = await dashboard();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Forgot your password?" }).click();
    await page.fill("#email", "nobody@example.com");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await page.waitForSelector('[role="status"]:not([hidden])');
    expect(await page.locator('[role="status"]').innerText()).toBe("If that address has an account, a reset link is on its way.");
    await context.close();
  });
});

describe("overview", () => {
  it("shows the counts, the connection and recent changes, each linking somewhere useful", async () => {
    const { page, context } = await dashboard();
    await page.waitForSelector('a[href="#/items?availability=unavailable"]');
    const stats = await page.locator("main#main a.d-card").allInnerTexts();
    expect(stats).toHaveLength(6);
    expect(stats.join(" ")).toMatch(/CATEGORIES\s+4/i);
    expect(stats.join(" ")).toMatch(/ITEMS\s+12/i);
    expect(stats.join(" ")).toMatch(/OUT OF STOCK\s+1/i);
    expect(await page.locator("main#main").innerText()).toContain("Connected");

    await page.locator('a[href="#/items?availability=unavailable"]').click();
    await waitForRows(page, 1);
    expect(await rows(page).first().innerText()).toContain("Burrata");
    await context.close();
  });
});

describe("item list", () => {
  it("lists items and narrows them by search, category, stock and sort order", async () => {
    const { page, context, problems } = await dashboard("#/items");
    await waitForRows(page, 12);

    await page.fill('input[type="search"]', "ribeye");
    await waitForRows(page, 1);
    expect(await rows(page).first().innerText()).toContain("Grilled Ribeye");

    await page.fill('input[type="search"]', "desserts");
    await waitForRows(page, 2);

    await page.fill('input[type="search"]', "");
    await waitForRows(page, 12);
    await page.selectOption('select[aria-label="Category"]', { label: "Mains" });
    await waitForRows(page, 4);
    await page.selectOption('select[aria-label="Sort"]', "price:desc");
    await page.waitForFunction(() => document.querySelector("table.d-table tbody tr")?.textContent.includes("Grilled Ribeye"));

    await page.selectOption('select[aria-label="Category"]', "");
    await page.selectOption('select[aria-label="Availability"]', "unavailable");
    await waitForRows(page, 1);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("says so when nothing matches, instead of showing an empty table", async () => {
    const { page, context } = await dashboard("#/items");
    await waitForRows(page, 12);
    await page.fill('input[type="search"]', "zzzz-no-such-dish");
    await page.waitForSelector("text=No items match these filters");
    expect(await page.locator("table").count()).toBe(0);
    await context.close();
  });

  it("changes stock only after the server answers, then shows the confirmed state", async () => {
    const { page, context } = await dashboard("#/items");
    await waitForRows(page, 12);
    const stock = () => page.locator('table button[role="switch"][aria-label="Espresso: in stock"]');
    expect(await stock().getAttribute("aria-checked")).toBe("true");

    // While the request is in flight the switch is disabled and still shows the old state.
    // Pressed and read in one step inside the page, so the answer cannot arrive in between.
    const inFlight = await stock().evaluate((button) => {
      button.click();
      return { disabled: button.disabled, checked: button.getAttribute("aria-checked") };
    });
    expect(inFlight).toEqual({ disabled: true, checked: "true" });

    await page.waitForFunction(() =>
      document.querySelector('table button[aria-label="Espresso: in stock"]')?.getAttribute("aria-checked") === "false");
    expect(await toast(page).innerText()).toMatch(/saved/i);
    await context.close();
  });

  it("hides an item from the website with its own switch", async () => {
    const { page, context } = await dashboard("#/items");
    await waitForRows(page, 12);
    await page.locator('table button[role="switch"][aria-label="Espresso: shown on website"]').click();
    await page.waitForFunction(() =>
      document.querySelector('table button[aria-label="Espresso: shown on website"]')?.getAttribute("aria-checked") === "false");
    await context.close();
  });

  it("asks before archiving, explains the effect, and can restore", async () => {
    const { page, context } = await dashboard("#/items");
    await waitForRows(page, 12);
    await row(page, "Espresso").getByRole("button", { name: "Archive" }).click();

    const text = await dialog(page).innerText();
    expect(text).toContain('Archive "Espresso"?');
    expect(text).toContain("not deleted in Clover");
    // Focus starts on Cancel for a destructive action, and Escape cancels.
    expect(await page.evaluate(() => document.activeElement.textContent)).toBe("Cancel");
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.d-dialog", { state: "detached" });
    expect(await rows(page).count()).toBe(12);

    await row(page, "Espresso").getByRole("button", { name: "Archive" }).click();
    await dialog(page).getByRole("button", { name: "Archive" }).click();
    await waitForRows(page, 11);

    await page.selectOption('select[aria-label="Status"]', "archived");
    await waitForRows(page, 1);
    await row(page, "Espresso").getByRole("button", { name: "Restore" }).click();
    await page.waitForSelector("text=No items match these filters");
    await context.close();
  });

  it("applies a bulk action to the selected items after confirming the count", async () => {
    const { page, context } = await dashboard("#/items");
    await waitForRows(page, 12);
    await page.locator('table input[aria-label="Select Espresso"]').check();
    await page.locator('table input[aria-label="Select House Lemonade"]').check();
    expect(await page.locator("text=2 selected").count()).toBe(1);

    await page.getByRole("button", { name: "Hide from website" }).click();
    expect(await dialog(page).innerText()).toContain("2 items will be hidden from the website.");
    await dialog(page).getByRole("button", { name: "Hide from website" }).click();
    await page.waitForFunction(() =>
      document.querySelector('table button[aria-label="House Lemonade: shown on website"]')?.getAttribute("aria-checked") === "false");
    expect(await page.locator('table button[aria-label="Espresso: shown on website"]').getAttribute("aria-checked")).toBe("false");
    expect(await page.locator("text=2 selected").count()).toBe(0);
    await context.close();
  });
});

describe("item editor", () => {
  const editor = async () => {
    const opened = await dashboard("#/items/SAMPLEITEM005");
    await opened.page.waitForSelector("#name");
    return opened;
  };

  it("labels every field with where it is stored and previews the item as customers see it", async () => {
    const { page, context, problems } = await editor();
    expect(await page.locator("#name").inputValue()).toBe("Grilled Ribeye");
    expect(await page.locator("#price").inputValue()).toBe("38.00");
    const sources = await page.locator(".d-source").allInnerTexts();
    expect(sources.filter((text) => /clover/i.test(text)).length).toBeGreaterThanOrEqual(5);
    expect(sources.filter((text) => /website/i.test(text)).length).toBeGreaterThanOrEqual(4);
    const preview = await page.locator(".preview-surface").innerText();
    expect(preview).toContain("Grilled Ribeye");
    expect(preview).toContain("$38.00");
    expect(problems).toEqual([]);
    await context.close();
  });

  it("updates the preview while typing and tracks unsaved changes", async () => {
    const { page, context } = await editor();
    expect(await page.locator("text=All changes saved.").count()).toBe(1);
    await page.fill("#price", "39.50");
    await page.fill("#description", "Dry aged for 30 days.");
    expect(await page.locator(".preview-surface").innerText()).toContain("$39.50");
    expect(await page.locator(".preview-surface").innerText()).toContain("Dry aged for 30 days.");
    expect(await page.locator("text=You have unsaved changes.").count()).toBe(1);
    await context.close();
  });

  it("asks before leaving with unsaved changes, and stays when asked to", async () => {
    const { page, context } = await editor();
    await page.fill("#price", "41.00");
    await page.locator('aside a[data-nav="#/categories"]').click();

    expect(await dialog(page).innerText()).toContain("Discard unsaved changes?");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    // The address is put back once the dialog has closed, a moment after the press.
    await page.waitForFunction(() => location.hash === "#/items/SAMPLEITEM005");
    expect(await page.locator("main#main h1").innerText()).toBe("Grilled Ribeye");
    expect(new URL(page.url()).hash).toBe("#/items/SAMPLEITEM005");
    expect(await page.locator("#price").inputValue()).toBe("41.00");

    await page.locator('aside a[data-nav="#/categories"]').click();
    await dialog(page).getByRole("button", { name: "Discard changes" }).click();
    await page.waitForFunction(() => document.querySelector("main#main h1")?.textContent === "Categories");
    await context.close();
  });

  it("saves, shows the confirmation, and then lets the owner leave freely", async () => {
    const { page, context } = await editor();
    await page.fill("#price", "39.50");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForSelector(".d-alert-ok");
    expect(await page.locator(".d-alert-ok").innerText()).toMatch(/saved/i);
    expect(await page.locator("text=All changes saved.").count()).toBe(1);

    await page.locator('aside a[data-nav="#/items"]').click();
    await waitForRows(page, 12);
    expect(await dialog(page).count()).toBe(0);
    expect(await row(page, "Grilled Ribeye").innerText()).toContain("$39.50");
    await context.close();
  });

  it("refuses an empty name or a malformed price, next to the field", async () => {
    const { page, context } = await editor();
    await page.fill("#price", "12,345.678");
    expect(await page.locator("#price-error").innerText()).toBe("Enter an amount such as 12.50.");
    expect(await page.locator("#price").getAttribute("aria-invalid")).toBe("true");

    await page.fill("#name", "");
    await page.getByRole("button", { name: "Save changes" }).click();
    expect(await page.locator("#name-error").innerText()).toBe("Enter a name.");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("name");
    expect(await page.locator(".d-alert-ok").count()).toBe(0);
    await context.close();
  });

  it("creates an item and opens it", async () => {
    const { page, context } = await dashboard("#/items/new");
    await page.waitForSelector("#name");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("name");
    await page.getByRole("button", { name: "Create item" }).click();
    expect(await page.locator("#name-error").innerText()).toBe("Enter a name.");

    await page.fill("#name", "Test Dish");
    await page.fill("#price", "7.25");
    await page.locator("label", { hasText: "Starters" }).locator("input").check();
    expect(await page.locator("text=Create the item first, then add a photo.").count()).toBe(1);
    await page.getByRole("button", { name: "Create item" }).click();

    await page.waitForFunction(() => /^#\/items\/DEMOITEM/.test(location.hash));
    await page.waitForFunction(() => document.querySelector("main#main h1")?.textContent === "Test Dish");
    expect(await dialog(page).count()).toBe(0);
    expect(await page.locator("#price").inputValue()).toBe("7.25");
    await context.close();
  });

  it("starts a duplicate from an existing item without touching the original", async () => {
    const { page, context } = await dashboard("#/items/new?from=SAMPLEITEM005");
    await page.waitForSelector("#name");
    expect(await page.locator("main#main h1").innerText()).toBe("Duplicate item");
    expect(await page.locator("#name").inputValue()).toBe("Grilled Ribeye (copy)");
    expect(await page.locator("#price").inputValue()).toBe("38.00");
    await context.close();
  });

  it("explains a missing item and an unknown address", async () => {
    const missing = await openPage(browser, `${site.url}/dashboard/#/items/AAAAAAAAAAAAA`);
    await missing.page.waitForSelector("text=This item does not exist");
    expect(await missing.page.locator('main#main a[href="#/items"]').innerText()).toBe("Back to items");
    await missing.context.close();

    const unknown = await openPage(browser, `${site.url}/dashboard/#/nowhere`);
    await unknown.page.waitForSelector("text=Page not found");
    await unknown.context.close();
  });

  it("passes the accessibility scan", async () => {
    const { page, context } = await editor();
    // The preview is the public site's menu markup, scanned with that site.
    const violations = await accessibilityViolations(page, { exclude: [".preview-surface"] });
    expect(violations, describeViolations(violations)).toEqual([]);
    await context.close();
  });
});

describe("categories", () => {
  const names = (page) => page.locator("main#main ol > li p.font-semibold").allInnerTexts();

  it("reorders with the buttons, saves only when asked, and can be undone first", async () => {
    const { page, context } = await dashboard("#/categories");
    await page.waitForSelector("main#main ol > li");
    expect(await names(page)).toEqual(["Starters", "Mains", "Desserts", "Drinks"]);
    expect(await page.getByRole("button", { name: "Move Starters up" }).isDisabled()).toBe(true);

    await page.getByRole("button", { name: "Move Starters down" }).click();
    expect(await names(page)).toEqual(["Mains", "Starters", "Desserts", "Drinks"]);
    expect(await page.locator("text=The order has changed but is not saved yet.").count()).toBe(1);
    // Keyboard focus follows the row that moved.
    expect(await page.evaluate(() => document.activeElement.getAttribute("aria-label"))).toBe("Move Starters down");

    await page.getByRole("button", { name: "Undo" }).click();
    expect(await names(page)).toEqual(["Starters", "Mains", "Desserts", "Drinks"]);

    await page.getByRole("button", { name: "Move Drinks up" }).click();
    await page.getByRole("button", { name: "Save order" }).click();
    await page.waitForSelector("#toasts > div");
    expect(await names(page)).toEqual(["Starters", "Mains", "Drinks", "Desserts"]);
    expect(await page.locator("text=The order has changed but is not saved yet.").count()).toBe(0);
    await context.close();
  });

  it("adds and renames a category through a dialog that closes with Escape", async () => {
    const { page, context } = await dashboard("#/categories");
    await page.waitForSelector("main#main ol > li");
    await page.getByRole("button", { name: "Add category" }).click();
    expect(await dialog(page).innerText()).toContain("created in Clover");
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.d-dialog", { state: "detached" });

    await page.getByRole("button", { name: "Add category" }).click();
    await dialog(page).locator('input[name="name"]').fill("Specials");
    await dialog(page).getByRole("button", { name: "Create category" }).click();
    await page.waitForSelector("dialog.d-dialog", { state: "detached" });
    expect(await names(page)).toContain("Specials");

    await page.locator("main#main ol > li", { hasText: "Specials" }).getByRole("button", { name: "Rename" }).click();
    await dialog(page).locator('input[name="name"]').fill("Chef's Specials");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await page.waitForSelector("dialog.d-dialog", { state: "detached" });
    expect(await names(page)).toContain("Chef's Specials");
    await context.close();
  });

  it("hides a category on the website and asks before archiving it", async () => {
    const { page, context } = await dashboard("#/categories");
    await page.waitForSelector("main#main ol > li");
    await page.locator('button[role="switch"][aria-label="Drinks: shown on website"]').click();
    await page.waitForSelector("text=Hidden on website");

    await page.locator("main#main ol > li", { hasText: "Desserts" }).getByRole("button", { name: "Archive" }).click();
    expect(await dialog(page).innerText()).toContain("Nothing is deleted in Clover");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    expect(await page.locator("main#main ol > li", { hasText: "Desserts" }).innerText()).not.toContain("Archived");
    await context.close();
  });

  describe("the order of the items in a category", () => {
    const STARTERS = ["Roasted Tomato Soup", "Charred Octopus", "Burrata & Heirloom Tomato", "Crispy Calamari"];
    const notSaved = "text=The order has changed but is not saved yet.";

    it("is reached from the category's row, and lists its items in the website's order", async () => {
      const { page, context, problems } = await dashboard("#/categories");
      await page.waitForSelector("main#main ol > li");
      await page.locator("main#main ol > li", { hasText: "Starters" }).getByRole("link", { name: "Arrange items" }).click();
      await page.waitForSelector("main#main h1:has-text('Item order: Starters')");
      expect(page.url()).toContain("#/categories/SAMPLECAT0001/items");
      expect(await names(page)).toEqual(STARTERS);
      // It says plainly that Clover is not changed, and where it came from.
      expect(await page.locator("main#main").innerText()).toContain("Clover keeps its own order");
      expect(await page.locator('nav[aria-label="Breadcrumb"] a[href="#/categories"]').count()).toBe(1);
      expect(await page.getByRole("button", { name: "Move Roasted Tomato Soup up" }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Move Crispy Calamari down" }).isDisabled()).toBe(true);
      expect(problems).toEqual([]);
      await context.close();
    });

    it("reorders with the buttons, keeps focus on the moved item, saves only when asked, and can be undone first", async () => {
      const { page, context } = await dashboard("#/categories/SAMPLECAT0001/items");
      await page.waitForSelector("main#main ol > li");
      await page.getByRole("button", { name: "Move Roasted Tomato Soup down" }).click();
      expect(await names(page)).toEqual(["Charred Octopus", "Roasted Tomato Soup", "Burrata & Heirloom Tomato", "Crispy Calamari"]);
      expect(await page.locator(notSaved).count()).toBe(1);
      expect(await page.evaluate(() => document.activeElement.getAttribute("aria-label"))).toBe("Move Roasted Tomato Soup down");
      // The keyboard alone carries it on down.
      await page.keyboard.press("Enter");
      expect(await names(page)).toEqual(["Charred Octopus", "Burrata & Heirloom Tomato", "Roasted Tomato Soup", "Crispy Calamari"]);

      await page.getByRole("button", { name: "Undo" }).click();
      expect(await names(page)).toEqual(STARTERS);
      expect(await page.locator(notSaved).count()).toBe(0);

      await page.getByRole("button", { name: "Move Crispy Calamari up" }).click();
      await page.getByRole("button", { name: "Move Crispy Calamari up" }).click();
      await page.getByRole("button", { name: "Move Crispy Calamari up" }).click();
      await page.getByRole("button", { name: "Save order" }).click();
      await page.waitForSelector("#toasts > div");
      expect(await toast(page).innerText()).toContain("Item order saved.");
      const saved = ["Crispy Calamari", "Roasted Tomato Soup", "Charred Octopus", "Burrata & Heirloom Tomato"];
      expect(await names(page)).toEqual(saved);
      expect(await page.locator(notSaved).count()).toBe(0);

      // Leaving and coming back shows the saved order; so does the item list's menu order.
      await page.goto(page.url().replace(/#.*$/, "#/categories"));
      await page.waitForSelector("main#main ol > li");
      await page.goto(page.url().replace(/#.*$/, "#/categories/SAMPLECAT0001/items"));
      await page.waitForSelector("main#main h1:has-text('Item order: Starters')");
      await page.waitForSelector("main#main ol > li");
      expect(await names(page)).toEqual(saved);
      await context.close();
    });

    it("reorders by dragging a row onto another", async () => {
      const { page, context } = await dashboard("#/categories/SAMPLECAT0002/items");
      await page.waitForSelector("main#main ol > li");
      const before = await names(page);
      expect(before).toEqual(["Grilled Ribeye", "Pan-Seared Sea Bass", "Wild Mushroom Risotto", "Catch of the Day"]);
      await page.locator("main#main ol > li", { hasText: "Catch of the Day" })
        .dragTo(page.locator("main#main ol > li", { hasText: "Grilled Ribeye" }), { targetPosition: { x: 40, y: 4 } });
      expect(await names(page)).toEqual(["Catch of the Day", "Grilled Ribeye", "Pan-Seared Sea Bass", "Wild Mushroom Risotto"]);
      expect(await page.locator(notSaved).count()).toBe(1);
      await context.close();
    });

    it("says so for a category that does not exist", async () => {
      const { page, context } = await dashboard("#/categories/NOSUCHCATEGOR/items");
      await page.waitForSelector("text=This category does not exist");
      expect(await page.locator("main#main h1").innerText()).toBe("Item order");
      await context.close();
    });
  });
});

describe("modifiers", () => {
  it("lists groups with their rules and switches a modifier on and off", async () => {
    const { page, context } = await dashboard("#/modifiers");
    await page.waitForSelector("main#main section.d-card");
    expect(await page.locator("main#main section.d-card").count()).toBe(2);
    expect(await page.locator("main#main").innerText()).toContain("Required, choose 1");
    expect(await page.locator("main#main").innerText()).toContain("Optional, up to 2");

    const greens = () => page.locator('button[role="switch"][aria-label="Grilled greens: available"]');
    expect(await greens().getAttribute("aria-checked")).toBe("false");
    await greens().click();
    await page.waitForFunction(() =>
      document.querySelector('button[aria-label="Grilled greens: available"]')?.getAttribute("aria-checked") === "true");
    await context.close();
  });

  it("validates a new group inside the dialog and keeps what was typed", async () => {
    const { page, context } = await dashboard("#/modifiers");
    await page.waitForSelector("main#main section.d-card");
    await page.getByRole("button", { name: "Add modifier group" }).first().click();
    await dialog(page).locator('input[name="name"]').fill("Sauces");
    await dialog(page).locator('input[name="min_required"]').fill("lots");
    await dialog(page).getByRole("button", { name: "Create group" }).click();
    await page.waitForSelector('dialog.d-dialog [role="alert"]:not([hidden])');
    expect(await dialog(page).locator('[role="alert"]').innerText()).toMatch(/whole number/);
    expect(await dialog(page).locator('input[name="name"]').inputValue()).toBe("Sauces");

    await dialog(page).locator('input[name="min_required"]').fill("0");
    await dialog(page).locator('input[name="max_allowed"]').fill("2");
    await dialog(page).getByRole("button", { name: "Create group" }).click();
    await page.waitForSelector("dialog.d-dialog", { state: "detached" });
    expect(await page.locator("main#main section.d-card").count()).toBe(3);

    await page.locator("main#main section.d-card", { hasText: "Sauces" }).getByRole("button", { name: "Add modifier" }).click();
    await dialog(page).locator('input[name="name"]').fill("Garlic sauce");
    await dialog(page).locator('input[name="price"]').fill("0.75");
    await dialog(page).getByRole("button", { name: "Create modifier" }).click();
    await page.waitForSelector("dialog.d-dialog", { state: "detached" });
    expect(await page.locator("main#main section.d-card", { hasText: "Sauces" }).innerText()).toContain("+$0.75");
    await context.close();
  });
});

describe("Clover connection and activity", () => {
  it("shows the connection without any credential, and explains a disconnect before doing it", async () => {
    const { page, context } = await dashboard("#/clover");
    await page.waitForSelector("text=Demo merchant");
    const text = await page.locator("main#main").innerText();
    expect(text).toContain("Sandbox (testing)");
    expect(text).toContain("Stored in Clover:");
    expect(text).not.toMatch(/token|secret/i);

    await page.getByRole("button", { name: "Disconnect" }).click();
    expect(await dialog(page).innerText()).toContain("Nothing is deleted in Clover");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    expect(await page.locator("main#main").innerText()).toContain("Connected");

    await page.getByRole("button", { name: "Sync now" }).click();
    await page.waitForSelector("#toasts > div");
    await context.close();
  });

  it("connects with a merchant API token: checks the input, shows a refusal, and keeps the token nowhere", async () => {
    const { page, context, problems } = await dashboard("#/clover");
    await page.waitForSelector("text=Demo merchant");
    // While connected there is no token form.
    expect(await page.locator("#clover-api-token").count()).toBe(0);

    await page.getByRole("button", { name: "Disconnect" }).click();
    await dialog(page).getByRole("button", { name: "Disconnect" }).click();
    await page.waitForSelector("#clover-api-token");
    expect(await page.locator("main#main").innerText()).toContain("Not connected");
    expect(await page.locator("#clover-api-token").getAttribute("type")).toBe("password");
    expect(await page.locator("#clover-api-token").getAttribute("autocomplete")).toBe("off");
    expect(await accessibilityViolations(page), describeViolations(await accessibilityViolations(page))).toEqual([]);

    const submit = page.getByRole("button", { name: "Connect with this token" });
    const alert = page.locator("form [role=alert]");

    await page.fill("#clover-merchant-id", "too-short");
    await page.fill("#clover-api-token", "demo-token-0000-0000-0000");
    await submit.click();
    expect(await alert.innerText()).toBe("The merchant ID is 13 letters and digits.");

    await page.fill("#clover-merchant-id", "demomerchant1"); // typed in lower case
    await page.fill("#clover-api-token", "short");
    await submit.click();
    expect(await alert.innerText()).toBe("Paste the whole API token.");

    // A token Clover refuses: the reason is shown and the field is emptied.
    await page.fill("#clover-api-token", "wrong-token-0000-0000-0000");
    await submit.click();
    await page.waitForFunction(() => document.querySelector("form [role=alert]")?.textContent.includes("did not accept"));
    expect(await page.inputValue("#clover-api-token")).toBe("");
    expect(await page.locator("main#main").innerText()).toContain("Not connected");

    // An accepted token: connected, the form is gone, and the token is not on the page,
    // in the address or in the browser's storage.
    const token = "demo-token-0000-0000-0000";
    await page.fill("#clover-api-token", token);
    await submit.click();
    await page.waitForSelector("#clover-api-token", { state: "detached" });
    expect(await page.locator("main#main").innerText()).toContain("DEMOMERCHANT1");
    expect(await page.locator("main#main").innerText()).toContain("Connected");
    expect(await page.content()).not.toContain(token);
    expect(page.url()).not.toContain(token);
    const stored = await page.evaluate(() => JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }]));
    expect(stored).not.toContain(token);
    expect(problems.filter((problem) => !/400/.test(problem))).toEqual([]);
    await context.close();
  });

  it("records changes in the activity log", async () => {
    const { page, context } = await dashboard("#/items/SAMPLEITEM005");
    await page.waitForSelector("#price");
    await page.fill("#price", "40.00");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForSelector(".d-alert-ok");
    await page.locator('aside a[data-nav="#/activity"]').click();
    await page.waitForSelector("table.d-table tbody tr");
    const log = await page.locator("table.d-table tbody").innerText();
    expect(log).toContain("Item updated");
    expect(log).toContain("owner@example.com");
    await context.close();
  });
});

describe("job applications", () => {
  const OMAR = "00000000-0000-4000-8000-000000000004";
  const daysAgo = (days) => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };

  it("lists every application, newest first, and counts the new ones in the sidebar", async () => {
    const { page, context, problems } = await dashboard("#/applications");
    await waitForRows(page, 6);
    expect(await page.locator("main#main h1").innerText()).toBe("Job applications");
    const names = await page.locator("table.d-table tbody th a").allInnerTexts();
    expect(names).toEqual(["Maya Thompson", "Daniel Ortiz", "Priya Nair", "Omar Haddad", "Lena Fischer", "Chris Wallace"]);
    const first = await rows(page).first().innerText();
    expect(first).toContain("Barista");
    expect(first).toContain("New");
    expect(first).toContain("CV");
    expect(await page.locator('aside a[data-nav="#/applications"] .d-nav-count').innerText()).toMatch(/^2/);
    expect(await page.locator('.d-pill[aria-pressed="true"]').innerText()).toMatch(/All\s*6/);
    // The list is for finding an application. Contact details are on the application itself.
    expect(await page.locator("main#main").innerText()).not.toMatch(/@example\.test|555 01/);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("searches, and filters by status, position and date", async () => {
    const { page, context } = await dashboard("#/applications");
    await waitForRows(page, 6);

    await page.fill("#filter-search", "ortiz");
    await waitForRows(page, 1);
    expect(await rows(page).first().innerText()).toContain("Daniel Ortiz");
    // Found by email address too, though the list does not show it.
    await page.fill("#filter-search", "priya.nair@example");
    await page.waitForFunction(() => document.querySelector("table.d-table tbody tr")?.textContent.includes("Priya Nair"));
    expect(await rows(page).count()).toBe(1);
    await page.fill("#filter-search", "");
    await waitForRows(page, 6);

    await page.locator(".d-pill", { hasText: "Interview" }).click();
    await waitForRows(page, 1);
    expect(await rows(page).first().innerText()).toContain("Omar Haddad");
    expect(await page.locator('.d-pill[aria-pressed="true"]').innerText()).toMatch(/Interview\s*1/);
    await page.locator(".d-pill", { hasText: "All" }).click();
    await waitForRows(page, 6);

    await page.selectOption("#filter-position", "Barista");
    await waitForRows(page, 1);
    expect(await rows(page).first().innerText()).toContain("Maya Thompson");
    await page.selectOption("#filter-position", "");
    await waitForRows(page, 6);

    // Applied in the last three days: four of the six.
    await page.fill("#filter-from", daysAgo(3));
    await waitForRows(page, 4);
    await page.fill("#filter-to", daysAgo(2));
    await page.waitForFunction(() => document.querySelectorAll("table.d-table tbody tr").length < 4);
    expect(await page.locator("table.d-table tbody").innerText()).not.toContain("Maya Thompson");

    await page.getByRole("button", { name: "Clear filters" }).click();
    await waitForRows(page, 6);
    expect(await page.locator("#filter-from").inputValue()).toBe("");

    // Nothing matching says so, and offers nothing misleading.
    await page.fill("#filter-search", "nobody-of-that-name");
    await page.waitForSelector("text=No applications match these filters");
    await context.close();
  });

  it("opens an application with every answer, the contact details and its history", async () => {
    const { page, context, problems } = await dashboard("#/applications");
    await waitForRows(page, 6);
    await row(page, "Omar Haddad").getByRole("link", { name: /Open/ }).click();
    await page.waitForFunction(() => document.querySelector("main#main h1")?.textContent === "Omar Haddad");
    expect(new URL(page.url()).hash).toBe(`#/applications/${OMAR}`);

    const text = await page.locator("main#main").innerText();
    for (const expected of [
      "Head Chef", "Full-time", "Weekday evenings, Weekend evenings", "Within a month", "More than 5 years",
      "Twelve years in Mediterranean kitchens", "The applicant did not write an introduction.",
      "omar.haddad@example.test", "+1 619 555 0114", "Omar-Haddad-CV.docx", "47 kB",
    ]) expect(text, expected).toContain(expected);
    expect(await page.locator('main#main a[href="mailto:omar.haddad@example.test"]').count()).toBe(1);
    expect(await page.locator('main#main a[href="tel:+16195550114"]').count()).toBe(1);

    // Newest first: the interview, then the download, the shortlisting, the email, the arrival.
    const history = await page.locator(".d-timeline > li").allInnerTexts();
    expect(history).toHaveLength(5);
    expect(history[0]).toContain("Status changed from Shortlisted to Interview");
    expect(history[0]).toContain("Interview on Thursday at 3 PM.");
    expect(history[0]).toContain("by owner@example.com");
    expect(history[1]).toContain("CV downloaded");
    expect(history[4]).toContain("Application received");
    expect(problems).toEqual([]);
    await context.close();
  });

  it("changes the status with a note, and records it in the history, the list and the activity log", async () => {
    const { page, context } = await dashboard(`#/applications/${OMAR}`);
    await page.waitForSelector("#application-status");
    const save = page.getByRole("button", { name: "Update status" });
    expect(await save.isDisabled()).toBe(true);

    await page.selectOption("#application-status", "hired");
    await page.fill("#application-note", "Offer accepted. Starts on the 1st.");
    await save.click();
    await page.waitForFunction(() => document.querySelector(".d-timeline > li")?.textContent.includes("to Hired"));
    expect(await toast(page).innerText()).toMatch(/status changed/i);
    expect(await page.locator("main#main header .d-badge").innerText()).toBe("Hired");
    const latest = await page.locator(".d-timeline > li").first().innerText();
    expect(latest).toContain("Status changed from Interview to Hired");
    expect(latest).toContain("Offer accepted. Starts on the 1st.");
    expect(await page.locator("#application-status").inputValue()).toBe("hired");

    // A note on its own, without moving the application.
    await page.fill("#application-note", "Paperwork sent.");
    await page.getByRole("button", { name: "Add note" }).click();
    await page.waitForFunction(() => document.querySelector(".d-timeline > li")?.textContent.includes("Paperwork sent."));
    expect(await page.locator(".d-timeline > li").first().innerText()).toContain("Note added");

    await page.locator('aside a[data-nav="#/applications"]').click();
    await waitForRows(page, 6);
    expect(await row(page, "Omar Haddad").innerText()).toContain("Hired");
    expect(await page.locator(".d-pill", { hasText: "Hired" }).innerText()).toMatch(/Hired\s*2/);

    await page.locator('aside a[data-nav="#/activity"]').click();
    await page.waitForSelector("table.d-table tbody tr");
    const log = await page.locator("table.d-table tbody").innerText();
    expect(log).toContain("Job application status changed");
    // The activity log says an application moved. It does not say whose.
    expect(log).not.toContain("Omar");
    await context.close();
  });

  it("moves a new application on, and the sidebar count follows", async () => {
    const { page, context } = await dashboard("#/applications/00000000-0000-4000-8000-000000000001");
    await page.waitForSelector("#application-status");
    const count = page.locator('aside a[data-nav="#/applications"] .d-nav-count');
    await page.waitForFunction(() => document.querySelector('aside [data-new-applications]')?.textContent.startsWith("2"));
    await page.selectOption("#application-status", "reviewing");
    await page.getByRole("button", { name: "Update status" }).click();
    await page.waitForFunction(() => document.querySelector('aside [data-new-applications]')?.textContent.startsWith("1"));
    expect(await count.innerText()).toMatch(/^1/);
    await context.close();
  });

  it("downloads the CV as a file through the signed-in session, and records the download", async () => {
    const { page, context, problems } = await dashboard(`#/applications/${OMAR}`);
    await page.waitForSelector("#application-status");
    const before = await page.locator(".d-timeline > li").count();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download CV" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("Omar-Haddad-CV.docx");
    // It is handed over as a file made in the page, not as an address anyone could open.
    expect(download.url()).toMatch(/^blob:/);
    await page.waitForFunction((count) => document.querySelectorAll(".d-timeline > li").length === count + 1, before);
    expect(await page.locator(".d-timeline > li").first().innerText()).toContain("CV downloaded");
    expect(await page.locator('main#main a[href*="cv"], main#main a[download]').count()).toBe(0);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("says when there is no CV, and when the notification email did not go out", async () => {
    const { page, context } = await dashboard("#/applications/00000000-0000-4000-8000-000000000006");
    await page.waitForSelector("#application-status");
    const text = await page.locator("main#main").innerText();
    expect(text).toContain("No CV was uploaded with this application.");
    expect(text).toContain("The notification email for this application could not be sent.");
    expect(text).toContain("Notification email could not be sent");
    expect(text).toMatch(/Authorized to work in the US\s+No/);
    expect(await page.getByRole("button", { name: "Download CV" }).count()).toBe(0);
    await context.close();
  });

  it("deletes an application for good, after asking, when the applicant wants their details removed", async () => {
    const { page, context } = await dashboard("#/applications/00000000-0000-4000-8000-000000000003");
    await page.waitForSelector("#application-status");
    await page.getByRole("button", { name: "Delete application" }).click();
    expect(await dialog(page).innerText()).toContain("Delete Priya Nair's application?");
    expect(await dialog(page).innerText()).toContain("This cannot be undone.");
    // The safe answer has the focus, and takes nothing away.
    expect(await page.evaluate(() => document.activeElement.textContent)).toBe("Cancel");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    expect(await page.locator("main#main h1").innerText()).toBe("Priya Nair");

    await page.getByRole("button", { name: "Delete application" }).click();
    await dialog(page).getByRole("button", { name: "Delete for good" }).click();
    await page.waitForFunction(() => document.querySelector("main#main h1")?.textContent === "Job applications");
    await waitForRows(page, 5);
    expect(await page.locator("table.d-table tbody").innerText()).not.toContain("Priya Nair");
    expect(await page.locator(".d-pill", { hasText: "All" }).innerText()).toMatch(/All\s*5/);
    await context.close();
  });

  it("explains an application that is no longer there, and an address that is not one", async () => {
    const { page, context } = await dashboard("#/applications/00000000-0000-4000-8000-00000000ffff");
    await page.waitForSelector("text=This application does not exist");
    await page.evaluate(() => { location.hash = "#/applications/not-an-id"; });
    await page.waitForSelector("text=Page not found");
    await context.close();
  });

  it("keeps no applicant's details in the browser after the page is left", async () => {
    const { page, context } = await dashboard(`#/applications/${OMAR}`);
    await page.waitForSelector("#application-status");
    await page.locator('aside a[data-nav="#/items"]').click();
    await waitForRows(page, 12);
    const kept = await page.evaluate(() => JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }, document.cookie]));
    expect(kept).not.toMatch(/omar|haddad|example\.test/i);
    expect(await page.locator("body").innerText()).not.toMatch(/omar/i);
    await context.close();
  });
});

// The website's own photos. In demo mode a chosen photo is resized in the browser exactly
// as it will be for real, and then shown from the browser's memory instead of being uploaded.
describe("website photos", () => {
  let wide, tall;
  const section = (page, slot) => page.locator(`section[aria-labelledby="photos-${slot}"]`);
  const order = (page) => page.evaluate(() =>
    [...document.querySelectorAll('[data-move$=":earlier"]')].map((button) => button.dataset.move.split(":")[0]));

  beforeAll(async () => {
    const picture = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();
    wide = { name: "IMG_2041.jpg", mimeType: "image/jpeg", buffer: await picture(2400, 1500, "#b98a4e") };
    tall = { name: "IMG_2042.jpg", mimeType: "image/jpeg", buffer: await picture(900, 1200, "#3e5a47") };
  });

  it("opens from the sidebar showing the photos the website started with", async () => {
    const { page, context, problems } = await dashboard();
    await page.locator('aside a[data-nav="#/photos"]').click();
    await page.waitForSelector("#photo-gallery");
    expect(await page.locator("main#main h1").innerText()).toBe("Website photos");
    expect(await page.locator('aside a[data-nav="#/photos"]').getAttribute("aria-current")).toBe("page");

    for (const slot of ["hero", "story"]) {
      expect(await section(page, slot).locator(".d-badge").innerText()).toBe("Starting photo");
      expect(await section(page, slot).locator(".d-photo-frame img").getAttribute("src")).toMatch(/^\/media\/.+\.jpg$/);
      expect(await section(page, slot).getByText("Choose a photo").count()).toBe(1);
    }
    expect(await section(page, "gallery").innerText()).toContain("0 of 24");
    expect(await section(page, "gallery").innerText()).toContain("showing the photos the website started with");
    expect(await section(page, "gallery").locator(".d-photo-frame img").count()).toBe(6);
    // Every starting photo is a file that is really there.
    const broken = await page.evaluate(async () => {
      const failed = [];
      await Promise.all([...document.querySelectorAll("main#main img")].map(async (image) => {
        image.loading = "eager";
        await image.decode().catch(() => failed.push(image.getAttribute("src")));
      }));
      return failed;
    });
    expect(broken).toEqual([]);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("replaces the home page photo, asks for a description, and goes back to the starting photo", async () => {
    const { page, context, problems } = await dashboard("#/photos");
    await page.waitForSelector("#photo-hero");
    await page.setInputFiles("#photo-hero", wide);
    await page.waitForSelector('section[aria-labelledby="photos-hero"] .d-badge-ok');

    const hero = section(page, "hero");
    expect(await hero.locator(".d-badge-ok").innerText()).toBe("Your photo");
    expect(await hero.locator(".d-photo-frame img").getAttribute("src")).toMatch(/^blob:/);
    expect(await hero.getByText("Replace photo").count()).toBe(1);
    // The story photo is untouched.
    expect(await section(page, "story").locator(".d-badge").innerText()).toBe("Starting photo");

    // A new photo has no description yet, and says so.
    expect(await hero.locator("label.d-label").innerText()).toMatch(/Description\s*Missing/);
    const save = hero.getByRole("button", { name: "Save" });
    expect(await save.isDisabled()).toBe(true);
    await page.fill("#alt-hero", "The dining room at dusk");
    await save.click();
    await page.waitForFunction(() => !document.querySelector('section[aria-labelledby="photos-hero"] label.d-label .d-badge'));
    expect(await page.inputValue("#alt-hero")).toBe("The dining room at dusk");
    expect(await hero.locator(".d-photo-frame img").getAttribute("alt")).toBe("The dining room at dusk");

    // The change is in the activity log, by where the photo is and not by a file's name.
    await page.locator('aside a[data-nav="#/activity"]').click();
    await page.waitForSelector("table.d-table tbody tr");
    expect(await rows(page).first().innerText()).toMatch(/Website photo changed\s+Home page photo/);
    await page.locator('aside a[data-nav="#/photos"]').click();
    await page.waitForSelector("#alt-hero");

    await section(page, "hero").getByRole("button", { name: "Use the starting photo" }).click();
    expect(await dialog(page).innerText()).toContain("Go back to the starting photo?");
    expect(await page.evaluate(() => document.activeElement.textContent)).toBe("Cancel");
    await dialog(page).getByRole("button", { name: "Remove my photo" }).click();
    await page.waitForFunction(() =>
      document.querySelector('section[aria-labelledby="photos-hero"] .d-badge')?.textContent === "Starting photo");
    expect(await section(page, "hero").locator(".d-photo-frame img").getAttribute("src")).toMatch(/^\/media\//);
    expect(await page.locator("#alt-hero").count()).toBe(0);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("sends a photo in two sizes with its real dimensions, and nothing of the file's own name", async () => {
    const { page, context } = await dashboard("#/photos");
    await page.waitForSelector("#photo-story");
    // What the page hands to the API, read before the demo answers.
    await page.evaluate(() => {
      const append = FormData.prototype.append;
      window.sent = {};
      FormData.prototype.append = function (name, value, ...rest) {
        window.sent[name] = value instanceof File ? { name: value.name, type: value.type, size: value.size } : value;
        return append.call(this, name, value, ...rest);
      };
    });
    await page.setInputFiles("#photo-story", wide);
    await page.waitForSelector('section[aria-labelledby="photos-story"] .d-badge-ok');
    const sent = await page.evaluate(() => window.sent);
    expect(sent.slot).toBe("story");
    // 2400 x 1500 becomes 1600 x 1000, with a 640-wide copy for phones.
    expect([sent.width, sent.height, sent.small_width]).toEqual(["1600", "1000", "640"]);
    expect(sent.file.name).toMatch(/^photo\.(webp|jpg)$/);
    expect(sent.file_small.name).toMatch(/^photo-small\.(webp|jpg)$/);
    expect(sent.file.size).toBeLessThanOrEqual(1024 * 1024);
    expect(JSON.stringify(sent)).not.toContain("IMG_2041");
    await context.close();
  });

  it("builds a gallery: several photos at once, reordered, described and removed", async () => {
    const { page, context, problems } = await dashboard("#/photos");
    await page.waitForSelector("#photo-gallery");
    await page.setInputFiles("#photo-gallery", [wide, tall, { ...wide, name: "third.jpg" }]);
    await page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="photos-gallery"] ol > li').length === 3);

    const gallery = section(page, "gallery");
    expect(await gallery.innerText()).toContain("3 of 24");
    // The starting photos are no longer offered: the owner's gallery takes their place.
    expect(await gallery.innerText()).not.toContain("started with");
    expect(await gallery.getByRole("button", { name: "Move photo 1 earlier" }).isDisabled()).toBe(true);
    expect(await gallery.getByRole("button", { name: "Move photo 3 later" }).isDisabled()).toBe(true);

    const before = await order(page);
    await gallery.getByRole("button", { name: "Move photo 3 earlier" }).click();
    await page.waitForFunction((moved) => document.querySelectorAll('[data-move$=":earlier"]')[1]?.dataset.move.startsWith(moved), before[2]);
    expect(await order(page)).toEqual([before[0], before[2], before[1]]);
    // The keyboard stays on the photo that moved.
    expect(await page.evaluate(() => document.activeElement.dataset.move)).toBe(`${before[2]}:earlier`);
    await page.keyboard.press("Enter");
    await page.waitForFunction((moved) => document.querySelector('[data-move$=":earlier"]')?.dataset.move.startsWith(moved), before[2]);
    // It is first now, so "earlier" is switched off and the focus is on "later".
    expect(await page.evaluate(() => document.activeElement.dataset.move)).toBe(`${before[2]}:later`);

    await page.fill(`#alt-${before[2]}`, "Grilled chicken with rice");
    await gallery.locator("ol > li").first().getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="photos-gallery"] ol img').alt === "Grilled chicken with rice");

    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);

    await gallery.getByRole("button", { name: "Remove photo 2" }).click();
    expect(await dialog(page).innerText()).toContain("Remove this photo from the gallery?");
    await dialog(page).getByRole("button", { name: "Remove photo" }).click();
    await page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="photos-gallery"] ol > li').length === 2);
    expect(await order(page)).toEqual([before[2], before[1]]);
    expect(await gallery.innerText()).toContain("2 of 24");
    expect(problems).toEqual([]);
    await context.close();
  });

  it("lists the menu's categories with the photo each tile shows, in the website's order", async () => {
    const { page, context, problems } = await dashboard("#/photos");
    await page.waitForSelector('section[aria-labelledby="photos-categories"] li[data-category]');
    const cards = section(page, "categories").locator("li[data-category]");
    expect(await cards.count()).toBe(4);
    expect(await cards.locator("h3").allInnerTexts()).toEqual(["Starters", "Mains", "Desserts", "Drinks"]);
    // Nothing chosen yet: each shows a starting photo, and its place on the home page.
    expect(await cards.locator(".d-badge").allInnerTexts()).toEqual(["Starting photo", "Starting photo", "Starting photo", "Starting photo"]);
    expect(await cards.first().locator(".d-photo-frame").innerText()).toMatch(/^1/);
    const photos = await cards.locator(".d-photo-frame img").evaluateAll((images) => images.map((image) => image.getAttribute("src")));
    expect(photos.every((src) => /^\/media\/.+\.jpg$/.test(src))).toBe(true);
    // Different starting photos, as on the home page, not one repeated.
    expect(new Set(photos).size).toBe(4);
    // Each file button says which category it is for.
    expect(await cards.first().locator("label.d-btn").innerText()).toMatch(/Choose a photo\s*for Starters/);
    expect(await section(page, "categories").locator('a[href="#/categories"]').count()).toBe(1);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("sets a category's photo, small enough for a tile, and goes back to the automatic one", async () => {
    const { page, context, problems } = await dashboard("#/photos");
    await page.waitForSelector('section[aria-labelledby="photos-categories"] li[data-category]');
    await page.evaluate(() => {
      const append = FormData.prototype.append;
      window.sent = {};
      FormData.prototype.append = function (name, value, ...rest) {
        window.sent[name] = value instanceof File ? { name: value.name, type: value.type, size: value.size } : value;
        return append.call(this, name, value, ...rest);
      };
    });
    const card = section(page, "categories").locator("li[data-category]", { hasText: "Mains" });
    await card.locator('input[type="file"]').setInputFiles(wide);
    await page.waitForFunction(() => [...document.querySelectorAll("li[data-category]")]
      .find((item) => item.textContent.includes("Mains"))?.querySelector(".d-badge-ok"));

    expect(await card.locator(".d-badge-ok").innerText()).toBe("Your photo");
    expect(await card.locator(".d-photo-frame img").getAttribute("src")).toMatch(/^blob:/);
    // The other categories are untouched.
    expect(await section(page, "categories").locator(".d-badge-ok").count()).toBe(1);
    // One file, re-encoded under the page's own name for it.
    const sent = await page.evaluate(() => window.sent);
    expect(sent.file.name).toMatch(/^photo\.(webp|jpg)$/);
    expect(JSON.stringify(sent)).not.toContain("IMG_2041");
    // 2400 x 1500 is brought down to 960 on its longer side: a tile needs no more.
    const size = await card.locator(".d-photo-frame img").evaluate(async (image) => {
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
    expect(size).toEqual([960, 600]);

    await page.locator('aside a[data-nav="#/activity"]').click();
    await page.waitForSelector("table.d-table tbody tr");
    expect(await rows(page).first().innerText()).toContain("Category photo changed");
    await page.locator('aside a[data-nav="#/photos"]').click();
    await page.waitForSelector('section[aria-labelledby="photos-categories"] .d-badge-ok');

    const again = section(page, "categories").locator("li[data-category]", { hasText: "Mains" });
    expect(await again.locator("label.d-btn").innerText()).toMatch(/Replace\s*for Mains/);
    await again.getByRole("button", { name: "Remove the photo of Mains" }).click();
    expect(await dialog(page).innerText()).toContain("Remove the photo of Mains?");
    expect(await page.evaluate(() => document.activeElement.textContent)).toBe("Cancel");
    await dialog(page).getByRole("button", { name: "Remove my photo" }).click();
    await page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="photos-categories"] .d-badge-ok').length === 0);
    expect(await again.locator(".d-photo-frame img").getAttribute("src")).toMatch(/^\/media\//);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("refuses a file that is not a photo and changes nothing", async () => {
    const { page, context } = await dashboard("#/photos");
    await page.waitForSelector("#photo-hero");
    await page.setInputFiles("#photo-hero", { name: "notes.png", mimeType: "image/png", buffer: Buffer.from("This is not a photo.") });
    await page.waitForSelector('#toasts [role="alert"]');
    expect(await toast(page).innerText()).toBe("This file could not be read as a photo.");
    expect(await section(page, "hero").locator(".d-badge").innerText()).toBe("Starting photo");
    // The button is ready for another try.
    expect(await page.locator("#photo-hero").isDisabled()).toBe(false);
    expect(await section(page, "hero").getByText("Choose a photo").count()).toBe(1);
    await context.close();
  });

  it("fits a phone with photos in the gallery, with controls big enough for a thumb", async () => {
    const { page, context } = await dashboard("#/photos", { width: 360, height: 800 });
    await page.waitForSelector("#photo-gallery");
    await page.setInputFiles("#photo-gallery", [wide, tall]);
    await page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="photos-gallery"] ol > li').length === 2);
    for (const width of [360, 390, 768]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(300);
      expect(await hasHorizontalOverflow(page), `${width}px`).toBe(false);
    }
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("main#main button, main#main label.d-btn, main#main input[type=text]")]
        .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().height < 36).length);
    expect(small).toBe(0);
    await context.close();
  });
});

// Menu labels: the restaurant's own vocabulary, and which dishes carry which.
describe("menu labels", () => {
  const SPICY = "10000000-0000-4000-8000-000000000001";
  const VEGETARIAN = "10000000-0000-4000-8000-000000000002";
  const labelRows = (page) => page.locator('section[aria-labelledby="labels-title"] ol > li[data-label]');
  const names = (page) => labelRows(page).locator("p.font-semibold > span.break-words").allInnerTexts();
  const labelsPage = async (size = {}) => {
    const opened = await dashboard("#/labels", size);
    await opened.page.waitForSelector('section[aria-labelledby="labels-title"] ol > li[data-label]');
    return opened;
  };

  it("lists the starting labels with their icons, on no dish, and says nothing is labelled automatically", async () => {
    const { page, context, problems } = await labelsPage();
    expect(await page.locator("main#main h1").innerText()).toBe("Labels and allergy notice");
    expect(await names(page)).toEqual(["Spicy", "Vegetarian", "Vegan", "Contains Nuts", "Contains Dairy", "Contains Gluten", "Popular", "New", "Chef's Choice"]);
    expect(await labelRows(page).locator("svg[aria-hidden=true]").first().count()).toBe(1);
    expect((await labelRows(page).first().innerText())).toContain("On no dish yet");
    const text = await page.locator('section[aria-labelledby="labels-title"]').innerText();
    expect(text).toContain("A label is shown only on the dishes you tick it for.");
    expect(text).toContain("nothing is worked out from a dish's name");
    expect(problems).toEqual([]);
    await context.close();
  });

  it("adds a label with a name, a description and an icon chosen from the set, and refuses a name already used", async () => {
    const { page, context } = await labelsPage();
    await page.getByRole("button", { name: "Add a label" }).click();
    expect(await page.evaluate(() => document.activeElement.id)).toBe("label-name-new");
    // The icons are a group of radio buttons, each named.
    const choices = page.locator('[data-label-form="new"] .d-icon-choice');
    expect(await choices.count()).toBe(18);
    expect(await choices.locator("input").first().getAttribute("type")).toBe("radio");
    expect(await choices.nth(12).innerText()).toBe("Seal");

    await page.fill("#label-name-new", "Spicy");
    await page.getByRole("button", { name: "Add label", exact: true }).click();
    await page.waitForSelector('[data-label-form="new"] [role=alert]:not([hidden])');
    expect(await page.locator('[data-label-form="new"] [role=alert]').innerText()).toBe("There is already a label with this name.");
    // What was typed is still there to be corrected.
    expect(await page.inputValue("#label-name-new")).toBe("Spicy");

    await page.fill("#label-name-new", "Halal");
    await page.fill("#label-description-new", "Prepared to halal standards.");
    await choices.nth(12).click();
    await page.getByRole("button", { name: "Add label", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("li[data-label]").length === 10);
    expect((await names(page)).at(-1)).toBe("Halal");
    expect(await labelRows(page).last().innerText()).toContain("Prepared to halal standards.");
    await context.close();
  });

  it("renames a label, switches it off and on, moves it with the keyboard, and deletes it after asking", async () => {
    const { page, context, problems } = await labelsPage();
    await labelRows(page).first().getByRole("button", { name: "Edit Spicy" }).click();
    await page.fill(`#label-name-${SPICY}`, "Hot & Spicy");
    await page.getByRole("button", { name: "Save label" }).click();
    await page.waitForFunction(() => document.querySelector("li[data-label] span.break-words")?.textContent === "Hot & Spicy");

    const first = labelRows(page).first();
    await first.getByRole("switch").click();
    await page.waitForFunction(() => document.querySelector("li[data-label] .d-badge-warn")?.textContent === "Switched off");
    expect(await labelRows(page).first().getByRole("switch").getAttribute("aria-checked")).toBe("false");
    await labelRows(page).first().getByRole("switch").click();
    await page.waitForFunction(() => !document.querySelector("li[data-label] .d-badge-warn"));

    expect(await page.getByRole("button", { name: "Move Hot & Spicy earlier" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Move Hot & Spicy later" }).click();
    await page.waitForFunction(() => document.querySelectorAll("li[data-label] span.break-words")[1]?.textContent === "Hot & Spicy");
    expect((await names(page)).slice(0, 2)).toEqual(["Vegetarian", "Hot & Spicy"]);
    expect(await page.evaluate(() => document.activeElement.dataset.move)).toBe(`${SPICY}:later`);

    await page.getByRole("button", { name: "Delete Vegan" }).click();
    expect(await dialog(page).innerText()).toContain('Delete the label "Vegan"?');
    expect(await dialog(page).innerText()).toContain("No dish carries it.");
    expect(await page.evaluate(() => document.activeElement.textContent)).toBe("Cancel");
    await dialog(page).getByRole("button", { name: "Delete label" }).click();
    await page.waitForFunction(() => document.querySelectorAll("li[data-label]").length === 8);
    expect(await names(page)).not.toContain("Vegan");
    expect(problems).toEqual([]);
    await context.close();
  });

  it("lets the owner tick labels on a dish in the item editor, shows them in the preview, and keeps them when saved", async () => {
    const { page, context, problems } = await dashboard("#/items/SAMPLEITEM005");
    await page.waitForSelector("#name");
    const group = page.locator("fieldset", { hasText: "Dietary and menu labels" });
    // Nine labels, none ticked: nothing is chosen for the owner.
    expect(await group.locator('input[type="checkbox"]').count()).toBe(9);
    expect(await group.locator('input[type="checkbox"]:checked').count()).toBe(0);
    expect(await group.innerText()).toContain("Nothing is ticked for you.");
    expect(await page.locator(".preview-surface .dish-label").count()).toBe(0);

    await page.check(`#label-${VEGETARIAN}`);
    await page.check(`#label-${SPICY}`);
    // The preview is the real rendering: icon and name, in the labels' own order.
    expect(await page.locator(".preview-surface .dish-label").allInnerTexts()).toEqual(["Spicy", "Vegetarian"]);
    expect(await page.locator(".preview-surface .dish-label svg").count()).toBe(2);
    expect(await page.locator("text=You have unsaved changes.").count()).toBe(1);

    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForSelector("text=All changes saved.");
    await page.locator('aside a[data-nav="#/labels"]').click();
    await page.waitForSelector("li[data-label]");
    expect(await page.locator("li[data-label]").first().innerText()).toContain("On 1 dish");
    // Back in the editor they are still ticked.
    await page.evaluate(() => { location.hash = "#/items/SAMPLEITEM005"; });
    await page.waitForSelector("#name");
    expect(await page.isChecked(`#label-${SPICY}`)).toBe(true);
    expect(await page.isChecked(`#label-${VEGETARIAN}`)).toBe(true);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("keeps the notice being written when a label is switched, moved or deleted meanwhile", async () => {
    const { page, context } = await labelsPage();
    await page.fill("#notice-text-0", "Not saved yet: please tell us about allergies.");
    await page.check("#notice-enabled");
    // Each of these redraws the page.
    await labelRows(page).first().getByRole("switch").click();
    await page.waitForSelector("#toasts > div");
    const moved = await labelRows(page).nth(1).getAttribute("data-label");
    await labelRows(page).nth(1).getByRole("button", { name: /later/ }).click();
    await page.waitForFunction((id) =>
      document.querySelectorAll('section[aria-labelledby="labels-title"] ol > li[data-label]')[2]?.dataset.label === id, moved);
    expect(await page.inputValue("#notice-text-0")).toBe("Not saved yet: please tell us about allergies.");
    expect(await page.isChecked("#notice-enabled")).toBe(true);
    expect(await page.locator('section[aria-labelledby="notice-title"] .preview-surface').innerText()).toContain("Not saved yet");
    await context.close();
  });

  it("writes the allergy notice, previews it as the menu will show it, and puts it on the menu only when switched on", async () => {
    const { page, context, problems } = await labelsPage();
    const section = page.locator('section[aria-labelledby="notice-title"]');
    expect(await section.locator(".d-badge").first().innerText()).toBe("Not shown");
    expect(await section.innerText()).toContain("The wording is yours to decide.");
    expect(await section.innerText()).toContain("Nothing here is approved wording.");
    // The example is a greyed hint in an empty box, not text that would be saved.
    expect(await page.inputValue("#notice-text-0")).toBe("");
    expect(await page.locator("#notice-text-0").getAttribute("placeholder")).toMatch(/^Example only:/);
    expect(await section.locator(".preview-surface").innerText()).toContain("Nothing written yet.");

    // Switched on with nothing written is refused, here, before anything is sent.
    await page.check("#notice-enabled");
    await section.getByRole("button", { name: "Save notice" }).click();
    expect(await section.locator("[role=alert]:not([hidden])").last().innerText()).toBe("Write the notice before turning it on.");

    await page.fill("#notice-text-0", "Test wording: tell our staff about any allergy.");
    expect(await section.locator(".preview-surface .menu-notice p").innerText()).toBe("Test wording: tell our staff about any allergy.");
    await section.getByRole("button", { name: "Add a language" }).click();
    await page.fill("#notice-text-1", "نص تجريبي: أخبر الموظفين بأي حساسية.");
    const second = section.locator(".preview-surface .menu-notice p").nth(1);
    expect(await second.getAttribute("lang")).toBe("ar");
    expect(await second.evaluate((p) => getComputedStyle(p).direction)).toBe("rtl");
    // The two texts cannot be given the same language.
    expect(await page.locator("#notice-lang-1 option").allInnerTexts()).not.toContain("English");

    await section.getByRole("button", { name: "Save notice" }).click();
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="notice-title"] .d-badge-ok')?.textContent === "On the menu");
    expect(await page.inputValue("#notice-text-0")).toBe("Test wording: tell our staff about any allergy.");
    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);
    expect(problems).toEqual([]);
    await context.close();
  });
});

// A dish's description and its "featured" mark, as the owner sets them.
describe("descriptions and featured dishes", () => {
  it("saves a description and marks a dish as featured, then takes both away again", async () => {
    const { page, context, problems } = await dashboard("#/items/SAMPLEITEM012");
    await page.waitForSelector("#name");
    expect(await page.inputValue("#description")).toBe("");
    expect(await page.isChecked("#featured")).toBe(false);

    await page.fill("#description", "Test wording for a description.");
    await page.check("#featured");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForSelector("text=All changes saved.");
    await page.locator('aside a[data-nav="#/items"]').click();
    await waitForRows(page, 12);
    expect(await row(page, "Espresso").innerText()).toContain("Featured");

    await row(page, "Espresso").getByRole("link", { name: "Espresso" }).click();
    await page.waitForSelector("#name");
    expect(await page.inputValue("#description")).toBe("Test wording for a description.");
    await page.fill("#description", "");
    await page.uncheck("#featured");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForSelector("text=All changes saved.");
    await page.locator('aside a[data-nav="#/items"]').click();
    await waitForRows(page, 12);
    expect(await row(page, "Espresso").innerText()).not.toContain("Featured");
    expect(problems).toEqual([]);
    await context.close();
  });
});

// Two-step sign-in. The demo stands in for Supabase Auth: it accepts the code 123456.
describe("two-step sign-in", () => {
  describe("and a password reset", () => {
    // As a reset link opens the dashboard, for an account with two-step sign-in on.
    const resetLink = async () => {
      const opened = await openPage(browser, `${site.url}/dashboard/?demo=reset-two-step`);
      await opened.page.waitForSelector("#code");
      return opened;
    };

    it("asks for the code before the new password, because Supabase changes it only after the code", async () => {
      const { page, context, problems } = await resetLink();
      expect(await page.locator("h1").innerText()).toBe("Enter your code");
      expect(await page.locator("#new-password").count()).toBe(0);
      await page.fill("#code", "000000");
      await page.getByRole("button", { name: "Verify" }).click();
      await page.waitForSelector("[role=alert]:not([hidden])");
      expect(await page.locator("#new-password").count()).toBe(0);

      await page.fill("#code", "123456");
      await page.getByRole("button", { name: "Verify" }).click();
      await page.waitForSelector("#new-password");
      await page.fill("#new-password", "a new long password");
      await page.fill("#confirm-password", "a new long password");
      await page.getByRole("button", { name: "Save password" }).click();
      await page.waitForSelector("#password");
      expect(await page.locator("body").innerText()).toContain("Your password has been changed.");
      expect(problems).toEqual([]);
      await context.close();
    });

    it("does not say the password was changed when the owner signs out at the code instead", async () => {
      const { page, context } = await resetLink();
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.waitForSelector("#password");
      expect(await page.locator("body").innerText()).not.toContain("has been changed");
      await context.close();
    });
  });

  const securityPage = async () => {
    const opened = await dashboard("#/security");
    await opened.page.waitForSelector("#two-step-title");
    return opened;
  };
  const turnOn = async (page) => {
    await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
    await page.waitForSelector("#setup-code");
    await page.fill("#setup-code", "123456");
    await page.getByRole("button", { name: "Turn on", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="two-step-title"] .d-badge-ok')?.textContent === "On");
  };

  it("is off to begin with, and is turned on by scanning a code and proving the app works", async () => {
    const { page, context, problems } = await securityPage();
    const section = page.locator('section[aria-labelledby="two-step-title"]');
    expect(await section.locator(".d-badge").innerText()).toBe("Off");

    await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
    await page.waitForSelector("#setup-code");
    expect(await section.locator("img").getAttribute("alt")).toBe("QR code to scan with your authenticator app");
    expect(await section.locator("img").getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(await section.locator("[data-setup-key]").innerText()).toBe("DEMO KEY 2345 6723 4567 ABCD");
    expect(await page.locator("#setup-code").getAttribute("autocomplete")).toBe("one-time-code");

    // A wrong code changes nothing; neither does something that is not a code.
    await page.fill("#setup-code", "12ab");
    await page.getByRole("button", { name: "Turn on", exact: true }).click();
    expect(await section.locator("[role=alert]:not([hidden])").innerText()).toBe("Enter the six digits the app shows.");
    await page.fill("#setup-code", "000000");
    await page.getByRole("button", { name: "Turn on", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="two-step-title"] [role=alert]:not([hidden])')?.textContent.startsWith("That code was not accepted."));
    expect(await section.locator(".d-badge").innerText()).toBe("Off");

    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);

    await page.fill("#setup-code", "123456");
    await page.getByRole("button", { name: "Turn on", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="two-step-title"] .d-badge-ok')?.textContent === "On");
    // The key is gone from the page: it is shown the once.
    expect(await page.locator("[data-setup-key]").count()).toBe(0);
    expect(await page.locator("main#main").innerText()).not.toContain("DEMO KEY");
    // And nothing of it was kept in the browser.
    const kept = await page.evaluate(() => JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }, document.cookie]));
    expect(kept).not.toMatch(/DEMO KEY|otpauth/);
    expect(problems).toEqual([]);
    await context.close();
  });

  it("asks for the code after the password at the next sign-in, and shows nothing of the dashboard until it is right", async () => {
    const { page, context } = await securityPage();
    await turnOn(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForSelector("#password");
    await page.fill("#email", "owner@example.com");
    await page.fill("#password", "a-long-demo-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForSelector("#code");
    expect(await page.locator("h1").innerText()).toBe("Enter your code");
    expect(await page.locator("aside").count()).toBe(0);
    expect(await page.locator("main#main").count()).toBe(0);
    expect(await page.locator("#code").getAttribute("autocomplete")).toBe("one-time-code");
    expect(await page.locator("#code").getAttribute("inputmode")).toBe("numeric");
    // An address typed by hand gets no further.
    await page.evaluate(() => { location.hash = "#/applications"; });
    await page.waitForTimeout(400);
    expect(await page.locator("h1").innerText()).toBe("Enter your code");

    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);

    await page.fill("#code", "999999");
    await page.getByRole("button", { name: "Verify" }).click();
    await page.waitForSelector("[role=alert]:not([hidden])");
    expect(await page.locator("[role=alert]:not([hidden])").innerText()).toMatch(/^That code was not accepted\./);
    expect(await page.inputValue("#code")).toBe("");
    expect(await page.locator("aside").count()).toBe(0);

    await page.fill("#code", "123456");
    await page.getByRole("button", { name: "Verify" }).click();
    await page.waitForSelector("aside nav");
    expect(await page.locator("main#main h1").count()).toBe(1);
    await context.close();
  });

  it("lets the owner sign out from the code step, and turn two-step sign-in off again after asking", async () => {
    const { page, context } = await securityPage();
    await turnOn(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForSelector("#password");
    await page.fill("#email", "owner@example.com");
    await page.fill("#password", "a-long-demo-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForSelector("#code");
    // Signing out from here goes back to the password, not into the dashboard.
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForSelector("#password");
    expect(await page.locator("h1").innerText()).toBe("Sign in");

    await page.fill("#email", "owner@example.com");
    await page.fill("#password", "a-long-demo-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForSelector("#code");
    await page.fill("#code", "123456");
    await page.getByRole("button", { name: "Verify" }).click();
    await page.waitForSelector("aside nav");
    await page.locator('aside a[data-nav="#/security"]').click();
    await page.waitForSelector("#two-step-title");
    await page.getByRole("button", { name: "Turn off two-step sign-in" }).click();
    expect(await dialog(page).innerText()).toContain("Turn off two-step sign-in?");
    expect(await page.evaluate(() => document.activeElement.textContent)).toBe("Cancel");
    await dialog(page).getByRole("button", { name: "Turn off" }).click();
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="two-step-title"] .d-badge')?.textContent === "Off");
    await context.close();
  });
});

describe("accessibility of each dashboard screen", () => {
  it.each([
    ["overview", "#/", 'a[href="#/items"]'],
    ["photos", "#/photos", "#photo-gallery"],
    ["labels and allergy notice", "#/labels", "li[data-label]"],
    ["security", "#/security", "#two-step-title"],
    ["applications", "#/applications", "table.d-table tbody tr"],
    ["an application", "#/applications/00000000-0000-4000-8000-000000000004", "#application-status"],
    ["items", "#/items", "table.d-table tbody tr"],
    ["categories", "#/categories", "main#main ol > li"],
    ["item order", "#/categories/SAMPLECAT0001/items", "main#main ol > li"],
    ["modifiers", "#/modifiers", "main#main section.d-card"],
    ["Clover", "#/clover", "text=Demo merchant"],
    ["activity", "#/activity", "table.d-table tbody tr"],
  ])("%s passes the WCAG 2.2 AA scan", async (_name, hash, ready) => {
    const { page, context } = await dashboard(hash);
    await page.waitForSelector(ready);
    const violations = await accessibilityViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);
    await context.close();
  });
});

describe("on a phone", () => {
  const phone = { width: 390, height: 844 };

  it("replaces the sidebar with a drawer that opens, navigates and closes", async () => {
    const { page, context } = await dashboard("#/", phone);
    expect(await page.locator("aside").isVisible()).toBe(false);
    await page.getByRole("button", { name: "Open navigation" }).click();
    expect(await page.locator("dialog.d-drawer").evaluate((drawer) => drawer.open)).toBe(true);
    await page.locator('dialog.d-drawer a[data-nav="#/items"]').click();
    await page.waitForFunction(() => document.querySelector("main#main h1")?.textContent === "Items");
    expect(await page.locator("dialog.d-drawer").evaluate((drawer) => drawer.open)).toBe(false);
    await context.close();
  });

  it("shows items as cards with full-size controls instead of a squeezed table", async () => {
    const { page, context } = await dashboard("#/items", phone);
    await page.waitForSelector("main#main ul > li.d-card");
    expect(await page.locator("table.d-table").isVisible()).toBe(false);
    expect(await page.locator("main#main ul > li.d-card").count()).toBe(12);
    const card = page.locator("main#main ul > li.d-card", { hasText: "Espresso" });
    expect(await card.locator('button[role="switch"]').count()).toBe(2);
    await card.locator('button[role="switch"][aria-label="Espresso: in stock"]').click();
    await page.waitForFunction(() =>
      document.querySelector('ul button[aria-label="Espresso: in stock"]')?.getAttribute("aria-checked") === "false");
    await context.close();
  });

  it("shows applications as cards, opens one and changes its status", async () => {
    const { page, context } = await dashboard("#/applications", phone);
    await page.waitForSelector("main#main ul > li.d-card");
    expect(await page.locator("table.d-table").isVisible()).toBe(false);
    expect(await page.locator("main#main ul > li.d-card").count()).toBe(6);
    await page.locator("main#main ul > li.d-card", { hasText: "Priya Nair" }).getByRole("link", { name: /Open/ }).click();
    await page.waitForSelector("#application-status");
    await page.selectOption("#application-status", "shortlisted");
    await page.getByRole("button", { name: "Update status" }).click();
    await page.waitForFunction(() => document.querySelector(".d-timeline > li")?.textContent.includes("to Shortlisted"));
    // Every control on the page is big enough for a thumb, as elsewhere in the dashboard.
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("main#main button, main#main select, main#main textarea, main#main a.d-btn")]
        .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().height < 36).length);
    expect(small).toBe(0);
    await context.close();
  });

  it("keeps the save button on screen while editing", async () => {
    const { page, context } = await dashboard("#/items/SAMPLEITEM005", phone);
    await page.waitForSelector("#name");
    const save = page.getByRole("button", { name: "Save changes" });
    const before = await save.boundingBox();
    await page.evaluate(() => window.scrollTo(0, 600));
    const after = await save.boundingBox();
    expect(Math.round(after.y)).toBe(Math.round(before.y));
    expect(after.y + after.height).toBeLessThanOrEqual(844);
    await context.close();
  });

  it.each([
    ["overview", "#/"], ["items", "#/items"], ["item editor", "#/items/SAMPLEITEM005"], ["new item", "#/items/new"],
    ["categories", "#/categories"], ["modifiers", "#/modifiers"], ["Clover", "#/clover"], ["activity", "#/activity"],
    ["applications", "#/applications"], ["an application", "#/applications/00000000-0000-4000-8000-000000000004"],
    ["photos", "#/photos"], ["labels", "#/labels"], ["security", "#/security"],
    ["item order", "#/categories/SAMPLECAT0001/items"],
  ])("%s fits every screen width from 360px to 1440px without sideways scrolling", async (_name, hash) => {
    const { page, context } = await dashboard(hash, { width: 360, height: 800 });
    for (const width of VIEWPORT_WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(300);
      expect(await hasHorizontalOverflow(page), `${width}px`).toBe(false);
    }
    await context.close();
  });
});
