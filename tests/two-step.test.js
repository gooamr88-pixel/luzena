// Two-step sign-in. The codes and the secret are Supabase Auth's; this system only refuses a
// session that has skipped the second step. Real router, real SQL (PGlite); the stand-in for
// Supabase Auth says what a real one would about each session.
import { beforeAll, describe, expect, it } from "vitest";
import { hasVerifiedFactor, sessionLevel } from "../supabase/functions/_shared/auth-level.ts";
import { createHarness } from "./helpers/harness.js";

// A token shaped like Supabase's, carrying the given claims. Unsigned: the function under
// test reads a claim from a token that Supabase has already verified.
const token = (claims) => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.signature`;
};

describe("reading how a session signed in", () => {
  it("tells a session that gave a code from one that gave only a password", () => {
    expect(sessionLevel(token({ sub: "u", aal: "aal2", amr: [{ method: "password" }, { method: "totp" }] }))).toBe("aal2");
    expect(sessionLevel(token({ sub: "u", aal: "aal1", amr: [{ method: "password" }] }))).toBe("aal1");
  });

  it("treats anything it cannot read as the lowest level, never as the highest", () => {
    for (const bad of ["", "not-a-token", "a.b.c", "a.!!!.c", token({ sub: "u" }), token({ aal: "AAL2" }), token({ aal: 2 }), token({ aal: ["aal2"] }), `x.${Buffer.from("[]").toString("base64url")}.y`]) {
      expect(sessionLevel(bad), bad.slice(0, 20)).toBe("aal1");
    }
  });

  it("counts an authenticator app only once the account has proved it holds it", () => {
    expect(hasVerifiedFactor([{ id: "f1", factor_type: "totp", status: "verified" }])).toBe(true);
    expect(hasVerifiedFactor([{ id: "f1", status: "unverified" }, { id: "f2", status: "verified" }])).toBe(true);
    // Begun and never confirmed, or nothing at all.
    for (const none of [[{ id: "f1", status: "unverified" }], [], undefined, null, "verified", { status: "verified" }, [null]]) {
      expect(hasVerifiedFactor(none), JSON.stringify(none)).toBe(false);
    }
  });
});

describe("what the API does with it", () => {
  let h, alpha, owner, manager, staff, soup;

  beforeAll(async () => {
    h = await createHarness();
    alpha = await h.createRestaurant("alpha");
    owner = await h.addUser(alpha, "owner");
    manager = await h.addUser(alpha, "manager");
    staff = await h.addUser(alpha, "staff");
    const starters = h.clover.addCategory("Starters", 1);
    soup = h.clover.addItem("Soup", 700);
    h.clover.link(soup, starters);
    await h.connect(alpha);
    await h.api(owner, "POST", "/clover/sync");
  });

  it("lets an account without two-step sign-in in with its password, as before", async () => {
    expect((await h.api(owner, "GET", "/me")).status).toBe(200);
    // Supabase says nothing either way about an older account: that is off, too.
    h.signedInWith(manager, { twoStep: false, level: "aal1" });
    expect((await h.api(manager, "GET", "/items")).status).toBe(200);
  });

  it("refuses every route to a session that has the password but not the code", async () => {
    h.signedInWith(owner, { twoStep: true, level: "aal1" });
    const callsBefore = h.clover.calls.length;
    const before = (await h.pg.query("select web_description, web_featured from public.menu_items where clover_id = $1", [soup])).rows[0];
    const photo = new FormData();
    photo.append("file", new File([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1])], "a.webp"));

    const attempts = [
      ["GET", "/me"], ["GET", "/overview"], ["GET", "/items"], ["GET", `/items/${soup}`],
      ["PATCH", `/items/${soup}`, { website: { description: "Changed with a stolen password.", featured: true } }],
      ["POST", "/items/bulk", { ids: [soup], action: "feature" }],
      ["POST", `/items/${soup}/image`, photo],
      ["GET", "/categories"], ["GET", "/site/photos"], ["GET", "/applications"], ["GET", "/activity"],
      ["GET", "/clover"], ["POST", "/clover/sync"], ["POST", "/clover/disconnect"],
    ];
    for (const [method, path, body] of attempts) {
      const response = await h.api(owner, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.error.code, `${method} ${path}`).toBe("mfa_required");
    }
    // Nothing was read from Clover, changed, stored or disconnected.
    expect(h.clover.calls.length).toBe(callsBefore);
    expect((await h.pg.query("select web_description, web_featured from public.menu_items where clover_id = $1", [soup])).rows[0]).toEqual(before);
    expect([...h.stored.keys()].some((key) => key.includes(soup))).toBe(false);
    expect((await h.pg.query("select count(*)::int as n from public.clover_connections")).rows[0].n).toBe(1);
  });

  it("says only that a code is needed: nothing about the account or its factor", async () => {
    const response = await h.api(owner, "GET", "/me");
    expect(Object.keys(response.body.error).sort()).toEqual(["code", "message", "request_id"]);
    expect(response.body.error.message).toBe("Enter the code from your authenticator app to continue.");
    expect(JSON.stringify(response.body)).not.toMatch(/factor|totp|secret|aal/i);
  });

  it("lets the same account in once the session has given the code", async () => {
    h.signedInWith(owner, { twoStep: true, level: "aal2" });
    expect((await h.api(owner, "GET", "/me")).status).toBe(200);
    const saved = await h.api(owner, "PATCH", `/items/${soup}`, { website: { featured: true } });
    expect(saved.status).toBe(200);
    expect(saved.body.item.featured).toBe(true);
  });

  it("applies to every role, each account on its own", async () => {
    h.signedInWith(staff, { twoStep: true, level: "aal1" });
    expect((await h.api(staff, "GET", "/items")).body.error.code).toBe("mfa_required");
    // The manager, who has not turned it on, is not affected by the others having done so.
    expect((await h.api(manager, "GET", "/items")).status).toBe(200);
    h.signedInWith(staff, { twoStep: true, level: "aal2" });
    expect((await h.api(staff, "GET", "/items")).status).toBe(200);
    // Two-step sign-in adds a check; it takes none away. Staff still cannot write.
    expect((await h.api(staff, "PATCH", `/items/${soup}`, { website: { featured: false } })).status).toBe(403);
  });

  it("still refuses a session that Supabase does not vouch for at all, with or without a code", async () => {
    const response = await h.api({ token: token({ sub: "nobody", aal: "aal2" }) }, "GET", "/me");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthenticated");
  });

  it("writes nothing about codes or factors to the log", () => {
    expect(JSON.stringify(h.logs)).not.toMatch(/totp|factor|otpauth|secret/i);
  });
});
