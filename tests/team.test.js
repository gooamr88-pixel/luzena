// Team and access, on the real handlers and real SQL (PGlite): inviting, accepting, roles,
// taking access away, and everything that must be refused.
//
// The stand-in for Supabase Auth (tests/helpers/harness.js) does what the real one is asked
// to do here: make an account with no password, say whether an account has been signed in
// to, and make a link for choosing a password. What the real service then does with those
// requests is not proven by this file.
//
// Requests are sent straight to the API, as a script or a modified page would send them:
// nothing here depends on what the dashboard chooses to show.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isExistingAccount } from "../supabase/functions/_shared/accounts.ts";
import { invitationEmail } from "../supabase/functions/_shared/dashboard/team-email.ts";
import { CAPABILITIES, ROLE_NAMES, ROLE_PERMISSIONS } from "../src/dashboard/roles.js";
import { createRestaurant, createTestDb } from "./helpers/db.js";
import { createHarness, ORIGIN } from "./helpers/harness.js";

let h, alpha, beta, owner, manager, staff, betaOwner;
const NOBODY = "00000000-0000-4000-8000-00000000dead";

const invite = (email, role = "manager", by = owner) => h.api(by, "POST", "/team/invitations", { email, role });
const team = async (by = owner) => (await h.api(by, "GET", "/team")).body;
const invitationFor = async (email, by = owner) => (await team(by)).invitations.find((entry) => entry.email === email);
const memberFor = async (email, by = owner) => (await team(by)).members.find((entry) => entry.email === email);
const memberships = async (userId) => (await h.pg.query("select restaurant_id, role from public.restaurant_users where user_id = $1", [userId])).rows;
const count = async (sql, values = []) => (await h.pg.query(`select count(*)::int as n from ${sql}`, values)).rows[0].n;
// Invites an address, has its holder sign in, and accepts: the whole way to being a member.
async function join(email, role = "manager") {
  expect((await invite(email, role)).status, email).toBe(200);
  const account = await h.signInAs(email);
  const [waiting] = (await h.api(account, "GET", "/account/invitations")).body.invitations;
  expect((await h.api(account, "POST", `/account/invitations/${waiting.id}/accept`)).status, email).toBe(200);
  return account;
}
// Puts a per-user counter of the rate limiter at a number, as that many requests would.
const seedLimit = (key, windowSeconds, value) => h.pg.query(
  `insert into public.rate_limits (key, window_start, count)
   values ($1, to_timestamp(floor(extract(epoch from now()) / $2::int) * $2::int), $3)
   on conflict (key, window_start) do update set count = excluded.count`, [key, windowSeconds, value]);

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  await h.pg.query("update public.restaurants set name = 'Alpha Kitchen' where id = $1", [alpha]);
  await h.pg.query("update public.restaurants set name = 'Beta Bistro' where id = $1", [beta]);
  owner = await h.addUser(alpha, "owner");
  manager = await h.addUser(alpha, "manager");
  staff = await h.addUser(alpha, "staff");
  betaOwner = await h.addUser(beta, "owner");
  // Each has opened the dashboard once, which is when an account's address is noted.
  for (const user of [owner, manager, staff, betaOwner]) await h.api(user, "GET", "/me");
  await h.settle();
});

// This file sends more invitations in a minute than an owner may send in an hour. Each
// test starts with the rate limiter empty; the test of the limits fills it itself.
beforeEach(async () => {
  await h.pg.query("delete from public.rate_limits");
});

