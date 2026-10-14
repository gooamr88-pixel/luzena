// Proves, on a real Supabase database, that the migrations left it closed to the public
// roles and open to the backend's role. Run it after `supabase db push` on EVERY project,
// and before deploying anything else to that project.
//
//   PowerShell:  $env:DATABASE_URL = "postgresql://postgres.<ref>:<password>@<pooler host>:5432/postgres"
//                npm run verify:database
//
// The connection string is read from the environment only. Do not put it in a file.
// Nothing is changed: every statement runs in a transaction that is rolled back.
//
// Exit code 0 means every check passed. Anything else means: do not deploy to this project.
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_TABLES = 24;
const migrations = readdirSync(join(ROOT, "supabase", "migrations"))
  .filter((name) => /^\d{14}_.+\.sql$/.test(name)).map((name) => name.slice(0, 14)).sort();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to the project's connection string (see the top of this file).");
  process.exit(2);
}

let failures = 0;
const report = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000 });
try {
  await client.connect();
} catch (error) {
  console.error(`Could not connect: ${error.message}`);
  process.exit(2);
}
const rows = async (sql) => (await client.query(sql)).rows;
// Never print the password: only where we are connected.
console.log(`Connected to ${client.host} as ${client.user}\n`);

try {
  await client.query("begin transaction read only");

  const tables = await rows("select tablename from pg_tables where schemaname = 'public'");
  report(tables.length === EXPECTED_TABLES, `${EXPECTED_TABLES} tables exist`, `(${tables.length})`);

  const noRls = await rows("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity");
  report(noRls.length === 0, "every table has row level security", noRls.map((row) => row.relname).join(", "));

  const policies = await rows("select tablename, policyname from pg_policies where schemaname = 'public'");
  report(policies.length === 0, "no policy grants the public roles anything", JSON.stringify(policies));

  const openRelations = await rows(`
    select c.relname, r.rolname from pg_class c cross join (values ('anon'), ('authenticated')) r(rolname)
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'S', 'v', 'm')
      and (has_table_privilege(r.rolname, c.oid, 'select')
        or (c.relkind = 'S' and has_sequence_privilege(r.rolname, c.oid, 'usage, update'))
        or (c.relkind <> 'S' and has_table_privilege(r.rolname, c.oid, 'insert, update, delete, truncate')))`);
  report(openRelations.length === 0, "anon and authenticated hold no privilege on any table, view or sequence",
    openRelations.slice(0, 8).map((row) => `${row.rolname}:${row.relname}`).join(", "));

  const functionCount = (await rows("select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace"))[0].n;
  const openFunctions = await rows(`
    select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
  report(openFunctions.length === 0, `none of the ${functionCount} functions can be executed by anon or authenticated`,
    openFunctions.slice(0, 8).map((row) => row.proname).join(", "));

  // Event-trigger functions are Supabase's own (they cannot be called directly); ours are the rest.
  const definers = await rows(`
    select p.proname from pg_proc p join pg_type t on t.oid = p.prorettype
    where p.pronamespace = 'public'::regnamespace and p.prosecdef and t.typname <> 'event_trigger'`);
  report(definers.length === 0, "no function of ours runs with its owner's rights (security definer)", definers.map((row) => row.proname).join(", "));

  const closedToService = await rows(`
    select p.proname from pg_proc p join pg_type t on t.oid = p.prorettype
    where p.pronamespace = 'public'::regnamespace and t.typname <> 'event_trigger'
      and not has_function_privilege('service_role', p.oid, 'execute')`);
  report(closedToService.length === 0, "service_role can execute every function", closedToService.slice(0, 8).map((row) => row.proname).join(", "));

  const serviceTables = await rows(`
    select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and not has_table_privilege('service_role', c.oid, 'select, insert, update, delete')`);
  report(serviceTables.length === 0, "service_role can read and write every table", serviceTables.map((row) => row.relname).join(", "));

  const defaults = await rows(`
    select d.defaclobjtype as kind, a.grantee::regrole::text as role
    from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
    where d.defaclnamespace = 'public'::regnamespace and d.defaclrole = 'postgres'::regrole
      and a.grantee::regrole::text in ('anon', 'authenticated')`);
  report(defaults.length === 0, "new tables, sequences and functions start closed to the public roles", JSON.stringify(defaults));

  const buckets = await rows("select id, public, file_size_limit from storage.buckets order by id");
  report(buckets.length === 2 && buckets[0].id === "cvs" && buckets[0].public === false && buckets[1].id === "menu-images" && buckets[1].public === true,
    "buckets: cvs is private, menu-images is public", JSON.stringify(buckets));

  const storagePolicies = await rows("select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'");
  report(storagePolicies.length === 0, "no storage policy lets the public roles read or write objects", JSON.stringify(storagePolicies));

  const ledger = (await rows("select version from supabase_migrations.schema_migrations order by 1")).map((row) => row.version);
  report(ledger.join() === migrations.join(), `the migration ledger matches the ${migrations.length} migration files`,
    ledger.join() === migrations.join() ? "" : `ledger: ${ledger.join(", ")}`);

  const data = (await rows("select (select count(*) from public.restaurants)::int as restaurants, (select count(*) from auth.users)::int as users, (select count(*) from public.job_applications)::int as applications"))[0];
  console.log(`      rows now: ${JSON.stringify(data)}`);
  await client.query("rollback");

  // Act as each role, inside a transaction that is rolled back.
  const as = async (role, sql) => {
    await client.query("begin");
    try {
      await client.query(`set local role ${role}`);
      return { rows: (await client.query(sql)).rows };
    } catch (error) {
      return { error: error.message };
    } finally {
      await client.query("rollback");
    }
  };
  const denied = (result) => Boolean(result.error) && /permission denied/.test(result.error);
  const nobody = "'00000000-0000-0000-0000-000000000000'::uuid";
  for (const role of ["anon", "authenticated"]) {
    const attempts = {
      "read menu_items": "select * from public.menu_items limit 1",
      "read job_applications": "select * from public.job_applications limit 1",
      "read clover_connections": "select * from public.clover_connections limit 1",
      "read audit_logs": "select * from public.audit_logs limit 1",
      "read who has access (restaurant_users)": "select * from public.restaurant_users limit 1",
      "read team_invitations": "select * from public.team_invitations limit 1",
      "read messages to applicants": "select * from public.job_application_messages limit 1",
      "read monthly_reports": "select * from public.monthly_reports limit 1",
      "call dash_application_message_create": `select public.dash_application_message_create(${nobody}, ${nobody}, 'reply', 's', 'b', ${nobody}, 'x@example.test')`,
      "call monthly_report_claim": `select public.monthly_report_claim(${nobody}, date '2026-01-01')`,
      "call monthly_report_data": `select public.monthly_report_data(${nobody}, now(), now(), now())`,
      "make itself an owner": `insert into public.restaurant_users (restaurant_id, user_id, role) values (${nobody}, ${nobody}, 'owner')`,
      "call team_list": `select public.team_list(${nobody})`,
      "call team_invitation_accept": `select public.team_invitation_accept(${nobody}, ${nobody}, 'x@example.test')`,
      "call dash_applications_export": `select public.dash_applications_export(${nobody}, null, null, null, null, null, null, 10, false)`,
      "insert a restaurant": "insert into public.restaurants (slug, name) values ('intruder', 'Intruder')",
      "call clover_connection_secret": `select public.clover_connection_secret(${nobody})`,
      "call public_menu": `select public.public_menu(${nobody})`,
      "advance the audit log sequence": "select nextval('public.audit_logs_id_seq')",
    };
    for (const [what, sql] of Object.entries(attempts)) {
      const result = await as(role, sql);
      report(denied(result), `${role} cannot ${what}`, denied(result) ? "" : (result.error ?? "it worked"));
    }
  }

  const lookup = await as("service_role", "select public.restaurant_public('no-such-restaurant') as r");
  report(!lookup.error && lookup.rows[0].r === null, "service_role can call restaurant_public", lookup.error ?? "");
  const limit = await as("service_role", "select public.rate_limit_hit('verify:probe', 5, 60) as allowed");
  report(!limit.error && limit.rows[0].allowed === true, "service_role can write through rate_limit_hit (rolled back)", limit.error ?? "");

  // Team access (migration 20261013001400). The backend's role must be able to read the
  // team and to count an export; and every restaurant must still have an owner, which is
  // the one thing that migration must never have disturbed.
  const teamList = await as("service_role", `select public.team_list(${nobody}) as r`);
  report(!teamList.error && Array.isArray(teamList.rows[0].r?.members), "service_role can call team_list", teamList.error ?? "");
  const exportCount = await as("service_role", `select public.dash_applications_export(${nobody}, null, null, null, null, null, null, 10, true) as r`);
  report(!exportCount.error && exportCount.rows[0].r?.count === 0, "service_role can call dash_applications_export", exportCount.error ?? "");
  // Since 20261014001600 an invitation may offer owner, manager or staff, and nothing else.
  const invitationRoles = await as("service_role",
    `insert into public.team_invitations (restaurant_id, email, role, expires_at) values (${nobody}, 'verify-probe@example.test', 'admin', now())`);
  report(Boolean(invitationRoles.error) && /check constraint/.test(invitationRoles.error), "an invitation cannot hold a role that does not exist",
    invitationRoles.error ? "" : "the insert was accepted (rolled back)");
  const lastOwner = await as("service_role", `select public.team_member_remove(${nobody}, ${nobody}, '00000000-0000-4000-8000-000000000001'::uuid) as r`);
  report(!lastOwner.error && lastOwner.rows[0].r?.refused === "not_owner", "team changes are refused to anyone who is not an owner of the restaurant", lastOwner.error ?? JSON.stringify(lastOwner.rows?.[0]?.r));

  // Messages to applicants and monthly reports (migration 20261014001500). The backend's
  // role must be able to use both; a message cannot be made for an application that is
  // not there; and every restaurant has a clock for its months.
  const noMessage = await as("service_role", `select public.dash_application_message_create(${nobody}, ${nobody}, 'reply', 's', 'b', ${nobody}, 'x@example.test') as r`);
  report(!noMessage.error && noMessage.rows[0].r === null, "service_role can call dash_application_message_create, which makes nothing for an unknown application", noMessage.error ?? "");
  const figures = await as("service_role", `select public.monthly_report_data(${nobody}, now() - interval '1 month', now(), now() - interval '2 months') as r`);
  report(!figures.error && figures.rows[0].r?.applications?.received === 0, "service_role can call monthly_report_data", figures.error ?? "");
  const reportList = await as("service_role", "select public.monthly_report_restaurants() as r");
  report(!reportList.error && Array.isArray(reportList.rows[0].r) && reportList.rows[0].r.every((entry) => typeof entry.timezone === "string" && entry.timezone !== ""),
    "every restaurant has a time zone for its monthly report", reportList.error ?? "");

  await client.query("begin transaction read only");
  const ownerless = await rows(`
    select r.slug from public.restaurants r
    where not exists (select 1 from public.restaurant_users u where u.restaurant_id = r.id and u.role = 'owner')`);
  report(ownerless.length === 0, "every restaurant still has an owner", ownerless.map((row) => row.slug).join(", "));
  const membership = (await rows(`
    select count(*)::int as members, count(*) filter (where email is null)::int as without_address,
           (select count(*)::int from public.team_invitations) as invitations
    from public.restaurant_users`))[0];
  console.log(`      team now: ${JSON.stringify(membership)}`);
  await client.query("rollback");
} catch (error) {
  failures += 1;
  console.error(`\nThe verification itself failed: ${error.message}`);
} finally {
  await client.end().catch(() => {});
}

console.log(failures === 0
  ? "\nAll database checks passed."
  : `\n${failures} database check(s) FAILED. Do not deploy to this project until they pass.`);
process.exit(failures === 0 ? 0 : 1);
