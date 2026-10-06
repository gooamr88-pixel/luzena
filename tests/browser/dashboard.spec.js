// The owner dashboard, driven in a real browser: clicking, typing, dialogs, keyboard.
//
// It runs in the dashboard's demo mode, where an in-memory stand-in answers for Supabase
// Auth and the dashboard API. So this file proves the INTERFACE behaves correctly: what is
// shown, when, and what is sent. What the real API then does with a request (permissions,
// Clover writes, conflicts, partial saves) is proven in tests/dashboard.test.js. Neither
// file talks to a real Supabase project or to Clover.
//
// Every test opens a fresh page, so the demo data starts from the same state each time.
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

describe("accessibility of each dashboard screen", () => {
  it.each([
    ["overview", "#/", 'a[href="#/items"]'],
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
