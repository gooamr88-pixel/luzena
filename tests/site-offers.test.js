// Special offers: the home page's carousel, managed from the dashboard and read by the public
// pages. Real handlers, real SQL (PGlite), an in-memory file store.
import { beforeAll, describe, expect, it } from "vitest";
import { handlePublicSite } from "../supabase/functions/_shared/public/site.ts";
import { createHarness, ORIGIN } from "./helpers/harness.js";

const STORAGE = "https://project.supabase.co/storage/v1/object/public/menu-images";
let h, alpha, beta, owner, manager, staff, outsider;

const webp = (filler = 1) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, filler, filler, filler]);
let counter = 0;
function imageForm({ alt, bytes, small = true } = {}) {
  counter += 1;
  const form = new FormData();
  if (alt !== undefined) form.append("alt", alt);
  form.append("width", "1600");
  form.append("height", "1000");
  form.append("file", new File([bytes ?? webp(counter)], "IMG_0001.webp", { type: "image/webp" }));
  if (small) {
    form.append("small_width", "640");
    form.append("file_small", new File([webp(100 + counter)], "small.webp", { type: "image/webp" }));
  }
  return form;
}
const publicSite = async (slug = "alpha") => {
  const response = await handlePublicSite(new Request(`https://fn.test/public-site?restaurant=${slug}`, { headers: { origin: ORIGIN } }), h.deps, STORAGE);
  return JSON.parse(await response.text());
};
const filesOf = (restaurant) => [...h.stored.keys()].filter((key) => key.startsWith(`menu-images/${restaurant}/offers/`));
const hours = (n) => new Date(Date.now() + n * 3_600_000).toISOString();
const PLATTERS = {
  badge: "This week at Luzena", highlight: "15% OFF", title: "Family Platters", description: "Gather around great food.",
  cta_label: "View Offer", cta_url: "/menu/", fine_print: "Valid through Sunday",
};

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  owner = await h.addUser(alpha, "owner");
  manager = await h.addUser(alpha, "manager");
  staff = await h.addUser(alpha, "staff");
  outsider = await h.addUser(beta, "owner");
});

