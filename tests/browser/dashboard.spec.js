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

describe("accessibility of each dashboard screen", () => {
  it.each([
    ["overview", "#/", 'a[href="#/items"]'],
    ["photos", "#/photos", "#photo-gallery"],
    ["applications", "#/applications", "table.d-table tbody tr"],
    ["an application", "#/applications/00000000-0000-4000-8000-000000000004", "#application-status"],
    ["items", "#/items", "table.d-table tbody tr"],
    ["categories", "#/categories", "main#main ol > li"],
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
    ["photos", "#/photos"],
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
