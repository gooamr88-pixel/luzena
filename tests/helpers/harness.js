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
  const state = { emailFails: false };

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
    },
    auth: { getUser: async (jwt) => users.get(jwt) ?? null },
    email: {
      send: async (message) => {
        if (state.emailFails) throw new Error("provider down");
        sent.push(message);
      },
    },
  };

  const addUser = async (restaurantId, role = "owner") => {
    const user = await createUser(pg, restaurantId, role);
    const token = `jwt-${user.id}`;
    users.set(token, user);
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
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };

  return {
    pg, db, deps, clover, logs, stored, sent, state, addUser, connect, api,
    createRestaurant: (slug) => createRestaurant(pg, slug),
    settle: async () => { while (background.length > 0) await background.shift(); },
  };
}
