// Connecting Clover with a merchant's own API token instead of OAuth: real handlers, real
// SQL, fake Clover. This is the path a single restaurant uses with its own Clover account,
// and it must work with NO Clover app configured.
import { beforeAll, describe, expect, it } from "vitest";
import { handlePublicMenu } from "../supabase/functions/_shared/public/menu.ts";
import { loadEnv } from "../supabase/functions/_shared/env.ts";
import { createHarness, ORIGIN } from "./helpers/harness.js";

// No app id, no app secret: only the environment and the encryption key.
const NO_APP = { CLOVER_APP_ID: "", CLOVER_APP_SECRET: "", CLOVER_REDIRECT_URI: "", CLOVER_WEBHOOK_AUTH: "" };

let h, alpha, beta, owner, staff, betaOwner, soup, steak;
const connect = (user, token, merchantId = h.clover.merchantId) =>
  h.api(user, "POST", "/clover/connect-token", { merchant_id: merchantId, token });
const row = async (restaurant) =>
  (await h.pg.query("select * from public.clover_connections where restaurant_id = $1", [restaurant])).rows[0];
const everythingLogged = () => JSON.stringify(h.logs);
const publicMenu = async () => {
  const response = await handlePublicMenu(
    new Request("https://fn.test/public-menu?restaurant=alpha", { headers: { origin: ORIGIN } }), h.deps, "https://files.test");
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  h = await createHarness(NO_APP);
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  owner = await h.addUser(alpha, "owner");
  staff = await h.addUser(alpha, "staff");
  betaOwner = await h.addUser(beta, "owner");

  const starters = h.clover.addCategory("Starters", 1);
  soup = h.clover.addItem("Soup", 700);
  steak = h.clover.addItem("Steak", 3200);
  h.clover.link(soup, starters);
  h.clover.link(steak, starters);
});

describe("configuration", () => {
  it("needs CLOVER_ENV to be set explicitly: there is no default to send a real token to", () => {
    expect(loadEnv(() => undefined).cloverEnvironment).toBeNull();
    expect(loadEnv((name) => ({ CLOVER_ENV: "na" })[name]).cloverEnvironment).toBe("na");
    expect(loadEnv((name) => ({ CLOVER_ENV: "na" })[name]).clover).toBeNull();
    expect(() => loadEnv((name) => ({ CLOVER_ENV: "production" })[name])).toThrow(/CLOVER_ENV/);
  });

  it("offers the token form and not OAuth when no Clover app is configured", async () => {
    const status = (await h.api(owner, "GET", "/clover")).body;
    expect(status.configured).toBe(false);
    expect(status.token_connect).toBe(true);
    expect(status.connection.connected).toBe(false);
    // OAuth cannot start without an app.
    const oauth = await h.api(owner, "POST", "/clover/connect");
    expect(oauth.status).toBe(503);
    expect(oauth.body.error.code).toBe("clover_not_configured");
  });

  it("refuses a token when CLOVER_ENV is not set", async () => {
    const bare = await createHarness({ ...NO_APP, CLOVER_ENV: "" });
    const restaurant = await bare.createRestaurant("alpha");
    const user = await bare.addUser(restaurant, "owner");
    expect((await bare.api(user, "GET", "/clover")).body.token_connect).toBe(false);
    const response = await bare.api(user, "POST", "/clover/connect-token", { merchant_id: bare.clover.merchantId, token: bare.clover.accessToken });
    expect(response.status).toBe(503);
    expect(bare.clover.calls).toHaveLength(0);
  });
});

describe("refusals", () => {
  it("is for owners only, and needs a session", async () => {
    expect((await connect(null, h.clover.accessToken)).status).toBe(401);
    const response = await connect(staff, h.clover.accessToken);
    expect(response.status).toBe(403);
    expect(await row(alpha)).toBeUndefined();
  });

  it("rejects malformed input before anything is sent to Clover", async () => {
    const before = h.clover.calls.length;
    expect((await connect(owner, h.clover.accessToken, "short")).status).toBe(422);
    expect((await connect(owner, "tiny")).status).toBe(422);
    expect((await connect(owner, "has spaces and <tags> in it")).status).toBe(422);
    expect((await h.api(owner, "POST", "/clover/connect-token", { merchant_id: h.clover.merchantId, token: h.clover.accessToken, extra: 1 })).status).toBe(422);
    expect(h.clover.calls.length).toBe(before);
  });

  it("stores nothing when Clover does not accept the token", async () => {
    const response = await connect(owner, "wrong-token-0000000000");
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("clover_token_rejected");
    expect(await row(alpha)).toBeUndefined();
    expect((await h.api(owner, "GET", "/clover")).body.connection.connected).toBe(false);
  });

  it("stores nothing when the merchant ID is not the token's merchant", async () => {
    const response = await connect(owner, h.clover.accessToken, "WRONGMERCHANT");
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("clover_token_rejected");
    expect(await row(alpha)).toBeUndefined();
  });

  it("says so when the token cannot read the inventory", async () => {
    h.clover.fault({ method: "GET", path: /\/items$/, status: 403 });
    const response = await connect(owner, h.clover.accessToken);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("clover_token_no_inventory");
    expect(await row(alpha)).toBeUndefined();
  });

  it("does not store a token while Clover is unreachable", async () => {
    h.clover.fault({ method: "GET", path: /\/items$/, status: 503, times: 5 });
    const response = await connect(owner, h.clover.accessToken);
    expect(response.status).toBe(502);
    expect(await row(alpha)).toBeUndefined();
    h.clover.faults.length = 0;
  });
});