describe("adding and changing offers", () => {
  let platters;

  it("starts with none, so the website has no carousel", async () => {
    const list = await h.api(owner, "GET", "/site/offers");
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ offers: [], timezone: "America/Los_Angeles", limits: { offers: 12 } });
    expect((await publicSite()).offers).toEqual([]);
  });

  it("adds an offer, switched on, and the website shows it with its button", async () => {
    const response = await h.api(owner, "POST", "/site/offers", PLATTERS);
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Offer added.");
    [platters] = response.body.offers;
    expect(platters).toMatchObject({ ...PLATTERS, id: response.body.id, active: true, image: null, starts_at: null, ends_at: null });

    expect((await publicSite()).offers).toEqual([{
      badge: "This week at Luzena", highlight: "15% OFF", title: "Family Platters", description: "Gather around great food.",
      cta: { label: "View Offer", href: "/menu/" }, fine_print: "Valid through Sunday", starts_at: null, ends_at: null, image: null,
    }]);
  });

  it("gives a button with no words of its own the default words, and no button without an address", async () => {
    const { body } = await h.api(manager, "POST", "/site/offers", { title: "Coffee Hour", cta_label: "", cta_url: "/order/" });
    const { body: plain } = await h.api(manager, "POST", "/site/offers", { title: "Live Music" });
    const site = (await publicSite()).offers;
    expect(site.map((offer) => offer.title)).toEqual(["Family Platters", "Coffee Hour", "Live Music"]);
    expect(site[1].cta).toEqual({ label: "View Offer", href: "/order/" });
    expect(site[2].cta).toBeNull();
    await h.api(owner, "DELETE", `/site/offers/${body.id}`);
    await h.api(owner, "DELETE", `/site/offers/${plain.id}`);
  });

  it("changes only the fields it is given", async () => {
    const response = await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { highlight: "20% OFF" });
    expect(response.status).toBe(200);
    expect(response.body.offers[0]).toMatchObject({ ...PLATTERS, highlight: "20% OFF" });
  });

  it("refuses what it cannot show safely or at all", async () => {
    const bad = [
      { title: "" },
      { title: "x".repeat(81) },
      { highlight: "x".repeat(25) },
      { cta_url: "javascript:alert(1)" },
      { cta_url: "//evil.example/" },
      { cta_url: "http://plain.example/" },
      { starts_at: "next tuesday" },
      { colour: "red" },
    ];
    for (const fields of bad) {
      const response = await h.api(owner, "PATCH", `/site/offers/${platters.id}`, fields);
      expect(response.status, JSON.stringify(fields)).toBe(422);
    }
    for (const cta_url of ["/careers/", "https://order.example.com/luzena", "tel:+16194995779", ""]) {
      expect((await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { cta_url })).status).toBe(200);
    }
    await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { cta_url: "/menu/" });
  });

  it("switches an offer off and on, and the website follows", async () => {
    const off = await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { active: false });
    expect(off.body.message).toBe("Offer switched off.");
    expect(off.body.offers[0].active).toBe(false);
    expect((await publicSite()).offers).toEqual([]);
    const on = await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { active: true });
    expect(on.body.message).toBe("Offer switched on.");
    expect((await publicSite()).offers).toHaveLength(1);
  });

  it("shows an offer only between its first and last moment", async () => {
    await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { starts_at: hours(2), ends_at: hours(50) });
    expect((await publicSite()).offers).toEqual([]);
    await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { starts_at: hours(-50), ends_at: hours(-2) });
    expect((await publicSite()).offers).toEqual([]);
    await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { starts_at: hours(-2), ends_at: hours(2) });
    const [shown] = (await publicSite()).offers;
    expect(Date.parse(shown.ends_at)).toBeGreaterThan(Date.now());
    // Open again at both ends: a date is cleared with null.
    await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { starts_at: null, ends_at: null });
    expect((await publicSite()).offers[0]).toMatchObject({ starts_at: null, ends_at: null });
  });

  it("refuses a last day before the first, whether given together or one at a time", async () => {
    const together = await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { starts_at: hours(10), ends_at: hours(5) });
    expect(together.status).toBe(422);
    expect(together.body.error.fields).toEqual({ ends_at: "must come after the first day" });
    await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { ends_at: hours(5) });
    expect((await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { starts_at: hours(6) })).status).toBe(422);
    expect((await h.api(owner, "POST", "/site/offers", { title: "Backwards", starts_at: hours(3), ends_at: hours(1) })).status).toBe(422);
    await h.api(owner, "PATCH", `/site/offers/${platters.id}`, { ends_at: null });
  });
});

