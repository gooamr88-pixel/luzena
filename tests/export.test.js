// The export of job applications, as the API answers it: which applications, to whom, and
// what is recorded. Real handlers and real SQL (PGlite). The files themselves, made from
// this answer in the browser, are in tests/export-files.test.js.
//
// Requests are sent straight to the API, with ids and bodies no dashboard would send.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_EXPORT_ROWS } from "../supabase/functions/_shared/dashboard/applications.ts";
import { createHarness } from "./helpers/harness.js";

let h, alpha, beta, owner, manager, staff, betaOwner, outsider;
const ids = {};
const NOBODY = "00000000-0000-4000-8000-00000000dead";
const MAIN_FIELDS = ["created_at", "employment_type", "experience_level", "full_name", "has_cv", "position", "status"];

const add = async (restaurant, fullName, position, status, daysAgo, more = {}) => {
  const { rows } = await h.pg.query(
    `insert into public.job_applications (restaurant_id, full_name, email, phone, position, status, created_at,
       employment_type, experience_level, experience, message, cv_path, cv_original_name, cv_mime, ip_hash, submission_id,
       availability, start_when, work_authorized)
     values ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7), $8, $9, $10, $11, $12, $13, $14, 'iphash-secret', gen_random_uuid(),
       '{weekday_days}', 'immediately', true)
     returning id`,
    [restaurant, fullName, more.email ?? `${fullName.toLowerCase().replace(/[^a-z]+/g, ".")}@example.test`, more.phone ?? "+1 619 555 0000",
      position, status, daysAgo, more.employment_type ?? "part_time", more.experience_level ?? "1_2",
      "Private words about experience.", "Private introduction.", more.cv ? `${restaurant}/cv-${fullName}.pdf` : null,
      more.cv ? "cv.pdf" : null, more.cv ? "application/pdf" : null]);
  ids[fullName] = rows[0].id;
  return rows[0].id;
};
const preview = (user, body, headers) => h.api(user, "POST", "/applications/export/preview", body, headers);
const exported = (user, body, headers) => h.api(user, "POST", "/applications/export", body, headers);
const names = (response) => response.body.applications.map((application) => application.full_name);
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const exportsRecorded = async () => (await h.pg.query("select * from public.audit_logs where action = 'APPLICATIONS_EXPORTED' order by id")).rows;

beforeAll(async () => {
  h = await createHarness();
  alpha = await h.createRestaurant("alpha");
  beta = await h.createRestaurant("beta");
  await h.pg.query("update public.restaurants set name = 'Alpha Kitchen' where id = $1", [alpha]);
  owner = await h.addUser(alpha, "owner");
  manager = await h.addUser(alpha, "manager");
  staff = await h.addUser(alpha, "staff");
  betaOwner = await h.addUser(beta, "owner");
  outsider = await h.addUser(null);

  await add(alpha, "Ana Reyes", "Barista", "new", 0, { cv: true, phone: "+1 619 555 0101" });
  await add(alpha, "Ben Carter", "Line Cook", "reviewing", 2, { employment_type: "full_time", experience_level: "over_5" });
  await add(alpha, "Cora 100% Diaz", "Barista", "interview", 5, { email: "cora_diaz@example.test", cv: true });
  await add(alpha, "Dev Patel", "Head Chef", "hired", 20);
  await add(alpha, "Eli Novak", "Line Cook", "rejected", 40);
  await add(alpha, "عمر الحداد", "Barista", "shortlisted", 41);
  await add(beta, "Zed Other", "Barista", "new", 1, { cv: true });
  await add(beta, "Yan Other", "Line Cook", "hired", 3);
});

beforeEach(async () => {
  await h.pg.query("delete from public.rate_limits");
});

