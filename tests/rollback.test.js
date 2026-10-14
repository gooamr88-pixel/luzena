// The way back from the migrations of this round, proven on real SQL (PGlite): each
// file in supabase/rollback/ leaves the database exactly as it was before its migration
// (tables, columns, constraints, indexes, functions and who may use them), keeps what it
// promises to keep, and leaves a database the migration can be applied to again.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRestaurant, createTestDb, createUser } from "./helpers/db.js";

const read = (path) => readFileSync(fileURLToPath(new URL(`../supabase/${path}`, import.meta.url)), "utf8");
const BEFORE = "20261008001300_menu_labels_and_notice.sql";
const TEAM = "20261013001400_team_access_and_application_export";
const MESSAGES = "20261014001500_applicant_messages_and_monthly_reports";
const OWNERS = "20261014001600_owners_can_appoint_owners";
const ROLES = "(values ('anon'), ('authenticated'), ('service_role')) r(rolname)";

// Everything about the schema that a migration can change, in a form two databases can be
// compared by.
async function snapshot(pg) {
  const rows = async (sql) => (await pg.query(sql)).rows;
  return {
    columns: await rows(`select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'public' order by 1, 2`),
    constraints: await rows(`select conrelid::regclass::text as on_table, conname, pg_get_constraintdef(oid) as definition
      from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await rows("select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2"),
    functions: await rows(`select p.proname, pg_get_function_identity_arguments(p.oid) as arguments, pg_get_function_result(p.oid) as result,
        p.prosecdef, p.provolatile, md5(p.prosrc) as body
      from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1, 2`),
    rowSecurity: await rows("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1"),
    policies: await rows("select tablename, policyname from pg_policies where schemaname = 'public' order by 1, 2"),
    tableRights: await rows(`select c.relname, r.rolname,
        has_table_privilege(r.rolname, c.oid, 'select') as reads, has_table_privilege(r.rolname, c.oid, 'insert, update, delete') as writes
      from pg_class c cross join ${ROLES} where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1, 2`),
    functionRights: await rows(`select p.proname, pg_get_function_identity_arguments(p.oid) as arguments, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') as runs
      from pg_proc p cross join ${ROLES} where p.pronamespace = 'public'::regnamespace order by 1, 2, 3`),
  };
}

let before, afterTeam, afterMessages, full, pg, alpha, owner, handMade, invited, coOwner, application;
const count = async (sql, values = []) => Number((await pg.query(`select count(*) as n from ${sql}`, values)).rows[0].n);

// The schema of a database migrated up to `upTo`. The database is closed straight after:
// each one is a whole Postgres in memory, and three at once is too many for a small machine.
async function schemaUpTo(upTo) {
  const { pg: temporary } = await createTestDb({ upTo });
  try {
    return await snapshot(temporary);
  } finally {
    await temporary.close();
  }
}

beforeAll(async () => {
  before = await schemaUpTo(BEFORE);
  afterTeam = await schemaUpTo(`${TEAM}.sql`);
  afterMessages = await schemaUpTo(`${MESSAGES}.sql`);
  ({ pg } = await createTestDb());
  full = await snapshot(pg);

  // A restaurant in use: its owner, a member the operator added by hand, one who came in
  // by invitation, an invitation still open, an application with messages and history,
  // and a month's report.
  alpha = await createRestaurant(pg, "alpha");
  owner = await createUser(pg, alpha, "owner");
  handMade = await createUser(pg, alpha, "staff");
  invited = await createUser(pg, alpha, "manager");
  await pg.query("update public.restaurant_users set invited_by_email = $2, email = $3 where user_id = $1", [invited.id, owner.email, invited.email]);
  await pg.query("update public.restaurants set report_email = 'owner@alpha.test', timezone = 'America/New_York' where id = $1", [alpha]);
  await pg.query("insert into public.team_invitations (restaurant_id, email, role, expires_at) values ($1, 'new@example.test', 'staff', now() + interval '7 days')", [alpha]);
  // Since 1600: an owner who joined by invitation, and an invitation offering the owner role.
  coOwner = await createUser(pg, alpha, "owner");
  await pg.query("update public.restaurant_users set invited_by_email = $2 where user_id = $1", [coOwner.id, owner.email]);
  await pg.query("insert into public.team_invitations (restaurant_id, email, role, expires_at) values ($1, 'future.owner@example.test', 'owner', now() + interval '7 days')", [alpha]);
  application = (await pg.query(
    `insert into public.job_applications (restaurant_id, full_name, email, phone, position, status, employment_type, experience_level, submission_id)
     values ($1, 'Ana Reyes', 'ana@example.test', '+1 619 555 0000', 'Barista', 'interview', 'part_time', '1_2', gen_random_uuid()) returning id`, [alpha])).rows[0].id;
  for (const kind of ["submitted", "email_sent", "status_changed", "message_sent", "message_failed"]) {
    await pg.query("insert into public.job_application_events (application_id, restaurant_id, kind) values ($1, $2, $3)", [application, alpha, kind]);
  }
  await pg.query(
    `insert into public.job_application_messages (application_id, restaurant_id, kind, to_email, subject, body, status)
     values ($1, $2, 'interview', 'ana@example.test', 'Interview', 'Please come in.', 'delivered')`, [application, alpha]);
  await pg.query("insert into public.monthly_reports (restaurant_id, period, status) values ($1, date '2026-09-01', 'sent')", [alpha]);
});

afterAll(async () => {
  await pg?.close();
});

describe("the migrations themselves", () => {
  it("add what they say and nothing else that the snapshot would miss", () => {
    const tables = (shot) => shot.rowSecurity.map((row) => row.relname);
    expect(tables(afterTeam).filter((name) => !tables(before).includes(name))).toEqual(["team_invitations"]);
    expect(tables(afterMessages).filter((name) => !tables(afterTeam).includes(name))).toEqual(["job_application_messages", "monthly_reports"]);
    expect(tables(full)).toEqual(tables(afterMessages));
    expect(afterMessages.functions.length - afterTeam.functions.length).toBe(12);
    expect(afterTeam.functions.length - before.functions.length).toBe(17);
    expect(full.functions.length - afterMessages.functions.length).toBe(1);
    // Closed, as every table and function before them.
    expect(full.policies).toEqual([]);
    expect(full.rowSecurity.every((row) => row.relrowsecurity)).toBe(true);
    expect(full.tableRights.filter((row) => row.rolname !== "service_role" && (row.reads || row.writes))).toEqual([]);
    expect(full.functionRights.filter((row) => row.rolname !== "service_role" && row.runs)).toEqual([]);
    expect(full.functionRights.filter((row) => row.rolname === "service_role" && !row.runs)).toEqual([]);
    expect(full.functions.filter((row) => row.prosecdef)).toEqual([]);
  });
});

describe("taking back owners appointing owners", () => {
  it("leaves the database exactly as the migration before it left it", async () => {
    await pg.exec(read(`rollback/${OWNERS}.down.sql`));
    expect(await snapshot(pg)).toEqual(afterMessages);
  });

  it("withdraws invitations that offer the owner role, and leaves every owner an owner", async () => {
    expect(await count("public.team_invitations where role = 'owner'")).toBe(0);
    expect(await count("public.team_invitations")).toBe(1);
    expect((await pg.query("select role from public.restaurant_users where user_id = $1", [coOwner.id])).rows).toEqual([{ role: "owner" }]);
    expect(await count("public.restaurant_users where restaurant_id = $1 and role = 'owner'", [alpha])).toBe(2);
    // And the earlier rule is back: an owner's row cannot be written by these functions.
    expect((await pg.query("select public.team_member_remove($1, $2, $3) as r", [alpha, coOwner.id, owner.id])).rows[0].r).toEqual({ refused: "owner" });
  });
});

describe("taking back messages and monthly reports", () => {
  it("leaves the database exactly as the migration before it left it", async () => {
    await pg.exec(read(`rollback/${MESSAGES}.down.sql`));
    expect(await snapshot(pg)).toEqual(afterTeam);
  });

  it("keeps the applications, their earlier history and the team, and drops only what the migration brought", async () => {
    expect(await count("public.job_applications where id = $1", [application])).toBe(1);
    const kinds = (await pg.query("select kind from public.job_application_events where application_id = $1 order by id", [application])).rows.map((row) => row.kind);
    expect(kinds).toEqual(["submitted", "email_sent", "status_changed"]);
    expect(await count("public.restaurant_users where restaurant_id = $1", [alpha])).toBe(4);
    expect(await count("public.team_invitations")).toBe(1);
    await expect(pg.query("select 1 from public.job_application_messages")).rejects.toThrow(/does not exist/);
    await expect(pg.query("select 1 from public.monthly_reports")).rejects.toThrow(/does not exist/);
    // The history refuses the kinds it did not know before.
    await expect(pg.query("insert into public.job_application_events (application_id, restaurant_id, kind) values ($1, $2, 'message_sent')", [application, alpha]))
      .rejects.toThrow(/check constraint/);
  });

  it("cannot be run twice by mistake: the second run changes nothing and says why", async () => {
    await expect(pg.exec(read(`rollback/${MESSAGES}.down.sql`))).rejects.toThrow(/does not exist/);
    await pg.exec("rollback").catch(() => {});
    expect(await snapshot(pg)).toEqual(afterTeam);
  });
});

describe("taking back team access and the export", () => {
  it("leaves the database exactly as it was before this round of work", async () => {
    await pg.exec(read(`rollback/${TEAM}.down.sql`));
    expect(await snapshot(pg)).toEqual(before);
  });

  it("never removes an owner, removes those who came in by invitation, and keeps everything else", async () => {
    const members = (await pg.query("select user_id, role from public.restaurant_users where restaurant_id = $1 order by role, created_at", [alpha])).rows;
    // The owner who came in by invitation is an owner, and is kept like the first.
    expect(members).toEqual([{ user_id: owner.id, role: "owner" }, { user_id: coOwner.id, role: "owner" }, { user_id: handMade.id, role: "staff" }]);
    // Their accounts are Supabase Auth's and are not this file's to delete.
    expect(await count("auth.users where id = $1", [invited.id])).toBe(1);
    expect(await count("public.job_applications where id = $1", [application])).toBe(1);
    expect(await count("public.restaurants where id = $1", [alpha])).toBe(1);
    await expect(pg.query("select 1 from public.team_invitations")).rejects.toThrow(/does not exist/);
    // The list of applications answers as it did.
    const list = (await pg.query(
      "select public.dash_applications_list($1, 'ana', null, null, null, null, 25, 0) as r", [alpha])).rows[0].r;
    expect(list).toMatchObject({ total: 1, counts: { interview: 1 }, positions: ["Barista"] });
    expect(list.applications[0]).toMatchObject({ full_name: "Ana Reyes", status: "interview" });
  });
});

describe("going forward again", () => {
  it("applies the migrations to the rolled-back database, with its data, and arrives where it was", async () => {
    await pg.exec(read(`migrations/${TEAM}.sql`));
    expect(await snapshot(pg)).toEqual(afterTeam);
    await pg.exec(read(`migrations/${MESSAGES}.sql`));
    expect(await snapshot(pg)).toEqual(afterMessages);
    await pg.exec(read(`migrations/${OWNERS}.sql`));
    expect(await snapshot(pg)).toEqual(full);
    // The owner is still the owner, and has an address again from the accounts table.
    const { rows } = await pg.query("select role, email from public.restaurant_users where user_id = $1", [owner.id]);
    expect(rows).toEqual([{ role: "owner", email: owner.email }]);
    expect((await pg.query("select timezone, report_email from public.restaurants where id = $1", [alpha])).rows).toEqual([{ timezone: "America/Los_Angeles", report_email: null }]);
  });
});