describe("a successful connection", () => {
  let token;

  it("connects, stores the token encrypted, and never shows it again", async () => {
    token = h.clover.accessToken;
    const response = await connect(owner, token);
    expect(response.status).toBe(200);
    expect(response.body.result).toBe("connected");
    expect(response.body.connection.connected).toBe(true);
    expect(response.body.connection.merchant_id).toBe(h.clover.merchantId);
    expect(JSON.stringify(response.body)).not.toContain(token);

    const stored = await row(alpha);
    expect(stored.access_token_enc).toMatch(/^v1\./);
    expect(stored.refresh_token_enc).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.environment).toBe("sandbox");
    expect(stored.status).toBe("active");

    await h.settle();
    // Not in any log line, the audit log or a later status read.
    expect(everythingLogged()).not.toContain(token);
    const audit = (await h.pg.query("select * from public.audit_logs where restaurant_id = $1", [alpha])).rows;
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(audit.some((entry) => entry.action === "CLOVER_CONNECTED" && entry.new_values.method === "api_token")).toBe(true);
    expect(JSON.stringify((await h.api(owner, "GET", "/clover")).body)).not.toContain(token);
  });

  it("imports the merchant's inventory and publishes none of it", async () => {
    const status = (await h.api(owner, "GET", "/clover")).body.connection;
    expect(status.merchant_name).toBe("Fake Merchant");
    expect(status.last_success_at).not.toBeNull();

    const items = (await h.api(owner, "GET", "/items")).body.items;
    expect(items.map((item) => item.name).sort()).toEqual(["Soup", "Steak"]);
    expect(items.every((item) => item.web_hidden && !item.on_website)).toBe(true);
    const menu = await publicMenu();
    expect(menu.body.categories).toEqual([]);
  });

  it("publishes only what the owner shows, and leaves Clover untouched by it", async () => {
    const callsBefore = h.clover.calls.filter((call) => call.method !== "GET").length;
    await h.api(owner, "POST", "/items/bulk", { ids: [soup], action: "show" });
    const menu = await publicMenu();
    expect(menu.body.categories.flatMap((category) => category.items.map((item) => item.name))).toEqual(["Soup"]);
    // Showing an item on the website is not a Clover write.
    expect(h.clover.calls.filter((call) => call.method !== "GET").length).toBe(callsBefore);
  });

  it("reads and writes Clover with the stored token, with no token refresh", async () => {
    const response = await h.api(owner, "PATCH", `/items/${steak}`, { clover: { price_cents: 3400 }, expected: { price_cents: 3200 } });
    expect(response.status).toBe(200);
    expect(h.clover.items.get(steak).price).toBe(3400);
    expect((await h.api(owner, "POST", "/clover/sync")).body.result).toBe("synced");
    expect(h.clover.refreshCalls).toBe(0);
  });

  it("refuses the same merchant for a second restaurant", async () => {
    const response = await connect(betaOwner, token);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("merchant_in_use");
    expect(await row(beta)).toBeUndefined();
  });
});

describe("when the merchant deletes the token in Clover", () => {
  it("stops, asks for a new token, never tries to refresh, and keeps the published menu", async () => {
    h.clover.tokenGeneration += 1; // the old token is now rejected, as after a delete in Clover

    const sync = await h.api(owner, "POST", "/clover/sync");
    expect(sync.status).toBe(502);
    const status = (await h.api(owner, "GET", "/clover")).body.connection;
    expect(status.status).toBe("needs_reauth");
    expect(h.clover.refreshCalls).toBe(0);
    expect(h.clover.calls.some((call) => call.path.startsWith("/oauth/"))).toBe(false);

    // A write is refused without touching Clover, and says to reconnect.
    const write = await h.api(owner, "PATCH", `/items/${steak}`, { clover: { price_cents: 1 }, expected: { price_cents: 3400 } });
    expect(write.status).toBe(409);
    expect(write.body.error.code).toBe("clover_needs_reauth");
    expect(h.clover.items.get(steak).price).toBe(3400);

    // The website keeps what it had.
    const menu = await publicMenu();
    await h.settle();
    expect(menu.status).toBe(200);
    expect(menu.body.categories.flatMap((category) => category.items.map((item) => item.name))).toEqual(["Soup"]);
  });

  it("limits how often one person can try tokens", async () => {
    // Ten connection attempts in fifteen minutes per person; this owner has made most of
    // them above. Once the limit is reached Clover is not asked anything, whatever the token.
    let response;
    for (let attempt = 0; attempt < 12; attempt++) {
      response = await connect(owner, "wrong-token-0000000000");
      if (response.status === 429) break;
    }
    expect(response.status).toBe(429);
    const before = h.clover.calls.length;
    expect((await connect(owner, h.clover.accessToken)).status).toBe(429);
    expect(h.clover.calls.length).toBe(before);
    expect((await row(alpha)).status).toBe("needs_reauth");
  });

  it("resumes with a new token, keeping every website choice", async () => {
    owner = await h.addUser(alpha, "owner"); // a second owner of the same restaurant
    const response = await connect(owner, h.clover.accessToken);
    expect(response.status).toBe(200);
    await h.settle();
    const status = (await h.api(owner, "GET", "/clover")).body.connection;
    expect(status.status).toBe("active");
    const items = (await h.api(owner, "GET", "/items")).body.items;
    expect(items.find((item) => item.id === soup).web_hidden).toBe(false);
    expect(items.find((item) => item.id === steak).web_hidden).toBe(true);
  });

  it("disconnects by deleting the stored token, and deletes nothing in Clover", async () => {
    const response = await h.api(owner, "POST", "/clover/disconnect");
    expect(response.body.connection.connected).toBe(false);
    expect(await row(alpha)).toBeUndefined();
    expect(h.clover.items.has(soup) && h.clover.items.has(steak)).toBe(true);
    expect(h.clover.calls.some((call) => call.method === "DELETE")).toBe(false);
  });
});