describe("what each role may do", () => {
  it("is the same table on the server and on the Team page", async () => {
    for (const [role, user] of [["owner", owner], ["manager", manager], ["staff", staff]]) {
      const { body } = await h.api(user, "GET", "/me");
      expect(body.role).toBe(role);
      expect([...body.permissions].sort(), role).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
    // The page explains every permission that exists, and none that does not.
    expect(CAPABILITIES.map((capability) => capability.permission).sort()).toEqual([...ROLE_PERMISSIONS.owner].sort());
    expect(Object.keys(ROLE_NAMES)).toEqual(["owner", "manager", "staff"]);
  });

  it("gives a manager the day-to-day work and none of the owner's own decisions; staff only the menu", async () => {
    const application = (await h.pg.query(
      `insert into public.job_applications (restaurant_id, full_name, email, phone, position, cv_path, cv_original_name, cv_mime)
       values ($1, 'Pat Example', 'pat@example.test', '+1 619 555 0100', 'Barista', $2, 'cv.pdf', 'application/pdf') returning id`,
      [alpha, `${alpha}/matrix.pdf`])).rows[0].id;
    h.stored.set(`cvs/${alpha}/matrix.pdf`, { bytes: new TextEncoder().encode("%PDF-1.7"), contentType: "application/pdf" });

    // [method, path, body, owner, manager, staff]: true = let through, false = 403 forbidden.
    const table = [
      ["GET", "/items", undefined, true, true, true],
      ["GET", "/overview", undefined, true, true, true],
      ["GET", "/clover", undefined, true, true, true],
      ["POST", "/labels", { name: "Seasonal", icon: "leaf" }, true, true, false],
      ["GET", "/site/photos", undefined, true, true, false],
      ["PUT", "/site/notice", { enabled: false, entries: [] }, true, true, false],
      ["POST", "/clover/sync", undefined, true, true, false],
      ["POST", "/clover/disconnect", undefined, true, false, false],
      ["POST", "/clover/connect", undefined, true, false, false],
      ["GET", "/applications", undefined, true, true, false],
      ["GET", `/applications/${application}`, undefined, true, true, false],
      ["GET", `/applications/${application}/cv`, undefined, true, true, false],
      ["PATCH", `/applications/${application}`, { status: "reviewing" }, true, true, false],
      ["POST", "/applications/export/preview", { scope: "all" }, true, false, false],
      ["POST", "/applications/export", { scope: "all" }, true, false, false],
      ["GET", "/activity", undefined, true, true, false],
      ["GET", "/team", undefined, true, false, false],
      ["POST", "/team/invitations", { email: "matrix@example.test", role: "staff" }, true, false, false],
      ["POST", `/team/invitations/${NOBODY}/resend`, undefined, true, false, false],
      ["DELETE", `/team/invitations/${NOBODY}`, undefined, true, false, false],
      ["PATCH", `/team/members/${NOBODY}`, { role: "staff" }, true, false, false],
      ["DELETE", `/team/members/${NOBODY}`, undefined, true, false, false],
    ];
    for (const [method, path, body, ...allowed] of table) {
      for (const [index, user] of [owner, manager, staff].entries()) {
        const response = await h.api(user, method, path, body);
        const refused = response.status === 403 && response.body?.error?.code === "forbidden";
        expect(!refused, `${["owner", "manager", "staff"][index]} ${method} ${path} -> ${response.status}`).toBe(allowed[index]);
      }
    }
    // The manager's and the staff member's refused attempts changed nothing.
    expect(await invitationFor("matrix@example.test")).toMatchObject({ role: "staff", invited_by_email: owner.email });
    expect(await count("public.audit_logs where action = 'APPLICATIONS_EXPORTED' and user_id <> $1", [owner.id])).toBe(0);
  });

  it("has no platform-wide role: an account sees one restaurant, its own, whatever it asks for", async () => {
    for (const user of [owner, manager, staff]) {
      expect((await h.api(user, "GET", "/me", undefined, { "x-restaurant-id": beta })).status).toBe(403);
    }
    expect((await team(betaOwner)).members.map((member) => member.email)).toEqual([betaOwner.email]);
    const roles = (await h.pg.query("select distinct role from public.restaurant_users order by 1")).rows.map((row) => row.role);
    expect(roles).toEqual(["manager", "owner", "staff"]);
    // The database will not hold any other role.
    await expect(h.pg.query("update public.restaurant_users set role = 'platform_admin' where user_id = $1", [staff.id])).rejects.toThrow(/check constraint/);
    await expect(h.pg.query("update public.restaurant_users set role = 'admin' where user_id = $1", [staff.id])).rejects.toThrow(/check constraint/);
  });
});

describe("inviting someone", () => {
  it("records the offer, makes an account with no password, and emails the person how to get in", async () => {
    h.sent.length = 0;
    const response = await invite("Dana.Lee@Example.test", "manager");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: "invited", email_sent: true, message: "An invitation has been sent to dana.lee@example.test." });

    const invitation = response.body.team.invitations.find((entry) => entry.email === "dana.lee@example.test");
    expect(invitation).toMatchObject({ role: "manager", status: "pending", invited_by_email: owner.email, email_status: "sent" });
    expect(Object.keys(invitation).sort()).toEqual(["created_at", "email", "email_status", "expires_at", "id", "invited_by_email", "revoked_at", "role", "sent_at", "status"]);
    // Open for a week.
    const days = (Date.parse(invitation.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(response.body.team.limits).toEqual({ invitation_days: 7 });

    // The account exists, with no password: the directory has no way to be given one.
    expect(h.accounts.made.map((account) => account.email)).toContain("dana.lee@example.test");
    expect(h.deps.accounts.ensure.length).toBe(1);

    // The email, to that address and no other.
    expect(h.sent).toHaveLength(1);
    const [email] = h.sent;
    expect(email.to).toBe("dana.lee@example.test");
    expect(email.subject).toBe("You have been invited to the Alpha Kitchen dashboard");
    expect(email.text).toContain(`${owner.email} has invited you to the Alpha Kitchen dashboard as Manager.`);
    expect(email.text).toContain(`${ORIGIN}/dashboard/#/welcome?email=dana.lee%40example.test`);
    expect(email.html).toContain("Dashboard invitation");
    expect(email.attachment).toBeUndefined();
    // It tells the reader to choose a password. It does not contain one: there is none.
    expect(JSON.stringify(email)).not.toMatch(/password is\b|temporary password|password: \S/i);
  });

  it("grants nothing by itself: the invited account has no restaurant until it accepts", async () => {
    const account = await h.signInAs("dana.lee@example.test");
    expect(await memberships(account.id)).toEqual([]);
    for (const [method, path, body] of [["GET", "/me"], ["GET", "/items"], ["GET", "/applications"], ["GET", "/team"], ["POST", "/applications/export", { scope: "all" }]]) {
      const response = await h.api(account, method, path, body);
      expect(response.status, path).toBe(403);
      expect(response.body.error.code, path).toBe("no_restaurant");
    }
  });

  it("sends the set-password link in the email and puts it nowhere else", async () => {
    h.sent.length = 0;
    h.logs.length = 0;
    const response = await invite("link.check@example.test", "staff");
    expect(h.accounts.links.at(-1).email).toBe("link.check@example.test");
    const { link } = h.accounts.links.at(-1);
    // It leads back to this dashboard, on an allowed origin.
    expect(link).toContain(encodeURIComponent(`${ORIGIN}/dashboard/`));
    expect(h.sent[0].text).toContain(link);
    expect(h.sent[0].html).toContain(link.replace(/&/g, "&amp;"));
    expect(h.sent[0].text).toContain("The button works once, and only for a short time.");
    // The fallback that always works is spelled out as well.
    expect(h.sent[0].text).toContain('"Forgot your password?"');

    const secret = link.match(/LINKSECRET\d+/)[0];
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(JSON.stringify(h.logs)).not.toContain(secret);
    for (const table of ["team_invitations", "audit_logs", "integration_logs", "restaurant_users"]) {
      const { rows } = await h.pg.query(`select to_jsonb(t)::text as row from public.${table} t`);
      expect(rows.map((row) => row.row).join("\n"), table).not.toContain(secret);
    }
    // Nor is the invited address written to the log.
    expect(JSON.stringify(h.logs)).not.toContain("link.check@example.test");
  });

  it("does not send a set-password link to an address that already has an account", async () => {
    // An account the operator made by hand, in use, with a password of its own.
    const existing = await h.addUser(null);
    h.accounts.signedIn.add(existing.id);
    h.sent.length = 0;
    const links = h.accounts.links.length;
    const made = h.accounts.made.length;
    expect((await invite(existing.email, "staff")).status).toBe(200);
    expect(h.accounts.made).toHaveLength(made);
    expect(h.accounts.links).toHaveLength(links);
    expect(h.sent[0].text).toContain("sign in with this email address and the password you already have");
    expect(h.sent[0].text).not.toMatch(/auth\.test|LINKSECRET/);
    expect(h.sent[0].text).toContain(`${ORIGIN}/dashboard/#/welcome?email=`);
  });

  it("offers the three roles an owner may give, an owner among them, and nothing that does not exist", async () => {
    const before = await count("public.team_invitations");
    for (const role of ["admin", "platform_admin", "superuser", "OWNER", "", null, 1, ["manager"]]) {
      expect((await invite("role@example.test", role)).status, JSON.stringify(role)).toBe(422);
    }
    // The database holds the three roles and nothing else, whoever asks.
    await expect(h.pg.query(
      "insert into public.team_invitations (restaurant_id, email, role, expires_at) values ($1, 'direct@example.test', 'admin', now() + interval '1 day')", [alpha]))
      .rejects.toThrow(/check constraint/);
    expect(await h.db.rpc("team_invitation_create", {
      p_restaurant: alpha, p_email: "direct@example.test", p_role: "platform_admin", p_actor_email: null, p_ttl_seconds: 60, p_max_open: 25, p_dry_run: false,
    })).toEqual({ refused: "role" });
    expect(await count("public.team_invitations")).toBe(before);

    const asOwner = await invite("partner@example.test", "owner");
    expect(asOwner.status).toBe(200);
    expect(await invitationFor("partner@example.test")).toMatchObject({ role: "owner", status: "pending", invited_by_email: owner.email });
    expect(h.sent.at(-1).text).toContain("to the Alpha Kitchen dashboard as Owner.");
    expect(h.sent.at(-1).text).toContain("You will be able to do everything in the dashboard");
  });

  it("refuses anything in the request that is not an address and a role", async () => {
    for (const body of [
      {}, { email: "x@example.test" }, { role: "manager" }, { email: "not-an-address", role: "manager" }, { email: "a@b", role: "manager" },
      { email: "two@example.test, three@example.test", role: "manager" }, { email: "x@example.test\nbcc: y@example.test", role: "manager" },
      { email: "x@example.test", role: "manager", restaurant_id: beta }, { email: "x@example.test", role: "manager", permissions: ["team.manage"] },
      { email: "x@example.test", role: "manager", user_id: owner.id }, { email: "x@example.test", role: "manager", expires_at: "2099-01-01" },
      { email: `${"a".repeat(250)}@example.test`, role: "manager" }, "x@example.test", [],
    ]) {
      expect((await h.api(owner, "POST", "/team/invitations", body)).status, JSON.stringify(body).slice(0, 70)).toBe(422);
    }
    expect(await invitationFor("x@example.test")).toBeUndefined();
  });

  it("does not invite someone twice, or someone who already has access", async () => {
    h.sent.length = 0;
    const again = await invite("DANA.LEE@example.test", "staff");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_invited");
    const member = await invite(manager.email.toUpperCase(), "staff");
    expect(member.status).toBe(409);
    expect(member.body.error.code).toBe("already_member");
    const self = await invite(owner.email, "manager");
    expect(self.status).toBe(409);
    expect(self.body.error.message).toBe("That is your own address. You already have access.");
    expect(h.sent).toEqual([]);
    expect(await count("public.team_invitations where restaurant_id = $1 and email = 'dana.lee@example.test'", [alpha])).toBe(1);
    expect((await invitationFor("dana.lee@example.test")).role).toBe("manager");

    // Two requests at the same moment for one new address: one invitation, not two.
    const racing = await Promise.all([invite("race@example.test"), invite("race@example.test")]);
    expect(racing.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await count("public.team_invitations where email = 'race@example.test'")).toBe(1);
    // The database refuses a second open invitation whatever the code does.
    await expect(h.pg.query(
      "insert into public.team_invitations (restaurant_id, email, role, expires_at) values ($1, 'race@example.test', 'staff', now() + interval '1 day')", [alpha]))
      .rejects.toThrow(/team_invitations_open_idx/);
  });

  it("keeps the invitation and says so when the email cannot be sent", async () => {
    h.state.emailFails = true;
    const failed = await invite("no.email@example.test", "staff");
    h.state.emailFails = false;
    expect(failed.status).toBe(200);
    expect(failed.body.email_sent).toBe(false);
    expect(failed.body.message).toMatch(/^The invitation is saved, but the email could not be sent\./);
    expect(JSON.stringify(failed.body)).not.toMatch(/provider down/);
    expect(await invitationFor("no.email@example.test")).toMatchObject({ status: "pending", email_status: "failed", sent_at: null });

    // No email service configured at all: the same honest answer.
    const sender = h.deps.email;
    h.deps.email = null;
    const unconfigured = await invite("unconfigured@example.test", "staff");
    h.deps.email = sender;
    expect(unconfigured.body.email_sent).toBe(false);
    expect((await invitationFor("unconfigured@example.test")).email_status).toBe("failed");

    // Sending it again when email works puts it right.
    h.sent.length = 0;
    const resent = await h.api(owner, "POST", `/team/invitations/${(await invitationFor("no.email@example.test")).id}/resend`);
    expect(resent.body).toMatchObject({ result: "sent", email_sent: true });
    expect(h.sent[0].to).toBe("no.email@example.test");
    expect((await invitationFor("no.email@example.test")).email_status).toBe("sent");
  });

  it("still sends the invitation, without the one-click link, when Supabase cannot make that link", async () => {
    h.state.passwordLinkFails = true;
    h.sent.length = 0;
    const response = await invite("no.link@example.test", "staff");
    h.state.passwordLinkFails = false;
    expect(response.body.email_sent).toBe(true);
    expect(h.sent[0].text).not.toMatch(/LINKSECRET/);
    expect(h.sent[0].text).toContain("Set up your access:");
    expect(h.sent[0].text).toContain("No password is ever sent by email. You choose your own.");
  });

  it("stores and sends nothing when the account cannot be prepared", async () => {
    h.state.accountsFail = true;
    h.sent.length = 0;
    h.logs.length = 0;
    const response = await invite("unlucky@example.test", "staff");
    h.state.accountsFail = false;
    expect(response.status).toBe(502);
    expect(response.body.error).toMatchObject({ code: "account_unavailable", retryable: true });
    expect(JSON.stringify(response.body)).not.toMatch(/Supabase|unexpected_failure/);
    expect(await invitationFor("unlucky@example.test")).toBeUndefined();
    expect(h.sent).toEqual([]);
    expect(JSON.stringify(h.logs)).not.toContain("unlucky@example.test");
    // Trying again works.
    expect((await invite("unlucky@example.test", "staff")).status).toBe(200);
  });

  it("writes who was invited, as what and by whom, to the audit log", async () => {
    const { rows } = await h.pg.query("select * from public.audit_logs where action = 'MEMBER_INVITED' and new_values->>'email' = 'dana.lee@example.test'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      restaurant_id: alpha, user_id: owner.id, actor_email: owner.email, entity_type: "team_invitation", result: "success",
      new_values: { email: "dana.lee@example.test", role: "manager", email_sent: true },
    });
  });

  it("cannot be used to pester an address or to pile up invitations", async () => {
    // One address is sent five invitation emails a day at most, however they are asked for.
    await invite("patient@example.test", "staff");
    const { id } = await invitationFor("patient@example.test");
    for (let attempt = 0; attempt < 4; attempt++) expect((await h.api(owner, "POST", `/team/invitations/${id}/resend`)).status).toBe(200);
    h.sent.length = 0;
    const sixth = await h.api(owner, "POST", `/team/invitations/${id}/resend`);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.message).toBe("This address has been sent several invitations today. Try again tomorrow.");
    expect(h.sent).toEqual([]);

    // Twenty invitations an hour per person.
    await seedLimit(`dash:invite:${owner.id}`, 3600, 20);
    expect((await invite("one.too.many@example.test", "staff")).status).toBe(429);
    expect(await invitationFor("one.too.many@example.test")).toBeUndefined();
    await seedLimit(`dash:invite:${owner.id}`, 3600, 0);

    // Twenty-five open invitations per restaurant.
    const gamma = await h.createRestaurant("gamma");
    const boss = await h.addUser(gamma, "owner");
    await h.pg.query(
      `insert into public.team_invitations (restaurant_id, email, role, expires_at)
       select $1, 'filler' || n || '@example.test', 'staff', now() + interval '1 day' from generate_series(1, 25) n`, [gamma]);
    const full = await invite("overflow@example.test", "staff", boss);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("too_many_invitations");
    // One that has run out does not count, and frees a place.
    await h.pg.query("update public.team_invitations set expires_at = now() - interval '1 hour' where restaurant_id = $1 and email = 'filler1@example.test'", [gamma]);
    expect((await invite("overflow@example.test", "staff", boss)).status).toBe(200);
  });
});