describe("photos, order and removal", () => {
  it("stores an offer's photo in its own folder and hands the website both sizes", async () => {
    const [offer] = (await h.api(owner, "GET", "/site/offers")).body.offers;
    const response = await h.api(owner, "POST", `/site/offers/${offer.id}/image`, imageForm({ alt: "A platter of rice and lamb" }));
    expect(response.status).toBe(200);
    const { image } = response.body.offers[0];
    expect(image.path).toMatch(new RegExp(`^${alpha}/offers/[0-9a-f]{20}\\.webp$`));
    expect(image).toMatchObject({ width: 1600, height: 1000, small_width: 640, alt: "A platter of rice and lamb" });
    expect(JSON.stringify(response.body)).not.toContain("IMG_0001");

    expect((await publicSite()).offers[0].image).toEqual({
      src: `${STORAGE}/${image.path}`, srcset: `${STORAGE}/${image.small_path} 640w, ${STORAGE}/${image.path} 1600w`,
      width: 1600, height: 1000, alt: "A platter of rice and lamb",
    });
  });

  it("replacing the photo deletes the old files, unless another offer uses the same photo", async () => {
    const [offer] = (await h.api(owner, "GET", "/site/offers")).body.offers;
    const old = offer.image;
    const second = (await h.api(owner, "POST", "/site/offers", { title: "Breakfast Combo" })).body.id;
    // The same bytes as the first offer's: one file, two offers.
    const shared = webp(200);
    await h.api(owner, "POST", `/site/offers/${offer.id}/image`, imageForm({ bytes: shared, small: false }));
    expect(filesOf(alpha)).not.toContain(`menu-images/${old.path}`);
    expect(filesOf(alpha)).not.toContain(`menu-images/${old.small_path}`);
    await h.api(owner, "POST", `/site/offers/${second}/image`, imageForm({ bytes: shared, small: false }));
    // Without a description given, a new photo keeps the one there was.
    const now = (await h.api(owner, "GET", "/site/offers")).body.offers;
    expect(now[0].image.alt).toBe("A platter of rice and lamb");
    expect(now[0].image.path).toBe(now[1].image.path);

    await h.api(owner, "DELETE", `/site/offers/${second}/image`);
    expect(filesOf(alpha)).toContain(`menu-images/${now[0].image.path}`);
    expect((await h.api(owner, "DELETE", `/site/offers/${offer.id}/image`)).body.offers[0].image).toBeNull();
    expect(filesOf(alpha)).toEqual([]);
    await h.api(owner, "DELETE", `/site/offers/${second}`);
  });

  it("refuses a file that is not a photo", async () => {
    const [offer] = (await h.api(owner, "GET", "/site/offers")).body.offers;
    const response = await h.api(owner, "POST", `/site/offers/${offer.id}/image`, imageForm({ bytes: new TextEncoder().encode("<svg onload=alert(1)>") }));
    expect(response.status).toBe(415);
  });

  it("puts offers in the owner's order, and refuses an order that leaves one out", async () => {
    await h.api(owner, "POST", "/site/offers", { title: "Coffee Hour" });
    await h.api(owner, "POST", "/site/offers", { title: "Live Music" });
    const ids = (await h.api(owner, "GET", "/site/offers")).body.offers.map((offer) => offer.id);
    const reordered = await h.api(owner, "POST", "/site/offers/reorder", { ids: [ids[2], ids[0], ids[1]] });
    expect(reordered.body.offers.map((offer) => offer.title)).toEqual(["Live Music", "Family Platters", "Coffee Hour"]);
    expect((await publicSite()).offers.map((offer) => offer.title)).toEqual(["Live Music", "Family Platters", "Coffee Hour"]);
    expect((await h.api(owner, "POST", "/site/offers/reorder", { ids: ids.slice(0, 2) })).status).toBe(409);
  });

  it("holds twelve offers at most", async () => {
    let count = (await h.api(owner, "GET", "/site/offers")).body.offers.length;
    while (count < 12) {
      expect((await h.api(owner, "POST", "/site/offers", { title: `Offer ${count}` })).status).toBe(200);
      count += 1;
    }
    const full = await h.api(owner, "POST", "/site/offers", { title: "One too many" });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("offers_full");
  });

  it("removes an offer and records it in the activity", async () => {
    const offers = (await h.api(owner, "GET", "/site/offers")).body.offers;
    const response = await h.api(owner, "DELETE", `/site/offers/${offers.at(-1).id}`);
    expect(response.status).toBe(200);
    expect(response.body.offers).toHaveLength(offers.length - 1);
    expect((await h.api(owner, "DELETE", `/site/offers/${offers.at(-1).id}`)).status).toBe(404);
    const { rows } = await h.pg.query("select action from public.audit_logs where restaurant_id = $1 and entity_type = 'site_offer'", [alpha]);
    expect(new Set(rows.map((row) => row.action))).toEqual(new Set([
      "SITE_OFFER_CREATED", "SITE_OFFER_UPDATED", "SITE_OFFER_PHOTO_SET", "SITE_OFFER_PHOTO_REMOVED", "SITE_OFFER_REMOVED",
    ]));
  });
});

describe("who may", () => {
  it("owners and managers; not staff, and no other restaurant", async () => {
    const [offer] = (await h.api(owner, "GET", "/site/offers")).body.offers;
    expect((await h.api(manager, "GET", "/site/offers")).status).toBe(200);
    for (const [method, path, body] of [
      ["GET", "/site/offers"], ["POST", "/site/offers", { title: "Staff special" }],
      ["PATCH", `/site/offers/${offer.id}`, { active: false }], ["DELETE", `/site/offers/${offer.id}`],
    ]) {
      expect((await h.api(staff, method, path, body)).status).toBe(403);
    }
    expect((await h.api(outsider, "GET", "/site/offers")).body.offers).toEqual([]);
    expect((await h.api(outsider, "PATCH", `/site/offers/${offer.id}`, { title: "Taken over" })).status).toBe(404);
    expect((await h.api(outsider, "DELETE", `/site/offers/${offer.id}`)).status).toBe(404);
    expect((await h.api(outsider, "POST", `/site/offers/${offer.id}/image`, imageForm())).status).toBe(404);
    expect(filesOf(beta)).toEqual([]);
    expect((await publicSite("beta")).offers).toEqual([]);
  });
});
