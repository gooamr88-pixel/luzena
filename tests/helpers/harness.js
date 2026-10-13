// Wires the real handlers to real SQL (PGlite) and the fake Clover.
import { encryptSecret } from "../../supabase/functions/_shared/crypto.ts";
import { handleDashboard } from "../../supabase/functions/_shared/dashboard/router.ts";
import { loadEnv } from "../../supabase/functions/_shared/env.ts";
import { createLogger } from "../../supabase/functions/_shared/log.ts";
import { createRestaurant, createTestDb, createUser } from "./db.js";
import { FakeClover } from "./fakeClover.js";

export const ORIGIN = "https://luzenarestaurant.com";
export const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export const TEST_ENV = {
  ALLOWED_ORIGINS: ORIGIN,
  CLOVER_ENV: "sandbox",
  CLOVER_APP_ID: "APPID00000001",
  CLOVER_APP_SECRET: "app-secret-value",
  CLOVER_REDIRECT_URI: `${ORIGIN}/dashboard/`,
  CLOVER_WEBHOOK_AUTH: "webhook-shared-secret",
  TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
  IP_HASH_SALT: "salt",
  EMAIL_FROM: "Careers <careers@example.test>",
  CRON_SECRET: "test-cron-secret-0123456789-0123456789",
  // Applications are off unless both are set; most tests exercise the open state.
  JOB_APPLICATIONS_ENABLED: "true",
  JOB_APPLICATION_RETENTION_DAYS: "180",
};

export async function createHarness(envOverrides = {}) {
  const { pg, db } = await createTestDb();
  const clover = new FakeClover();
  const logs = [];
  const stored = new Map();
  const sent = [];
  const background = [];
  const users = new Map();
  const deliveries = new Map();
  const asked = [];
  const state = { emailFails: false, statusFails: false, accountsFail: false, passwordLinkFails: false };
  // Never reused, even when a test empties `sent`: a provider's ids are unique.
  let emailIds = 0;
  // A stand-in for Supabase Auth's accounts. `made` is every account this backend asked it
  // to create; `signedIn` the ones that have since been signed in to; `links` every
  // set-password link it was asked for. Each link carries a marker a test can search for,
  // to prove the link went into the email and nowhere else.
  const accounts = { made: [], signedIn: new Set(), links: [] };

  const deps = {
    db,
    env: loadEnv((name) => ({ ...TEST_ENV, ...envOverrides })[name]),
    log: createLogger({}, (line) => logs.push(JSON.parse(line))),
    fetch: clover.fetch,
    now: () => Date.now(),
    // Real but tiny waits, so code that polls a lock yields to the lock holder.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    random: () => 0,
    waitUntil: (promise) => background.push(promise.catch(() => {})),
    files: {
      upload: async (bucket, path, bytes, contentType) => { stored.set(`${bucket}/${path}`, { bytes, contentType }); },
      remove: async (bucket, paths) => { for (const path of paths) stored.delete(`${bucket}/${path}`); },
      download: async (bucket, path) => stored.get(`${bucket}/${path}`)?.bytes ?? null,
    },
    auth: { getUser: async (jwt) => users.get(jwt) ?? null },
    accounts: {
      // As Supabase does: an address that has an account is left alone and reported as
      // existing; otherwise an account is made with no password.
      ensure: async (email) => {
        if (state.accountsFail) throw new Error("Supabase Auth could not make the account (unexpected_failure)");
        const existing = await pg.query("select id from auth.users where lower(email) = $1", [email]);
        if (existing.rows.length > 0) return { created: false, id: null };
        const id = crypto.randomUUID();
        await pg.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
        accounts.made.push({ id, email });
        return { created: true, id };
      },
      hasSignedIn: async (id) => accounts.signedIn.has(id),
      passwordLink: async (email, redirectTo) => {
        if (state.passwordLinkFails) return null;
        const link = `https://auth.test/verify?token=LINKSECRET${accounts.links.length + 1}&type=recovery&redirect_to=${encodeURIComponent(redirectTo)}`;
        accounts.links.push({ email, link });
        return link;
      },
    },
    // A stand-in for the email provider. It accepts a message and gives it an id, as a
    // real one does; `deliveries` is what it will say became of each id when asked.
    email: {
      send: async (message) => {
        if (state.emailFails) throw new Error("provider down");
        sent.push(message);
        emailIds += 1;
        return { id: `provider-message-${emailIds}` };
      },
      status: async (id) => {
        if (state.statusFails) throw new Error("provider down");
        asked.push(id);
        return deliveries.get(id) ?? null;
      },
    },
  };

  // Every account here has a confirmed address, as an account that can sign in has.
  const addUser = async (restaurantId, role = "owner") => {
    const user = { ...(await createUser(pg, restaurantId, role)), emailVerified: true };
    const token = `jwt-${user.id}`;
    users.set(token, user);
    return { ...user, token };
  };

  // The person behind an invited address signing in: what follows their choosing a
  // password through Supabase Auth's own link. Gives a session for the account that exists
  // for that address, or null when there is none (nobody can sign themselves up).
  const signInAs = async (email, security = {}) => {
    const { rows } = await pg.query("select id, email from auth.users where lower(email) = lower($1)", [email]);
    if (rows.length === 0) return null;
    const user = { id: rows[0].id, email: rows[0].email, emailVerified: true, ...security };
    const token = `jwt-${user.id}`;
    users.set(token, user);
    accounts.signedIn.add(user.id);
    return { ...user, token };
  };

  // Stores a connection the same way the OAuth flow would: tokens encrypted at rest.
  const connect = async (restaurantId, { expiresInSeconds = 3600 } = {}) => {
    await db.rpc("clover_connection_save", {
      p_restaurant: restaurantId, p_user: null, p_merchant_id: clover.merchantId, p_merchant_name: null,
      p_environment: "sandbox",
      p_access_enc: await encryptSecret(clover.accessToken, ENCRYPTION_KEY),
      p_refresh_enc: await encryptSecret(clover.refreshToken, ENCRYPTION_KEY),
      p_access_exp: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      p_refresh_exp: null,
    });
  };

  let keyCounter = 0;
  const api = async (user, method, path, body, headers = {}) => {
    const init = { method, headers: { origin: ORIGIN, ...headers } };
    if (user) init.headers.authorization = `Bearer ${user.token}`;
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (method === "POST" && !("idempotency-key" in init.headers)) {
      keyCounter += 1;
      init.headers["idempotency-key"] = `test-key-${String(keyCounter).padStart(6, "0")}`;
    }
    const response = await handleDashboard(new Request(`https://fn.test/functions/v1/dashboard-api${path}`, init), deps);
    // A file (a CV) comes back as bytes; everything else is JSON.
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
      return { status: response.status, body: null, bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
    }
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };

  // How an account signs in, as Supabase Auth would report it: whether it has two-step
  // sign-in on, and whether this session gave the code.
  const signedInWith = (user, security) => Object.assign(users.get(user.token), security);

  return {
    pg, db, deps, clover, logs, stored, sent, state, accounts, deliveries, asked, addUser, signInAs, connect, api, signedInWith,
    createRestaurant: (slug) => createRestaurant(pg, slug),
    settle: async () => { while (background.length > 0) await background.shift(); },
  };
}