describe("accepting an invitation", () => {
  let dana, invitationId;

  it("shows the signed-in addressee what is waiting for them, and nothing about the restaurant beyond its name", async () => {
    dana = await h.signInAs("dana.lee@example.test");
    const response = await h.api(dana, "GET", "/account/invitations");
    expect(response.status).toBe(200);
    expect(response.body.invitations).toHaveLength(1);
    [{ id: invitationId }] = response.body.invitations;
    expect(response.body.invitations[0]).toEqual({
      id: invitationId, restaurant: "Alpha Kitchen", role: "manager", invited_by_email: owner.email, expires_at: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain(alpha);
  });

  it("makes the membership, with the role offered, at the moment of accepting", async () => {
    const accepted = await h.api(dana, "POST", `/account/invitations/${invitationId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ result: "accepted", role: "manager", message: "You now have access to the dashboard." });
    expect(await memberships(dana.id)).toEqual([{ restaurant_id: alpha, role: "manager" }]);

    const me = await h.api(dana, "GET", "/me");
    expect(me.body).toMatchObject({ role: "manager", restaurant: { name: "Alpha Kitchen" } });
    expect(me.body.permissions).not.toContain("team.manage");
    expect((await h.api(dana, "GET", "/applications")).status).toBe(200);
    expect((await h.api(dana, "GET", "/team")).status).toBe(403);

    await h.settle();
    const member = await memberFor("dana.lee@example.test");
    expect(member).toMatchObject({ id: dana.id, role: "manager", invited_by_email: owner.email, role_changed_at: null });
    expect(Date.parse(member.last_seen_at)).toBeGreaterThan(Date.now() - 60_000);
    // It is no longer an invitation, and there is nothing left to accept.
    expect(await invitationFor("dana.lee@example.test")).toBeUndefined();
    expect((await h.api(dana, "GET", "/account/invitations")).body.invitations).toEqual([]);

    const { rows } = await h.pg.query("select * from public.audit_logs where action = 'INVITATION_ACCEPTED' and user_id = $1", [dana.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ restaurant_id: alpha, actor_email: dana.email, entity_type: "team_member", new_values: { role: "manager" } });
  });

  it("answers a second press the same way, and makes nothing twice", async () => {
    const again = await h.api(dana, "POST", `/account/invitations/${invitationId}/accept`);
    expect(again.status).toBe(200);
    expect(await memberships(dana.id)).toHaveLength(1);
    expect(await count("public.audit_logs where action = 'INVITATION_ACCEPTED' and user_id = $1", [dana.id])).toBe(1);
  });

  it("is only for the account whose own, confirmed address it was sent to", async () => {
    await invite("target@example.test", "manager");
    const { id } = await invitationFor("target@example.test");

    // Someone else, signed in, who has learned the invitation's id.
    const stranger = await h.addUser(null);
    expect((await h.api(stranger, "GET", "/account/invitations")).body.invitations).toEqual([]);
    const stolen = await h.api(stranger, "POST", `/account/invitations/${id}/accept`);
    expect(stolen.status).toBe(404);
    expect(stolen.body.error.message).toBe("This invitation does not exist.");
    // A member of the restaurant cannot take it either, nor another restaurant's owner.
    for (const user of [staff, manager, betaOwner]) expect((await h.api(user, "POST", `/account/invitations/${id}/accept`)).status).toBe(404);
    // Nobody without a session, or with a made-up one.
    expect((await h.api(null, "POST", `/account/invitations/${id}/accept`)).status).toBe(401);
    expect((await h.api({ token: "jwt-forged" }, "GET", "/account/invitations")).status).toBe(401);
    // The address in the request is not what counts: there is none to send.
    expect((await h.api(stranger, "POST", `/account/invitations/${id}/accept`, { email: "target@example.test" })).status).toBe(404);

    // The right address, but Supabase Auth has not confirmed that the account holds it.
    const unconfirmed = await h.signInAs("target@example.test", { emailVerified: false });
    expect((await h.api(unconfirmed, "GET", "/account/invitations")).body.invitations).toEqual([]);
    expect((await h.api(unconfirmed, "POST", `/account/invitations/${id}/accept`)).status).toBe(404);
    expect(await memberships(unconfirmed.id)).toEqual([]);

    // Two-step sign-in applies here as everywhere: the password alone accepts nothing.
    const halfSignedIn = await h.signInAs("target@example.test", { twoStep: true, level: "aal1" });
    const refused = await h.api(halfSignedIn, "POST", `/account/invitations/${id}/accept`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("mfa_required");
    expect((await h.api(halfSignedIn, "GET", "/account/invitations")).body.error.code).toBe("mfa_required");

    // After all of that the invitation is untouched and nobody has been let in.
    expect((await invitationFor("target@example.test")).status).toBe("pending");
    expect(await count("public.restaurant_users where restaurant_id = $1 and email = 'target@example.test'", [alpha])).toBe(0);

    // The addressee, properly signed in, is. Capitals in the address make no difference.
    const target = await h.signInAs("target@example.test", { email: "Target@EXAMPLE.test" });
    expect((await h.api(target, "GET", "/account/invitations")).body.invitations).toHaveLength(1);
    expect((await h.api(target, "POST", `/account/invitations/${id}/accept`)).status).toBe(200);
    expect(await memberships(target.id)).toEqual([{ restaurant_id: alpha, role: "manager" }]);
  });

  it("answers an id that is not one, and one that does not exist, without detail", async () => {
    const account = await h.addUser(null);
    expect((await h.api(account, "POST", `/account/invitations/${NOBODY}/accept`)).status).toBe(404);
    for (const bad of ["not-an-id", "1", "' or 1=1 --", `${NOBODY}x`]) {
      expect((await h.api(account, "POST", `/account/invitations/${encodeURIComponent(bad)}/accept`)).status, bad).toBe(404);
    }
    expect((await h.api(account, "GET", `/account/invitations/${NOBODY}/accept`)).status).toBe(405);
    expect((await h.api(account, "DELETE", "/account/invitations")).status).toBe(405);
  });

  it("cannot be accepted once it has expired, until the owner sends it again", async () => {
    await invite("late@example.test", "staff");
    const { id } = await invitationFor("late@example.test");
    await h.pg.query("update public.team_invitations set expires_at = now() - interval '1 minute' where id = $1", [id]);
    expect((await invitationFor("late@example.test")).status).toBe("expired");

    const late = await h.signInAs("late@example.test");
    expect((await h.api(late, "GET", "/account/invitations")).body.invitations).toEqual([]);
    const refused = await h.api(late, "POST", `/account/invitations/${id}/accept`);
    expect(refused.status).toBe(410);
    expect(refused.body.error).toMatchObject({ code: "invitation_expired", message: "This invitation has expired. Ask for it to be sent again." });
    expect(await memberships(late.id)).toEqual([]);
    expect((await h.api(late, "GET", "/me")).body.error.code).toBe("no_restaurant");

    // Inviting the same address again renews the invitation that ran out: still one row.
    h.sent.length = 0;
    const reinvited = await invite("late@example.test", "manager");
    expect(reinvited.status).toBe(200);
    expect(await count("public.team_invitations where email = 'late@example.test'")).toBe(1);
    expect(await invitationFor("late@example.test")).toMatchObject({ id, status: "pending", role: "manager" });
    // The account has been signed in to by now, so no set-password link is sent unasked.
    expect(h.sent[0].text).not.toMatch(/LINKSECRET/);

    await h.pg.query("update public.team_invitations set expires_at = now() - interval '1 minute' where id = $1", [id]);
    expect((await h.api(late, "POST", `/account/invitations/${id}/accept`)).status).toBe(410);
    // "Send again" opens it for another week.
    expect((await h.api(owner, "POST", `/team/invitations/${id}/resend`)).status).toBe(200);
    expect((await invitationFor("late@example.test")).status).toBe("pending");
    expect((await h.api(late, "POST", `/account/invitations/${id}/accept`)).status).toBe(200);
    expect(await memberships(late.id)).toEqual([{ restaurant_id: alpha, role: "manager" }]);
  });

  it("cannot be accepted once the owner has cancelled it, and cancelling cannot be undone by sending again", async () => {
    await invite("cancelled@example.test", "manager");
    const { id } = await invitationFor("cancelled@example.test");
    const account = await h.signInAs("cancelled@example.test");
    expect((await h.api(account, "GET", "/account/invitations")).body.invitations).toHaveLength(1);

    const cancelled = await h.api(owner, "DELETE", `/team/invitations/${id}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ result: "cancelled", message: "The invitation to cancelled@example.test has been cancelled. It can no longer be accepted." });
    expect(await invitationFor("cancelled@example.test")).toMatchObject({ status: "revoked", revoked_at: expect.any(String) });

    expect((await h.api(account, "GET", "/account/invitations")).body.invitations).toEqual([]);
    const refused = await h.api(account, "POST", `/account/invitations/${id}/accept`);
    expect(refused.status).toBe(410);
    expect(refused.body.error.code).toBe("invitation_revoked");
    expect(await memberships(account.id)).toEqual([]);
    // A cancelled invitation is closed: it cannot be sent again or cancelled again.
    expect((await h.api(owner, "POST", `/team/invitations/${id}/resend`)).status).toBe(404);
    expect((await h.api(owner, "DELETE", `/team/invitations/${id}`)).status).toBe(404);
    expect((await h.api(account, "POST", `/account/invitations/${id}/accept`)).status).toBe(410);

    const { rows } = await h.pg.query("select actor_email, old_values from public.audit_logs where action = 'INVITATION_CANCELLED' and entity_id = $1", [id]);
    expect(rows).toEqual([{ actor_email: owner.email, old_values: { email: "cancelled@example.test", role: "manager" } }]);
    // The owner can still invite the person afresh: a new invitation, not the old one.
    expect((await invite("cancelled@example.test", "staff")).status).toBe(200);
    expect((await invitationFor("cancelled@example.test")).id).not.toBe(id);
    expect((await h.api(account, "POST", `/account/invitations/${id}/accept`)).status).toBe(410);
  });

  it("does not give a second restaurant to an account that already belongs to one", async () => {
    await invite(betaOwner.email, "manager");
    const { id } = await invitationFor(betaOwner.email);
    // Listed, because it is theirs to see; but accepting it is refused, and says why.
    const refused = await h.api(betaOwner, "POST", `/account/invitations/${id}/accept`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("account_in_use");
    expect(await memberships(betaOwner.id)).toEqual([{ restaurant_id: beta, role: "owner" }]);
    expect((await h.api(betaOwner, "GET", "/me")).body.restaurant.name).toBe("Beta Bistro");
    await h.api(owner, "DELETE", `/team/invitations/${id}`);
  });

  it("never changes the role of someone who is already a member, least of all an owner's", async () => {
    // The backend refuses to invite a member, so such an invitation can only be put there
    // by hand. Even then, accepting it changes nothing about the membership.
    const { rows } = await h.pg.query(
      "insert into public.team_invitations (restaurant_id, email, role, expires_at) values ($1, $2, 'staff', now() + interval '1 day') returning id", [alpha, owner.email]);
    const accepted = await h.api(owner, "POST", `/account/invitations/${rows[0].id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.role).toBe("owner");
    expect(await memberships(owner.id)).toEqual([{ restaurant_id: alpha, role: "owner" }]);
    expect((await h.api(owner, "GET", "/team")).status).toBe(200);
  });
});

describe("changing a role", () => {
  let dana;
  beforeAll(async () => { dana = await h.signInAs("dana.lee@example.test"); });

  it("takes effect on the member's very next request, with the session they already hold", async () => {
    expect((await h.api(dana, "GET", "/applications")).status).toBe(200);
    const changed = await h.api(owner, "PATCH", `/team/members/${dana.id}`, { role: "staff" });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ result: "saved", message: "dana.lee@example.test is now Staff." });
    expect(changed.body.team.members.find((member) => member.id === dana.id)).toMatchObject({ role: "staff", role_changed_at: expect.any(String) });

    // The same token as before. No signing out, no waiting.
    expect((await h.api(dana, "GET", "/me")).body).toMatchObject({ role: "staff", permissions: ["menu.read"] });
    for (const [method, path, body] of [["GET", "/applications"], ["GET", "/activity"], ["POST", "/labels", { name: "X", icon: "leaf" }], ["POST", "/clover/sync"]]) {
      expect((await h.api(dana, method, path, body)).status, path).toBe(403);
    }
    expect((await h.api(dana, "GET", "/items")).status).toBe(200);

    const { rows } = await h.pg.query("select actor_email, old_values, new_values from public.audit_logs where action = 'MEMBER_ROLE_CHANGED' and entity_id = $1", [dana.id]);
    expect(rows).toEqual([{ actor_email: owner.email, old_values: { role: "manager", email: "dana.lee@example.test" }, new_values: { role: "staff" } }]);

    // The same role again changes nothing and records nothing.
    expect((await h.api(owner, "PATCH", `/team/members/${dana.id}`, { role: "staff" })).body.message).toBe("Nothing changed.");
    expect(await count("public.audit_logs where action = 'MEMBER_ROLE_CHANGED' and entity_id = $1", [dana.id])).toBe(1);
    // And back to manager.
    expect((await h.api(owner, "PATCH", `/team/members/${dana.id}`, { role: "manager" })).status).toBe(200);
    expect((await h.api(dana, "GET", "/applications")).status).toBe(200);
  });

  it("makes a member an owner, with everything an owner may do, at their very next request", async () => {
    const promoted = await h.api(owner, "PATCH", `/team/members/${dana.id}`, { role: "owner" });
    expect(promoted.status).toBe(200);
    expect(promoted.body.message).toBe("dana.lee@example.test is now Owner.");
    const me = (await h.api(dana, "GET", "/me")).body;
    expect(me.role).toBe("owner");
    expect([...me.permissions].sort()).toEqual([...ROLE_PERMISSIONS.owner].sort());
    expect((await h.api(dana, "GET", "/team")).status).toBe(200);
    expect((await h.api(dana, "POST", "/applications/export/preview", { scope: "all" })).status).toBe(200);
    const { rows } = await h.pg.query("select new_values from public.audit_logs where action = 'MEMBER_ROLE_CHANGED' and entity_id = $1 order by id desc limit 1", [dana.id]);
    expect(rows[0].new_values).toEqual({ role: "owner" });

    // An owner may change or remove another owner, as long as one remains: here, two do.
    expect((await h.api(owner, "PATCH", `/team/members/${dana.id}`, { role: "manager" })).status).toBe(200);
    expect((await h.api(dana, "GET", "/team")).status).toBe(403);
    expect(await memberships(dana.id)).toEqual([{ restaurant_id: alpha, role: "manager" }]);
  });

  it("never changes anyone's own role, nor a role that does not exist", async () => {
    for (const role of ["admin", "platform_admin", "", null, 3]) {
      expect((await h.api(owner, "PATCH", `/team/members/${dana.id}`, { role })).status, JSON.stringify(role)).toBe(422);
    }
    expect((await h.api(owner, "PATCH", `/team/members/${dana.id}`, { role: "staff", permissions: ["team.manage"] })).status).toBe(422);
    expect(await memberships(dana.id)).toEqual([{ restaurant_id: alpha, role: "manager" }]);

    const self = await h.api(owner, "PATCH", `/team/members/${owner.id}`, { role: "staff" });
    expect(self.status).toBe(403);
    expect(self.body.error).toMatchObject({ code: "self_change", message: "You cannot change or remove your own access. Ask another owner." });
    expect(await memberships(owner.id)).toEqual([{ restaurant_id: alpha, role: "owner" }]);
  });

  it("always leaves the restaurant an owner, also when two owners act on each other at once", async () => {
    const partner = await join("partner.two@example.test", "owner");
    expect(await memberships(partner.id)).toEqual([{ restaurant_id: alpha, role: "owner" }]);
    expect(await count("public.restaurant_users where restaurant_id = $1 and role = 'owner'", [alpha])).toBe(2);

    // Each makes the other staff at the same moment. The database takes them one after the
    // other: the first goes through, and by the second its sender is no longer an owner.
    const results = await Promise.all([
      h.api(owner, "PATCH", `/team/members/${partner.id}`, { role: "staff" }),
      h.api(partner, "PATCH", `/team/members/${owner.id}`, { role: "staff" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 403]);
    expect(await count("public.restaurant_users where restaurant_id = $1 and role = 'owner'", [alpha])).toBe(1);

    // Put the restaurant back as the rest of this file expects it.
    await h.pg.query("update public.restaurant_users set role = 'owner' where user_id = $1", [owner.id]);
    await h.pg.query("delete from public.restaurant_users where user_id = $1", [partner.id]);
  });

  it("is refused by the database to anyone who is not, or no longer, an owner, and to anyone acting on themselves", async () => {
    // Why the last owner can never go: the one acting must be an owner, cannot act on
    // themselves, and holds the restaurant's lock while acting, so another owner (they) remains.
    for (const actor of [NOBODY, manager.id, staff.id, betaOwner.id]) {
      expect(await h.db.rpc("team_member_set_role", { p_restaurant: alpha, p_user: owner.id, p_role: "staff", p_actor: actor }), actor).toEqual({ refused: "not_owner" });
      expect(await h.db.rpc("team_member_set_role", { p_restaurant: alpha, p_user: dana.id, p_role: "owner", p_actor: actor }), actor).toEqual({ refused: "not_owner" });
      expect(await h.db.rpc("team_member_remove", { p_restaurant: alpha, p_user: owner.id, p_actor: actor }), actor).toEqual({ refused: "not_owner" });
    }
    expect(await h.db.rpc("team_member_set_role", { p_restaurant: alpha, p_user: owner.id, p_role: "staff", p_actor: owner.id })).toEqual({ refused: "self" });
    expect(await h.db.rpc("team_member_remove", { p_restaurant: alpha, p_user: owner.id, p_actor: owner.id })).toEqual({ refused: "self" });
    expect(await memberships(owner.id)).toEqual([{ restaurant_id: alpha, role: "owner" }]);
    expect(await memberships(dana.id)).toEqual([{ restaurant_id: alpha, role: "manager" }]);
  });

  it("is refused to managers and staff, who cannot promote themselves or anyone else", async () => {
    for (const user of [manager, staff, dana]) {
      for (const [method, path, body] of [
        ["PATCH", `/team/members/${user.id}`, { role: "owner" }], ["PATCH", `/team/members/${user.id}`, { role: "manager" }],
        ["PATCH", `/team/members/${staff.id}`, { role: "manager" }], ["DELETE", `/team/members/${owner.id}`],
        ["POST", "/team/invitations", { email: "friend@example.test", role: "manager" }], ["GET", "/team"],
      ]) {
        const response = await h.api(user, method, path, body);
        expect(response.status, `${user.email} ${method} ${path}`).toBe(403);
        expect(response.body.error.code).toBe("forbidden");
      }
    }
    expect(await memberships(manager.id)).toEqual([{ restaurant_id: alpha, role: "manager" }]);
    expect(await memberships(staff.id)).toEqual([{ restaurant_id: alpha, role: "staff" }]);
    expect(await memberships(owner.id)).toEqual([{ restaurant_id: alpha, role: "owner" }]);
    expect(await invitationFor("friend@example.test")).toBeUndefined();
    // Nothing a request carries is taken as a role.
    expect((await h.api(manager, "GET", "/team", undefined, { "x-role": "owner", "x-restaurant-role": "owner" })).status).toBe(403);
    expect((await h.api(manager, "GET", "/me?role=owner")).body.role).toBe("manager");
  });

  it("answers a member id from another restaurant exactly like one that does not exist", async () => {
    for (const id of [betaOwner.id, NOBODY]) {
      const change = await h.api(owner, "PATCH", `/team/members/${id}`, { role: "staff" });
      expect(change.status).toBe(404);
      expect(change.body.error.message).toBe("This person is not a member of this restaurant.");
      expect((await h.api(owner, "DELETE", `/team/members/${id}`)).status).toBe(404);
    }
    expect((await h.api(owner, "PATCH", "/team/members/not-an-id", { role: "staff" })).status).toBe(404);
    expect(await memberships(betaOwner.id)).toEqual([{ restaurant_id: beta, role: "owner" }]);
  });
});

describe("taking access away", () => {
  let leaver, application;
  const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");

  beforeAll(async () => {
    leaver = await join("leaver@example.test", "manager");
    application = (await h.pg.query(
      `insert into public.job_applications (restaurant_id, full_name, email, phone, position, cv_path, cv_original_name, cv_mime)
       values ($1, 'Robin Example', 'robin@example.test', '+1 619 555 0199', 'Barista', $2, 'robin.pdf', 'application/pdf') returning id`,
      [alpha, `${alpha}/robin.pdf`])).rows[0].id;
    h.stored.set(`cvs/${alpha}/robin.pdf`, { bytes: pdf, contentType: "application/pdf" });
  });

  it("ends every kind of access at once, for the session the person already holds", async () => {
    // Before: a manager at work, with a CV they may download.
    expect((await h.api(leaver, "GET", `/applications/${application}`)).body.application.full_name).toBe("Robin Example");
    expect([...(await h.api(leaver, "GET", `/applications/${application}/cv`)).bytes]).toEqual([...pdf]);
    const before = {
      applications: await count("public.job_applications where restaurant_id = $1", [alpha]),
      items: await count("public.menu_items where restaurant_id = $1", [alpha]),
      audit: await count("public.audit_logs where restaurant_id = $1 and user_id = $2", [alpha, leaver.id]),
    };

    const removed = await h.api(owner, "DELETE", `/team/members/${leaver.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ result: "removed", message: "leaver@example.test no longer has access to the dashboard." });
    expect(removed.body.team.members.some((member) => member.id === leaver.id)).toBe(false);

    // After: the same token, the very next request. Nothing is answered any more.
    const attempts = [
      ["GET", "/me"], ["GET", "/overview"], ["GET", "/items"], ["GET", "/applications"], ["GET", `/applications/${application}`],
      ["GET", `/applications/${application}/cv`], ["PATCH", `/applications/${application}`, { status: "hired" }],
      ["DELETE", `/applications/${application}`], ["POST", "/applications/export", { scope: "all" }], ["GET", "/activity"],
      ["GET", "/team"], ["POST", "/clover/sync"], ["GET", "/site/photos"], ["POST", "/labels", { name: "After", icon: "leaf" }],
    ];
    for (const [method, path, body] of attempts) {
      const response = await h.api(leaver, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.error.code, `${method} ${path}`).toBe("no_restaurant");
      expect(JSON.stringify(response.body), path).not.toMatch(/Robin|robin@|619 555/);
      expect(response.bytes, path).toBeUndefined();
    }
    // Naming the restaurant does not help, and there is no invitation to fall back on.
    expect((await h.api(leaver, "GET", "/applications", undefined, { "x-restaurant-id": alpha })).status).toBe(403);
    expect((await h.api(leaver, "GET", "/account/invitations")).body.invitations).toEqual([]);

    // Only the membership went. The restaurant, its records, the CV, the person's account
    // and the record of what they did are all still there.
    expect(await memberships(leaver.id)).toEqual([]);
    expect(await count("public.job_applications where restaurant_id = $1", [alpha])).toBe(before.applications);
    expect(await count("public.menu_items where restaurant_id = $1", [alpha])).toBe(before.items);
    expect(await count("public.audit_logs where restaurant_id = $1 and user_id = $2", [alpha, leaver.id])).toBe(before.audit);
    expect(h.stored.has(`cvs/${alpha}/robin.pdf`)).toBe(true);
    expect(await count("auth.users where id = $1", [leaver.id])).toBe(1);
    expect(await count("public.restaurants where id = $1", [alpha])).toBe(1);
    expect((await h.api(owner, "GET", `/applications/${application}`)).body.application.status).toBe("new");

    const { rows } = await h.pg.query("select actor_email, old_values from public.audit_logs where action = 'MEMBER_REMOVED' and entity_id = $1", [leaver.id]);
    expect(rows).toEqual([{ actor_email: owner.email, old_values: { role: "manager", email: "leaver@example.test" } }]);
  });

  it("cannot be undone by replaying the invitation that was accepted", async () => {
    const { rows } = await h.pg.query("select id from public.team_invitations where email = 'leaver@example.test' and accepted_at is not null");
    const replay = await h.api(leaver, "POST", `/account/invitations/${rows[0].id}/accept`);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("invitation_used");
    expect(await memberships(leaver.id)).toEqual([]);
    expect((await h.api(leaver, "GET", "/me")).status).toBe(403);
  });

  it("lets the owner invite the same person back, with a new invitation they must accept again", async () => {
    h.sent.length = 0;
    expect((await invite("leaver@example.test", "staff")).status).toBe(200);
    // Not in until it is accepted.
    expect((await h.api(leaver, "GET", "/me")).status).toBe(403);
    const [waiting] = (await h.api(leaver, "GET", "/account/invitations")).body.invitations;
    expect((await h.api(leaver, "POST", `/account/invitations/${waiting.id}/accept`)).status).toBe(200);
    expect((await h.api(leaver, "GET", "/me")).body.role).toBe("staff");
    expect((await h.api(leaver, "GET", `/applications/${application}/cv`)).status).toBe(403);
  });

  it("is never something a person does to themselves, and removes another owner only while one remains", async () => {
    const self = await h.api(owner, "DELETE", `/team/members/${owner.id}`);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("self_change");
    expect(await h.db.rpc("team_member_remove", { p_restaurant: alpha, p_user: owner.id, p_actor: owner.id })).toEqual({ refused: "self" });
    expect(await h.db.rpc("team_member_remove", { p_restaurant: alpha, p_user: owner.id, p_actor: NOBODY })).toEqual({ refused: "not_owner" });
    expect(await memberships(owner.id)).toEqual([{ restaurant_id: alpha, role: "owner" }]);
    expect((await h.api(owner, "GET", "/team")).status).toBe(200);

    // A second owner is removed by the first: their access ends at once, the first stays.
    const coOwner = await join("co.owner@example.test", "owner");
    expect((await h.api(coOwner, "GET", "/team")).status).toBe(200);
    const removed = await h.api(owner, "DELETE", `/team/members/${coOwner.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.message).toBe("co.owner@example.test no longer has access to the dashboard.");
    expect((await h.api(coOwner, "GET", "/team")).status).toBe(403);
    expect(await count("public.restaurant_users where restaurant_id = $1 and role = 'owner'", [alpha])).toBe(1);
  });
});

describe("one restaurant and another", () => {
  it("shows each owner their own team and invitations, and none of the other's", async () => {
    const mine = await team(betaOwner);
    expect(mine.members.map((member) => member.email)).toEqual([betaOwner.email]);
    expect(mine.invitations).toEqual([]);
    expect(mine.you).toBe(betaOwner.id);
    expect(mine.roles).toEqual(["owner", "manager", "staff"]);
    expect(JSON.stringify(mine)).not.toMatch(/dana\.lee|alpha|Alpha Kitchen/);
    // Asking for the other restaurant by its id is refused outright.
    expect((await h.api(betaOwner, "GET", "/team", undefined, { "x-restaurant-id": alpha })).status).toBe(403);
    expect((await h.api(betaOwner, "POST", "/team/invitations", { email: "spy@example.test", role: "manager" }, { "x-restaurant-id": alpha })).status).toBe(403);
    expect(await invitationFor("spy@example.test")).toBeUndefined();
  });

  it("answers another restaurant's invitation and member ids as if they did not exist", async () => {
    await invite("guarded@example.test", "manager");
    const { id } = await invitationFor("guarded@example.test");
    const dana = await h.signInAs("dana.lee@example.test");
    expect((await h.api(betaOwner, "POST", `/team/invitations/${id}/resend`)).status).toBe(404);
    expect((await h.api(betaOwner, "DELETE", `/team/invitations/${id}`)).status).toBe(404);
    expect((await h.api(betaOwner, "PATCH", `/team/members/${dana.id}`, { role: "staff" })).status).toBe(404);
    expect((await h.api(betaOwner, "DELETE", `/team/members/${dana.id}`)).status).toBe(404);
    expect((await invitationFor("guarded@example.test")).status).toBe("pending");
    expect(await memberships(dana.id)).toEqual([{ restaurant_id: alpha, role: "manager" }]);

    // The same address can be invited by both restaurants: each has its own invitation.
    expect((await invite("guarded@example.test", "staff", betaOwner)).status).toBe(200);
    expect((await invitationFor("guarded@example.test", betaOwner)).id).not.toBe(id);
    const guarded = await h.signInAs("guarded@example.test");
    const waiting = (await h.api(guarded, "GET", "/account/invitations")).body.invitations;
    expect(waiting.map((entry) => entry.restaurant).sort()).toEqual(["Alpha Kitchen", "Beta Bistro"]);
    // Accepting one gives that restaurant and that role, and nothing in the other.
    const alphaInvitation = waiting.find((entry) => entry.restaurant === "Alpha Kitchen");
    expect((await h.api(guarded, "POST", `/account/invitations/${alphaInvitation.id}/accept`)).status).toBe(200);
    expect(await memberships(guarded.id)).toEqual([{ restaurant_id: alpha, role: "manager" }]);
    expect((await team(betaOwner)).members.map((member) => member.email)).toEqual([betaOwner.email]);
  });
});

describe("what the database itself refuses", () => {
  it("keeps the new table and every new function closed to the public roles, with row level security on", async () => {
    const functions = [
      "team_list(uuid)", "team_invitation_create(uuid, text, text, text, integer, integer, boolean)", "team_invitation_open(uuid, uuid)",
      "team_invitation_renew(uuid, uuid, integer)", "team_invitation_revoke(uuid, uuid, text)", "team_invitation_accept(uuid, uuid, text)",
      "team_invitation_set_account(uuid, uuid, uuid)", "team_invitation_set_email_status(uuid, uuid, text)", "account_invitations(text)",
      "team_member_set_role(uuid, uuid, text, uuid)", "team_member_remove(uuid, uuid, uuid)", "team_member_seen(uuid, uuid, text)",
      "dash_applications_export(uuid, text, text, text, timestamptz, timestamptz, uuid[], integer, boolean)",
      "_applications_matching(uuid, text, text, text, timestamptz, timestamptz)", "_like_pattern(text)",
      "_invitation_status(public.team_invitations)", "_invitation_json(public.team_invitations)",
    ];
    for (const role of ["anon", "authenticated"]) {
      const table = await h.pg.query("select has_table_privilege($1, 'public.team_invitations', 'select, insert, update, delete') as open", [role]);
      expect(table.rows[0].open, `${role} on team_invitations`).toBe(false);
      for (const fn of functions) {
        const { rows } = await h.pg.query("select has_function_privilege($1, $2, 'execute') as open", [role, `public.${fn}`]);
        expect(rows[0].open, `${role} on ${fn}`).toBe(false);
      }
      await h.pg.exec(`set role ${role}`);
      await expect(h.pg.query("select * from public.team_invitations")).rejects.toThrow(/permission denied/);
      await expect(h.pg.query("select email from public.restaurant_users")).rejects.toThrow(/permission denied/);
      await expect(h.pg.query("select public.team_list($1)", [alpha])).rejects.toThrow(/permission denied/);
      await expect(h.pg.query("select public.team_invitation_accept($1, $2, 'x@example.test')", [NOBODY, NOBODY])).rejects.toThrow(/permission denied/);
      await expect(h.pg.query("insert into public.restaurant_users (restaurant_id, user_id, role) values ($1, $2, 'owner')", [alpha, NOBODY])).rejects.toThrow(/permission denied/);
      await h.pg.exec("reset role");
    }
    for (const fn of functions) {
      const { rows } = await h.pg.query("select has_function_privilege('service_role', $1, 'execute') as open", [`public.${fn}`]);
      expect(rows[0].open, `service_role on ${fn}`).toBe(true);
    }
    const security = await h.pg.query("select relrowsecurity from pg_class where oid = 'public.team_invitations'::regclass");
    expect(security.rows[0].relrowsecurity).toBe(true);
    expect((await h.pg.query("select count(*)::int as n from pg_policies where schemaname = 'public'")).rows[0].n).toBe(0);
    // None of this migration's functions runs with its owner's rights.
    expect((await h.pg.query("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef")).rows).toEqual([]);
  });

  it("accepts an invitation only for the address it names, whoever calls the function", async () => {
    await invite("exact@example.test", "staff");
    const { id } = await invitationFor("exact@example.test");
    const stranger = await h.addUser(null);
    expect(await h.db.rpc("team_invitation_accept", { p_id: id, p_user: stranger.id, p_email: stranger.email })).toEqual({ refused: "not_found" });
    expect(await h.db.rpc("team_invitation_accept", { p_id: id, p_user: stranger.id, p_email: "" })).toEqual({ refused: "not_found" });
    expect(await h.db.rpc("team_invitation_accept", { p_id: id, p_user: stranger.id, p_email: "%" })).toEqual({ refused: "not_found" });
    expect(await memberships(stranger.id)).toEqual([]);
    // An invitation is always tied to a restaurant that exists, and goes with it.
    await expect(h.pg.query("insert into public.team_invitations (restaurant_id, email, role, expires_at) values ($1, 'x@example.test', 'staff', now())", [NOBODY]))
      .rejects.toThrow(/foreign key/);
    // An address is kept in lower case, so one person is one address.
    await expect(h.pg.query("insert into public.team_invitations (restaurant_id, email, role, expires_at) values ($1, 'Upper@Example.test', 'staff', now())", [alpha]))
      .rejects.toThrow(/check constraint/);
  });

  it("forgets the address of someone who never joined, ninety days after the invitation closed", async () => {
    const delta = await h.createRestaurant("delta");
    const boss = await h.addUser(delta, "owner");
    await h.pg.query(
      `insert into public.team_invitations (restaurant_id, email, role, expires_at, revoked_at, accepted_at) values
        ($1, 'old.expired@example.test', 'staff', now() - interval '100 days', null, null),
        ($1, 'old.cancelled@example.test', 'staff', now() + interval '1 day', now() - interval '91 days', null),
        ($1, 'recent.expired@example.test', 'staff', now() - interval '20 days', null, null),
        ($1, 'joined.long.ago@example.test', 'staff', now() - interval '300 days', null, now() - interval '305 days')`, [delta]);
    expect((await invite("new@example.test", "staff", boss)).status).toBe(200);
    const left = (await h.pg.query("select email from public.team_invitations where restaurant_id = $1 order by email", [delta])).rows.map((row) => row.email);
    expect(left).toEqual(["joined.long.ago@example.test", "new@example.test", "recent.expired@example.test"]);
    // The list shows what is open, and what closed in the last thirty days.
    expect((await team(boss)).invitations.map((entry) => `${entry.email}:${entry.status}`)).toEqual(["new@example.test:pending", "recent.expired@example.test:expired"]);
  });
});

describe("what the activity log shows of the team", () => {
  it("names the person to the owner, and to nobody else", async () => {
    const forOwner = (await h.api(owner, "GET", "/activity")).body.entries;
    const invited = forOwner.find((entry) => entry.action === "MEMBER_INVITED");
    expect(invited.new_values.email).toMatch(/@example\.test$/);
    expect(invited.entity_id).toMatch(/^[0-9a-f-]{36}$/);

    const forManager = (await h.api(manager, "GET", "/activity")).body.entries;
    const teamEntries = forManager.filter((entry) => ["team_member", "team_invitation"].includes(entry.entity_type));
    expect(teamEntries.length).toBeGreaterThan(0);
    // That it happened, when and by whom: yes. Who it was about: no.
    for (const entry of teamEntries) {
      expect(entry).toMatchObject({ old_values: null, new_values: null, entity_id: null, actor_email: expect.any(String) });
    }
    const invitedAddresses = forOwner.flatMap((entry) => [entry.new_values?.email, entry.old_values?.email]).filter(Boolean);
    expect(invitedAddresses.length).toBeGreaterThan(3);
    const actors = new Set(forManager.map((entry) => entry.actor_email));
    for (const address of invitedAddresses.filter((entry) => !actors.has(entry))) expect(JSON.stringify(forManager)).not.toContain(address);
    // Other entries are untouched.
    expect(forManager.filter((entry) => !["team_member", "team_invitation"].includes(entry.entity_type)).length)
      .toBe(forOwner.filter((entry) => !["team_member", "team_invitation"].includes(entry.entity_type)).length);
  });

  it("gives the overview's recent activity only to those who may open the log", async () => {
    expect((await h.api(owner, "GET", "/overview")).body.recent_activity.length).toBeGreaterThan(0);
    const forManager = (await h.api(manager, "GET", "/overview")).body.recent_activity;
    expect(forManager.length).toBeGreaterThan(0);
    for (const entry of forManager.filter((candidate) => ["team_member", "team_invitation"].includes(candidate.entity_type))) expect(entry.new_values).toBeNull();
    // Staff may not open the log (403), and are not handed its latest entries here either.
    expect((await h.api(staff, "GET", "/activity")).status).toBe(403);
    const forStaff = await h.api(staff, "GET", "/overview");
    expect(forStaff.status).toBe(200);
    expect(forStaff.body.recent_activity).toEqual([]);
    expect(JSON.stringify(forStaff.body)).not.toMatch(/MEMBER_|INVITATION_|example\.test/);
  });
});

describe("what the invitation email says", () => {
  const base = { restaurantName: "Luzena <Restaurant> & Cafe", role: "manager", inviterEmail: "owner@example.test", welcomeUrl: "https://site.test/dashboard/#/welcome?email=a%40b.test", expiresAt: "2026-10-20T12:00:00.000Z" };

  it("has three forms: a link to choose a password, the way without it, and for someone who has an account", () => {
    const withLink = invitationEmail({ ...base, passwordLink: "https://auth.test/verify?token=abc&type=recovery", hasAccount: false });
    expect(withLink.subject).toBe("You have been invited to the Luzena <Restaurant> & Cafe dashboard");
    expect(withLink.text).toContain("Choose your password:\nhttps://auth.test/verify?token=abc&type=recovery");
    expect(withLink.text).toContain("This invitation is open until October 20, 2026.");
    expect(withLink.text).toContain("You will be able to manage the menu and the website's photos, and read and handle job applications.");

    const withoutLink = invitationEmail({ ...base, passwordLink: null, hasAccount: false });
    expect(withoutLink.text).toContain("Set up your access:\nhttps://site.test/dashboard/#/welcome?email=a%40b.test");
    expect(withoutLink.text).not.toContain("auth.test");

    const existing = invitationEmail({ ...base, role: "staff", passwordLink: "https://auth.test/should-not-appear", hasAccount: true });
    expect(existing.text).toContain("Open the dashboard:\nhttps://site.test/dashboard/#/welcome?email=a%40b.test");
    expect(existing.text).toContain("as Staff.");
    expect(existing.text).not.toContain("should-not-appear");
    expect(existing.html).not.toContain("should-not-appear");

    for (const email of [withLink, withoutLink, existing]) {
      expect(email.text).toContain("If you were not expecting this, you can ignore it: nothing happens unless you sign in and accept.");
      expect(email.text).not.toMatch(/\n\n\n/);
    }
  });

  it("puts names and addresses into the HTML as text, never as markup", () => {
    const email = invitationEmail({ ...base, inviterEmail: '"><img src=x onerror=alert(1)>@example.test', passwordLink: 'https://auth.test/v?a=1&b="2"', hasAccount: false });
    expect(email.html).toContain("Luzena &lt;Restaurant&gt; &amp; Cafe");
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("<Restaurant>");
    expect(email.html).toContain('href="https://auth.test/v?a=1&amp;b=&quot;2&quot;"');
    // Without an inviter's address it still reads properly.
    expect(invitationEmail({ ...base, inviterEmail: null, passwordLink: null, hasAccount: false }).text).toContain("You have been invited to the Luzena <Restaurant> & Cafe dashboard as Manager.");
  });
});

describe("telling an existing account from a failure", () => {
  it("recognises every way Supabase Auth has said that an address already has an account", () => {
    for (const error of [
      { code: "email_exists", status: 422, message: "A user with this email address has already been registered" },
      { code: "user_already_exists", status: 422 }, { status: 422, message: "A user with this email address has already been registered" },
      { status: 400, message: "User already registered" }, { message: "Email address already exists in the system" },
    ]) expect(isExistingAccount(error), JSON.stringify(error)).toBe(true);
  });

  it("treats anything else as a failure, so that no invitation is sent on a guess", () => {
    for (const error of [
      null, undefined, {}, { code: "unexpected_failure", status: 500 }, { status: 422, message: "Unable to validate email address: invalid format" },
      { code: "over_request_rate_limit", status: 429 }, { status: 422 }, { code: 422 }, { message: 12 }, { code: "email_address_invalid" },
      { status: 403, message: "User not allowed" }, { message: "fetch failed" },
    ]) expect(isExistingAccount(error), JSON.stringify(error)).toBe(false);
  });
});

describe("the migration, on a database that already has an owner at work", () => {
  it("adds what it adds and leaves the owner, their access and the applications exactly as they were", async () => {
    const { pg, db } = await createTestDb({ upTo: "20261008001300_menu_labels_and_notice.sql" });
    const restaurant = await createRestaurant(pg, "epsilon", "Epsilon Grill");
    const ownerId = "00000000-0000-4000-8000-0000000e0001";
    await pg.query("insert into auth.users (id, email) values ($1, 'Owner@Epsilon.test')", [ownerId]);
    await pg.query("insert into public.restaurant_users (restaurant_id, user_id, role) values ($1, $2, 'owner')", [restaurant, ownerId]);
    await pg.query(
      `insert into public.job_applications (restaurant_id, full_name, email, phone, position, status, created_at) values
        ($1, 'Ana Reyes', 'ana@example.test', '+1 619 555 0101', 'Barista', 'new', now()),
        ($1, 'Ben 100% Carter', 'ben_carter@example.test', '+1 619 555 0102', 'Line Cook', 'hired', now() - interval '3 days')`, [restaurant]);
    const list = (search) => db.rpc("dash_applications_list", {
      p_restaurant: restaurant, p_search: search, p_status: null, p_position: null, p_from: null, p_to: null, p_limit: 25, p_offset: 0,
    });
    const before = { memberships: await db.rpc("user_memberships", { p_user: ownerId }), all: await list(""), percent: await list("100%"), underscore: await list("ben_") };

    await pg.exec(readFileSync(fileURLToPath(new URL("../supabase/migrations/20261013001400_team_access_and_application_export.sql", import.meta.url)), "utf8"));

    // The owner is still the owner, and is still let in.
    expect(await db.rpc("user_memberships", { p_user: ownerId })).toEqual(before.memberships);
    const { rows } = await pg.query("select role, email, invited_by_email, last_seen_at, updated_at = created_at as unchanged from public.restaurant_users where user_id = $1", [ownerId]);
    // Their address is filled in from Supabase Auth's own record, in lower case.
    expect(rows).toEqual([{ role: "owner", email: "owner@epsilon.test", invited_by_email: null, last_seen_at: null, unchanged: true }]);
    // The list answers exactly as it did, wildcards in a search included.
    expect(await list("")).toEqual(before.all);
    expect(await list("100%")).toEqual(before.percent);
    expect(await list("ben_")).toEqual(before.underscore);
    expect(before.percent.applications.map((entry) => entry.full_name)).toEqual(["Ben 100% Carter"]);
    // And the team page has the owner on it, with nobody invited.
    expect(await db.rpc("team_list", { p_restaurant: restaurant })).toMatchObject({
      members: [{ id: ownerId, email: "owner@epsilon.test", role: "owner" }], invitations: [],
    });
    expect((await pg.query("select count(*)::int as n from public.job_applications")).rows[0].n).toBe(2);
  });
});