describe("what an export holds", () => {
  it("is every application of the restaurant, newest first, with the main facts of each and nothing more", async () => {
    const response = await exported(owner, { scope: "all", format: "xlsx" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: "exported", count: 6, requested: null, scope: "all", restaurant: { name: "Alpha Kitchen", slug: "alpha" } });
    expect(Date.parse(response.body.generated_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(names(response)).toEqual(["Ana Reyes", "Ben Carter", "Cora 100% Diaz", "Dev Patel", "Eli Novak", "عمر الحداد"]);
    expect(response.body.applications).toHaveLength(response.body.count);

    for (const application of response.body.applications) expect(Object.keys(application).sort()).toEqual(MAIN_FIELDS);
    expect(response.body.applications[0]).toEqual({
      full_name: "Ana Reyes", position: "Barista", status: "new", employment_type: "part_time", experience_level: "1_2",
      has_cv: true, created_at: expect.any(String),
    });
    expect(response.body.applications[1]).toMatchObject({ full_name: "Ben Carter", employment_type: "full_time", experience_level: "over_5", has_cv: false });

    // The details stay in the dashboard: contact details, the applicant's own words, the
    // other answers, and everything that is of no use outside the server.
    const everything = JSON.stringify(response.body);
    expect(everything).not.toMatch(/@example\.test|619 555|Private words|Private introduction|iphash-secret|cv_path|cv-Ana|submission|weekday_days|immediately|work_authorized/);
    for (const id of Object.values(ids)) expect(everything).not.toContain(id);
    expect(everything).not.toContain(alpha);
    // Not kept by a browser or anything in between.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("says how many there will be before any are handed over, and the two agree", async () => {
    const counted = await preview(owner, { scope: "all" });
    expect(counted.status).toBe(200);
    expect(counted.body).toEqual({ count: 6, requested: null, limit: MAX_EXPORT_ROWS, exportable: true });
    // The count alone: no application is in the answer.
    expect(JSON.stringify(counted.body)).not.toMatch(/Ana|Barista/);
    expect((await exported(owner, { scope: "all" })).body.count).toBe(counted.body.count);
  });

  it("follows the list's filters, on every page of it, when asked for what matches", async () => {
    // The same filters to the list and to the export name the same applications.
    const cases = [
      [{ status: "interview" }, ["Cora 100% Diaz"]],
      [{ position: "Line Cook" }, ["Ben Carter", "Eli Novak"]],
      [{ position: "Line Cook", status: "rejected" }, ["Eli Novak"]],
      [{ search: "carter" }, ["Ben Carter"]],
      [{ search: "555 0101" }, ["Ana Reyes"]],
      [{ search: "100%" }, ["Cora 100% Diaz"]],
      [{ search: "cora_diaz" }, ["Cora 100% Diaz"]],
      [{ search: "%" }, ["Cora 100% Diaz"]],
      [{ search: "_" }, ["Cora 100% Diaz"]],
      [{ search: "الحداد" }, ["عمر الحداد"]],
      [{ from: daysAgo(3) }, ["Ana Reyes", "Ben Carter"]],
      [{ to: daysAgo(10) }, ["Dev Patel", "Eli Novak", "عمر الحداد"]],
      [{ from: daysAgo(30), to: daysAgo(1) }, ["Ben Carter", "Cora 100% Diaz", "Dev Patel"]],
      [{ search: "nobody at all" }, []],
      [{}, ["Ana Reyes", "Ben Carter", "Cora 100% Diaz", "Dev Patel", "Eli Novak", "عمر الحداد"]],
    ];
    for (const [filters, expected] of cases) {
      const response = await exported(owner, { scope: "filtered", filters });
      expect(response.status, JSON.stringify(filters)).toBe(200);
      expect(names(response), JSON.stringify(filters)).toEqual(expected);
      expect(response.body.count, JSON.stringify(filters)).toBe(expected.length);
      expect((await preview(owner, { scope: "filtered", filters })).body.count, JSON.stringify(filters)).toBe(expected.length);
      const list = await h.api(owner, "GET", `/applications?${new URLSearchParams({ ...filters, limit: "100" })}`);
      expect(list.body.applications.map((application) => application.full_name), JSON.stringify(filters)).toEqual(expected);
    }

    // A page of the list is two here; the export of the same filter is all five.
    const page = await h.api(owner, "GET", "/applications?limit=2&offset=2");
    expect(page.body.applications).toHaveLength(2);
    expect(page.body.total).toBe(6);
    expect((await exported(owner, { scope: "filtered", filters: {} })).body.count).toBe(6);
  });

  it("holds exactly the applications named, when asked for chosen ones, whatever the order they are named in", async () => {
    const chosen = [ids["Eli Novak"], ids["Ana Reyes"], ids["Dev Patel"]];
    const response = await exported(owner, { scope: "selected", ids: chosen, format: "csv" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ count: 3, requested: 3, scope: "selected" });
    // Newest first, as everywhere, not in the order of the request.
    expect(names(response)).toEqual(["Ana Reyes", "Dev Patel", "Eli Novak"]);
    // One page of the list, sent as the ids on it, is exactly that page.
    const page = await h.api(owner, "GET", "/applications?limit=2&offset=2");
    const onPage = await exported(owner, { scope: "selected", ids: page.body.applications.map((application) => application.id) });
    expect(names(onPage)).toEqual(page.body.applications.map((application) => application.full_name));
    expect((await exported(owner, { scope: "selected", ids: [ids["Ana Reyes"]] })).body.count).toBe(1);
  });

  it("is an empty list, not an error, when nothing matches", async () => {
    const response = await exported(owner, { scope: "filtered", filters: { status: "hired", position: "Barista" } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ count: 0, applications: [] });
    expect((await preview(owner, { scope: "filtered", filters: { status: "hired", position: "Barista" } })).body).toMatchObject({ count: 0, exportable: true });
  });

  it("counts and reads in one moment: the number always equals the rows", async () => {
    // Applications arriving and being deleted while exports are being read.
    const work = [];
    for (let round = 0; round < 6; round++) {
      work.push(exported(owner, { scope: "all" }));
      work.push(add(alpha, `Arriving ${round}`, "Barista", "new", 0));
      work.push(exported(owner, { scope: "filtered", filters: { position: "Barista" } }));
    }
    const answers = (await Promise.all(work)).filter((entry) => typeof entry === "object");
    expect(answers).toHaveLength(12);
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.body.applications).toHaveLength(answer.body.count);
    }
    await h.pg.query("delete from public.job_applications where full_name like 'Arriving %'");
    expect((await preview(owner, { scope: "all" })).body.count).toBe(6);
  });
});

