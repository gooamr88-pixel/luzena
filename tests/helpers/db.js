// Real Postgres (PGlite, WASM) with the project's migrations applied.
// The rpc() helper has the same shape as the production Db adapter, so backend handlers
// run against real SQL in tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const migration = (name) =>
  readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${name}`, import.meta.url)), "utf8");

// What Supabase provides and PGlite does not: the three API roles, auth.users, and the
// default privileges. The last matter: a real Supabase project hands `anon` and
// `authenticated` every right on each new table, sequence and function in `public`, and the
// migrations have to take them away. Without these three lines the tests passed on a
// database that was never open in the first place, and missed two sequences that the first
// real project left open (see migration 20261005000500).
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
`;

export async function createTestDb() {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUB);
  await pg.exec(migration("20261005000100_schema.sql"));
  await pg.exec(migration("20261005000200_functions.sql"));
  // 20261005000300_storage.sql is skipped: PGlite has no storage schema.
  await pg.exec(migration("20261005000400_application_retention.sql"));
  await pg.exec(migration("20261005000500_sequence_privileges.sql"));
  await pg.exec(migration("20261006000600_imported_items_start_hidden.sql"));

  const rpc = async (fn, args = {}) => {
    const names = Object.keys(args);
    const list = names.map((name, index) => `${name} => $${index + 1}`).join(", ");
    const values = names.map((name) => args[name]);
    const result = await pg.query(`select public.${fn}(${list}) as result`, values);
    return result.rows[0].result;
  };

  return { pg, db: { rpc } };
}

let userCounter = 0;

export async function createRestaurant(pg, slug, name = slug) {
  const { rows } = await pg.query(
    "insert into public.restaurants (slug, name) values ($1, $2) returning id",
    [slug, name],
  );
  return rows[0].id;
}

export async function createUser(pg, restaurantId, role = "owner") {
  userCounter += 1;
  const id = `00000000-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
  const email = `user${userCounter}@example.test`;
  await pg.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  if (restaurantId) {
    await pg.query(
      "insert into public.restaurant_users (restaurant_id, user_id, role) values ($1, $2, $3)",
      [restaurantId, id, role],
    );
  }
  return { id, email };
}

export async function connectClover(pg, restaurantId, merchantId = "MERCHANT00001") {
  await pg.query(
    `insert into public.clover_connections (restaurant_id, merchant_id, environment,
       access_token_enc, refresh_token_enc, access_token_expires_at)
     values ($1, $2, 'sandbox', 'enc-access', 'enc-refresh', now() + interval '1 hour')`,
    [restaurantId, merchantId],
  );
}

// The owner choosing to show every imported item. Items from Clover start hidden from the
// website; tests about a published menu call this after the first sync, as an owner would
// press Show.
export async function showAllItems(pg, restaurantId) {
  await pg.query("update public.menu_items set web_hidden = false where restaurant_id = $1", [restaurantId]);
}

// A small inventory in the shape menu_apply_sync expects.
export const samplePayload = () => ({
  categories: [
    { id: "CATSTARTERS01", name: "Starters", sort_order: 1, item_ids: ["ITEMSOUP00001", "ITEMSALAD0001"] },
    { id: "CATMAINS00001", name: "Mains", sort_order: 2, item_ids: ["ITEMSTEAK0001"] },
  ],
  modifier_groups: [
    {
      id: "GRPDONENESS01", name: "Doneness", min_required: 1, max_allowed: 1,
      show_by_default: true, sort_order: 1,
      modifiers: [
        { id: "MODRARE000001", name: "Rare", price_cents: 0, available: true },
        { id: "MODWELL000001", name: "Well done", price_cents: 0, available: true },
      ],
    },
  ],
  items: [
    { id: "ITEMSOUP00001", name: "Soup", price_cents: 700, price_type: "FIXED", hidden: false,
      available: true, modified_time: 1000, category_ids: ["CATSTARTERS01"], modifier_group_ids: [] },
    { id: "ITEMSALAD0001", name: "Salad", price_cents: 900, price_type: "FIXED", hidden: false,
      available: false, modified_time: 1000, category_ids: ["CATSTARTERS01"], modifier_group_ids: [] },
    { id: "ITEMSTEAK0001", name: "Steak", price_cents: 3200, price_type: "FIXED", hidden: false,
      available: true, modified_time: 1000, category_ids: ["CATMAINS00001"],
      modifier_group_ids: ["GRPDONENESS01"] },
    { id: "ITEMSTAFF0001", name: "Staff meal", price_cents: 0, price_type: "FIXED", hidden: true,
      available: true, modified_time: 1000, category_ids: [], modifier_group_ids: [] },
  ],
});