describe("who may export", () => {
  it("is the owner alone: not a manager, not staff, not an account with no restaurant, not a visitor", async () => {
    for (const body of [{ scope: "all" }, { scope: "filtered", filters: {} }, { scope: "selected", ids: [ids["Ana Reyes"]] }]) {
      for (const [user, status, code] of [[manager, 403, "forbidden"], [staff, 403, "forbidden"], [outsider, 403, "no_restaurant"], [null, 401, "unauthenticated"], [{ token: "jwt-forged" }, 401, "unauthenticated"]]) {
        for (const send of [preview, exported]) {
          const response = await send(user, body);
          expect(response.status, `${user?.email ?? "nobody"} ${JSON.stringify(body)}`).toBe(status);
          expect(response.body.error.code).toBe(code);
          expect(JSON.stringify(response.body)).not.toMatch(/Ana|Barista|"count"/);
        }
      }
    }
    // A manager reads applications, changes them and downloads CVs: exporting is a different permission.
    expect((await h.api(manager, "GET", "/me")).body.permissions).toEqual(expect.arrayContaining(["applications.read", "applications.manage", "applications.cv"]));
    expect((await h.api(manager, "GET", "/me")).body.permissions).not.toContain("applications.export");
    expect((await h.api(owner, "GET", "/me")).body.permissions).toContain("applications.export");
    // None of the refused attempts was recorded as an export, because none happened.
    expect((await exportsRecorded()).every((row) => row.user_id === owner.id)).toBe(true);
  });

  it("is refused to a session that has the password but not the second step", async () => {
    h.signedInWith(owner, { twoStep: true, level: "aal1" });
    const response = await exported(owner, { scope: "all" });
    h.signedInWith(owner, { twoStep: false, level: "aal1" });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("mfa_required");
  });

  it("ends with the access: an owner who is no longer a member is given nothing", async () => {
    // A second owner, as the operator adds one, exports; then the operator removes them.
    const partner = await h.addUser(alpha, "owner");
    expect((await exported(partner, { scope: "all" })).body.count).toBe(6);
    await h.pg.query("delete from public.restaurant_users where user_id = $1", [partner.id]);
    for (const send of [preview, exported]) {
      const response = await send(partner, { scope: "all" });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("no_restaurant");
      expect(JSON.stringify(response.body)).not.toMatch(/Ana|applications"/);
    }
    // An owner made a manager loses it with the role, on the session they already hold.
    const demoted = await h.addUser(alpha, "owner");
    expect((await preview(demoted, { scope: "all" })).status).toBe(200);
    await h.pg.query("update public.restaurant_users set role = 'manager' where user_id = $1", [demoted.id]);
    expect((await exported(demoted, { scope: "all" })).status).toBe(403);
    await h.pg.query("delete from public.restaurant_users where user_id = $1", [demoted.id]);
  });

  it("is limited in how often, separately from reading", async () => {
    await h.pg.query(
      `insert into public.rate_limits (key, window_start, count)
       values ($1, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 30)`, [`dash:export:${owner.id}`]);
    const response = await exported(owner, { scope: "all" });
    expect(response.status).toBe(429);
    expect(response.body.error).toMatchObject({ code: "rate_limited", retryable: true });
    // Counting is not exporting, and is not stopped by it.
    expect((await preview(owner, { scope: "all" })).status).toBe(200);
  });
});

describe("one restaurant and another", () => {
  it("gives each owner their own restaurant's applications and no way to name another's", async () => {
    const mine = await exported(betaOwner, { scope: "all" });
    expect(names(mine)).toEqual(["Zed Other", "Yan Other"]);
    expect(mine.body.restaurant.slug).toBe("beta");

    // Ids that belong to the other restaurant are looked for in the caller's own, and are not there.
    const alphaIds = [ids["Ana Reyes"], ids["Ben Carter"], ids["Dev Patel"]];
    const stolen = await exported(betaOwner, { scope: "selected", ids: alphaIds });
    expect(stolen.status).toBe(200);
    expect(stolen.body).toMatchObject({ count: 0, requested: 3, applications: [] });
    expect((await preview(betaOwner, { scope: "selected", ids: alphaIds })).body).toMatchObject({ count: 0, requested: 3 });
    // Mixed with their own: only their own come back, and nothing says which of the others exist.
    const mixed = await exported(betaOwner, { scope: "selected", ids: [ids["Ana Reyes"], ids["Zed Other"], NOBODY] });
    expect(names(mixed)).toEqual(["Zed Other"]);
    expect(mixed.body).toMatchObject({ count: 1, requested: 3 });
    expect(JSON.stringify(mixed.body)).not.toMatch(/Ana|alpha/i);

    // A filter cannot reach across either.
    expect(names(await exported(betaOwner, { scope: "filtered", filters: { search: "Reyes" } }))).toEqual([]);
    expect(names(await exported(owner, { scope: "filtered", filters: { search: "Other" } }))).toEqual([]);
  });

  it("takes the restaurant from the membership: naming another in the request is refused or is not a field at all", async () => {
    for (const send of [preview, exported]) {
      expect((await send(betaOwner, { scope: "all" }, { "x-restaurant-id": alpha })).status).toBe(403);
      expect((await send(owner, { scope: "all" }, { "x-restaurant-id": NOBODY })).status).toBe(403);
      for (const body of [
        { scope: "all", restaurant_id: beta }, { scope: "all", restaurant: "beta" }, { scope: "all", p_restaurant: beta },
        { scope: "filtered", filters: { restaurant_id: beta } }, { scope: "filtered", filters: { email: "ana@example.test" } },
      ]) {
        expect((await send(owner, body)).status, JSON.stringify(body)).toBe(422);
      }
    }
    // The database function is bound to the restaurant it is given, like every other.
    const direct = await h.db.rpc("dash_applications_export", {
      p_restaurant: beta, p_search: "", p_status: null, p_position: null, p_from: null, p_to: null,
      p_ids: [ids["Ana Reyes"], ids["Zed Other"]], p_limit: 100, p_count_only: false,
    });
    expect(direct.applications.map((application) => application.full_name)).toEqual(["Zed Other"]);
  });
});

describe("what is refused as not a proper request", () => {
  it("each kind of export takes exactly what it needs and nothing else", async () => {
    const id = ids["Ana Reyes"];
    const bad = [
      {}, { format: "xlsx" }, { scope: "everything" }, { scope: "ALL" }, { scope: ["all"] }, { scope: null },
      // Chosen ones need ids; the others must not be given any.
      { scope: "selected" }, { scope: "selected", ids: [] }, { scope: "all", ids: [id] }, { scope: "filtered", ids: [id] },
      // Filters belong to "filtered" only.
      { scope: "all", filters: {} }, { scope: "selected", ids: [id], filters: { status: "new" } },
      // Ids are ids.
      { scope: "selected", ids: ["not-an-id"] }, { scope: "selected", ids: [id, id] }, { scope: "selected", ids: id },
      { scope: "selected", ids: ["' or 1=1 --"] }, { scope: "selected", ids: [null] }, { scope: "selected", ids: [{ id }] },
      { scope: "selected", ids: Array.from({ length: 1001 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`) },
      // Filters are what the list accepts.
      { scope: "filtered", filters: { status: "archived" } }, { scope: "filtered", filters: { from: "yesterday" } },
      { scope: "filtered", filters: { to: "2026-10-06" } }, { scope: "filtered", filters: { from: "2026-13-45T00:00:00Z" } },
      { scope: "filtered", filters: { search: "x".repeat(101) } }, { scope: "filtered", filters: { status: ["new"] } },
      { scope: "filtered", filters: "status=new" }, { scope: "filtered", filters: { limit: 5 } }, { scope: "filtered", filters: { offset: 2 } },
      // Formats are the two there are.
      { scope: "all", format: "pdf" }, { scope: "all", format: "../../x" }, { scope: "all", format: "" },
      // Nothing else is a field.
      { scope: "all", columns: ["email", "phone"] }, { scope: "all", fields: "*" }, { scope: "all", limit: 1_000_000 }, { scope: "all", include_details: true },
    ];
    const before = (await exportsRecorded()).length;
    for (const body of bad) {
      // More attempts than an owner may make in an hour: the limiter is emptied as it goes,
      // so that what is tested here is the checking of the request and not the limit.
      await h.pg.query("delete from public.rate_limits");
      for (const send of [preview, exported]) {
        const response = await send(owner, body);
        expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(422);
        expect(JSON.stringify(response.body)).not.toMatch(/Ana Reyes|"applications"/);
      }
    }
    expect((await exportsRecorded()).length).toBe(before);
    // A thousand ids, the most that can be named, is accepted.
    const thousand = Array.from({ length: 999 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`).concat(id);
    expect((await preview(owner, { scope: "selected", ids: thousand })).body).toMatchObject({ count: 1, requested: 1000 });
    // Exports are asked for with POST and a JSON body, never by an address that could be
    // bookmarked, cached or pasted into a message.
    expect((await h.api(owner, "GET", "/applications/export")).status).toBe(405);
    expect((await h.api(owner, "GET", "/applications/export/preview")).status).toBe(405);
    expect((await h.api(owner, "GET", "/applications/export?scope=all")).status).toBe(405);
  });

  it("refuses an export too large for one file, saying how large, and hands over none of it", async () => {
    const gamma = await h.createRestaurant("gamma");
    const boss = await h.addUser(gamma, "owner");
    await h.pg.query(
      `insert into public.job_applications (restaurant_id, full_name, email, phone, position, status)
       select $1, 'Applicant ' || n, 'a' || n || '@example.test', '+1 619 555 0000', case when n % 2 = 0 then 'Barista' else 'Line Cook' end, 'new'
       from generate_series(1, $2::int) n`, [gamma, MAX_EXPORT_ROWS + 1]);

    expect((await preview(boss, { scope: "all" })).body).toEqual({ count: MAX_EXPORT_ROWS + 1, requested: null, limit: MAX_EXPORT_ROWS, exportable: false });
    const refused = await exported(boss, { scope: "all" });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "export_too_large", count: MAX_EXPORT_ROWS + 1, limit: MAX_EXPORT_ROWS });
    expect(JSON.stringify(refused.body)).not.toContain("Applicant 1");
    expect(await h.pg.query("select count(*)::int as n from public.audit_logs where restaurant_id = $1", [gamma]).then((result) => result.rows[0].n)).toBe(0);

    // In parts, it goes through: every application once, across the parts.
    const baristas = await exported(boss, { scope: "filtered", filters: { position: "Barista" } });
    const cooks = await exported(boss, { scope: "filtered", filters: { position: "Line Cook" } });
    expect(baristas.status).toBe(200);
    expect(baristas.body.count + cooks.body.count).toBe(MAX_EXPORT_ROWS + 1);
    expect(new Set([...names(baristas), ...names(cooks)]).size).toBe(MAX_EXPORT_ROWS + 1);
    // Exactly at the limit is allowed.
    await h.pg.query("delete from public.job_applications where restaurant_id = $1 and full_name = 'Applicant 1'", [gamma]);
    const atLimit = await exported(boss, { scope: "all" });
    expect(atLimit.status).toBe(200);
    expect(atLimit.body.applications).toHaveLength(MAX_EXPORT_ROWS);
  });
});

describe("what is recorded", () => {
  it("writes each export to the audit log: who, how many, which kind and format; never whose details", async () => {
    await h.pg.query("delete from public.audit_logs where action = 'APPLICATIONS_EXPORTED'");
    h.logs.length = 0;
    await exported(owner, { scope: "filtered", format: "csv", filters: { search: "Ana Reyes", status: "new", position: "Barista", from: daysAgo(3) } });
    await exported(owner, { scope: "selected", ids: [ids["Ben Carter"], ids["Dev Patel"]] });
    await exported(owner, { scope: "all" });

    const rows = await exportsRecorded();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ restaurant_id: alpha, user_id: owner.id, actor_email: owner.email, entity_type: "application_export", entity_id: null, result: "success" });
      expect(row.request_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    // The search box usually holds a name: the log says that a search was used, not what it was.
    expect(rows[0].new_values).toEqual({
      format: "csv", scope: "filtered", count: 1,
      filters: { search: true, status: "new", position: "Barista", from: expect.any(String), to: null },
    });
    expect(rows[1].new_values).toEqual({ format: "xlsx", scope: "selected", count: 2, filters: null });
    expect(rows[2].new_values).toEqual({ format: "xlsx", scope: "all", count: 6, filters: null });
    const recorded = JSON.stringify([rows, h.logs]);
    expect(recorded).not.toMatch(/Ana|Reyes|Ben Carter|Dev Patel|@example\.test.*applicant|619 555|Private/);
    for (const id of Object.values(ids)) expect(recorded).not.toContain(id);

    // Counting is not an export, and leaves no entry.
    await preview(owner, { scope: "all" });
    expect(await exportsRecorded()).toHaveLength(3);
    // The activity page shows it, to the manager too: there is nobody's detail in it to hide.
    const activity = (await h.api(manager, "GET", "/activity")).body.entries.filter((entry) => entry.action === "APPLICATIONS_EXPORTED");
    expect(activity).toHaveLength(3);
    expect(activity[0]).toMatchObject({ actor_email: owner.email, new_values: { scope: "all", count: 6 } });
  });

  it("hands over nothing if the export cannot be recorded", async () => {
    const before = (await exportsRecorded()).length;
    const real = h.deps.db.rpc;
    h.deps.db.rpc = (fn, args) => (fn === "audit_write" ? Promise.reject(new Error("audit log unavailable")) : real(fn, args));
    const response = await exported(owner, { scope: "all" });
    // Counting is still answered: it hands over nobody's details.
    const counted = await preview(owner, { scope: "all" });
    h.deps.db.rpc = real;

    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({ code: "export_unavailable", retryable: true });
    expect(JSON.stringify(response.body)).not.toMatch(/Ana|applications"|audit log unavailable/);
    expect(counted.status).toBe(200);
    expect((await exportsRecorded()).length).toBe(before);
    expect((await exported(owner, { scope: "all" })).status).toBe(200);
  });
});

describe("the list, which now shares its filters with the export", () => {
  it("still answers as it always did", async () => {
    const list = await h.api(owner, "GET", "/applications");
    expect(list.body).toMatchObject({ total: 6, limit: 25, offset: 0, counts: { new: 1, reviewing: 1, interview: 1, hired: 1, rejected: 1, shortlisted: 1 }, positions: ["Barista", "Head Chef", "Line Cook"] });
    expect(Object.keys(list.body.applications[0]).sort()).toEqual(["created_at", "email_status", "employment_type", "experience_level", "full_name", "has_cv", "id", "position", "status"]);
    // The counts on the stage buttons are of everything, whatever the filters.
    expect((await h.api(owner, "GET", "/applications?status=hired")).body.counts).toEqual(list.body.counts);
    expect((await h.api(manager, "GET", "/applications?search=carter")).body.applications.map((application) => application.full_name)).toEqual(["Ben Carter"]);
    expect((await h.api(staff, "GET", "/applications")).status).toBe(403);
  });
});
