// Starts each Edge Function under Deno, exactly as its index.ts is written, and sends it
// real HTTP requests. This is the only check that executes the entry files and the
// Supabase wiring in runtime.ts; the Vitest suite runs the same handlers under Node.
//
// No Supabase project is involved: SUPABASE_URL points at a closed local port, so every
// database call fails. What is verified is that the functions boot under Deno, route, apply
// their own guards before touching the database, and answer database failures with a safe
// message instead of crashing or leaking details.
//
// Usage: npm run check:deno
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const denoBin = resolve(dirname(require.resolve("deno/package.json")), "bin.cjs");
const ORIGIN = "https://luzenarestaurant.com";
const PORT = 54391;

const env = {
  ...process.env,
  DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${PORT}`,
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: "smoke-test-not-a-real-key",
  ALLOWED_ORIGINS: ORIGIN,
  CLOVER_ENV: "sandbox",
  CLOVER_APP_ID: "SMOKEAPP00001",
  CLOVER_APP_SECRET: "smoke-secret-value",
  CLOVER_REDIRECT_URI: `${ORIGIN}/dashboard/`,
  CLOVER_WEBHOOK_AUTH: "smoke-webhook-auth",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  IP_HASH_SALT: "smoke",
  CRON_SECRET: "smoke-cron-secret-0123456789-0123456789",
};

const base = `http://127.0.0.1:${PORT}`;
const json = (response) => response.text().then((text) => { try { return JSON.parse(text); } catch { return text; } });

// Each check returns the reason it failed, or null.
const FUNCTIONS = {
  "public-menu": [
    ["answers a database outage with the safe message", async () => {
      const response = await fetch(`${base}/functions/v1/public-menu?restaurant=luzena`, { headers: { origin: ORIGIN } });
      const body = await json(response);
      if (response.status !== 503) return `status ${response.status}`;
      if (body?.error?.message !== "Menu temporarily unavailable. Please try again shortly.") return `body ${JSON.stringify(body)}`;
      if (response.headers.get("access-control-allow-origin") !== ORIGIN) return "missing CORS header for the allowed origin";
      return JSON.stringify(body).match(/127\.0\.0\.1|ECONN|stack|at /i) ? "response leaks internals" : null;
    }],
    ["rejects a malformed restaurant id without touching the database", async () => {
      const response = await fetch(`${base}/functions/v1/public-menu?restaurant=../x`);
      return response.status === 404 ? null : `status ${response.status}`;
    }],
    ["refuses POST", async () => {
      const response = await fetch(`${base}/functions/v1/public-menu?restaurant=luzena`, { method: "POST" });
      return response.status === 405 ? null : `status ${response.status}`;
    }],
  ],
  "public-site": [
    ["answers a database outage with a safe message, so the page keeps its own photos", async () => {
      const response = await fetch(`${base}/functions/v1/public-site?restaurant=luzena`, { headers: { origin: ORIGIN } });
      const body = await json(response);
      if (response.status !== 503) return `status ${response.status}`;
      if (body?.error?.message !== "Not available.") return `body ${JSON.stringify(body)}`;
      if (response.headers.get("access-control-allow-origin") !== ORIGIN) return "missing CORS header for the allowed origin";
      return JSON.stringify(body).match(/127\.0\.0\.1|ECONN|stack|at /i) ? "response leaks internals" : null;
    }],
    ["rejects a malformed restaurant id without touching the database", async () => {
      const response = await fetch(`${base}/functions/v1/public-site?restaurant=../x`);
      return response.status === 404 ? null : `status ${response.status}`;
    }],
    ["refuses POST", async () => {
      const response = await fetch(`${base}/functions/v1/public-site?restaurant=luzena`, { method: "POST" });
      return response.status === 405 ? null : `status ${response.status}`;
    }],
  ],
  "job-application": [
    ["refuses a request with no allowed origin", async () => {
      const response = await fetch(`${base}/functions/v1/job-application`, { method: "POST", body: new FormData() });
      return response.status === 403 ? null : `status ${response.status}`;
    }],
    ["is closed by default (no JOB_APPLICATIONS_ENABLED)", async () => {
      const form = new FormData();
      form.append("full_name", "Smoke Test");
      const response = await fetch(`${base}/functions/v1/job-application`, { method: "POST", headers: { origin: ORIGIN }, body: form });
      const body = await json(response);
      return response.status === 503 && body?.error?.code === "applications_closed" ? null : `status ${response.status} ${JSON.stringify(body)}`;
    }],
    ["answers the CORS preflight", async () => {
      const response = await fetch(`${base}/functions/v1/job-application`, { method: "OPTIONS", headers: { origin: ORIGIN } });
      return response.status === 204 && response.headers.get("access-control-allow-origin") === ORIGIN ? null : `status ${response.status}`;
    }],
  ],
  "clover-webhook": [
    ["acknowledges Clover's verification request", async () => {
      const response = await fetch(`${base}/functions/v1/clover-webhook`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verificationCode: "smoke-code" }),
      });
      return response.status === 200 ? null : `status ${response.status}`;
    }],
    ["rejects an event without the shared secret", async () => {
      const response = await fetch(`${base}/functions/v1/clover-webhook`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchants: { ABCDEFGHJKLMN: [{ objectId: "I:ABCDEFGHJKLMN", type: "UPDATE" }] } }),
      });
      return response.status === 401 ? null : `status ${response.status}`;
    }],
    ["accepts an authenticated event and still answers 200 when the database is down", async () => {
      const response = await fetch(`${base}/functions/v1/clover-webhook`, {
        method: "POST", headers: { "content-type": "application/json", "x-clover-auth": "smoke-webhook-auth" },
        body: JSON.stringify({ merchants: { ABCDEFGHJKLMN: [{ objectId: "I:ABCDEFGHJKLMN", type: "UPDATE" }] } }),
      });
      return response.status === 200 ? null : `status ${response.status}`;
    }],
  ],
  "scheduled-tasks": [
    ["refuses a call without the scheduler's secret, and one with a wrong secret", async () => {
      const none = await fetch(`${base}/functions/v1/scheduled-tasks`, { method: "POST" });
      const wrong = await fetch(`${base}/functions/v1/scheduled-tasks`, { method: "POST", headers: { "x-cron-secret": "not-the-secret-not-the-secret-not-the-secret" } });
      return none.status === 401 && wrong.status === 401 ? null : `statuses ${none.status}, ${wrong.status}`;
    }],
    ["refuses GET", async () => {
      const response = await fetch(`${base}/functions/v1/scheduled-tasks`);
      return response.status === 405 ? null : `status ${response.status}`;
    }],
    ["runs for the scheduler and answers with counts only, also when the database is down", async () => {
      const response = await fetch(`${base}/functions/v1/scheduled-tasks`, { method: "POST", headers: { "x-cron-secret": env.CRON_SECRET } });
      const body = await json(response);
      if (response.status !== 200 || body?.ok !== true) return `status ${response.status} ${JSON.stringify(body)}`;
      return JSON.stringify(body).match(/127\.0\.0\.1|ECONN|stack/i) ? "response leaks internals" : null;
    }],
  ],
  "dashboard-api": [
    ["refuses a request with no session", async () => {
      const response = await fetch(`${base}/functions/v1/dashboard-api/me`, { headers: { origin: ORIGIN } });
      const body = await json(response);
      return response.status === 401 && body?.error?.code === "unauthenticated" ? null : `status ${response.status}`;
    }],
    ["refuses a forged token without crashing when Supabase Auth is unreachable", async () => {
      const response = await fetch(`${base}/functions/v1/dashboard-api/items`, { headers: { authorization: "Bearer forged.token.value" } });
      const body = await json(response);
      if (response.status !== 401) return `status ${response.status}`;
      return JSON.stringify(body).match(/127\.0\.0\.1|ECONN|stack/i) ? "response leaks internals" : null;
    }],
    ["refuses the team, an export and an invitation without a session", async () => {
      const json = { origin: ORIGIN, "content-type": "application/json" };
      const attempts = [
        await fetch(`${base}/functions/v1/dashboard-api/team`, { headers: { origin: ORIGIN } }),
        await fetch(`${base}/functions/v1/dashboard-api/team/invitations`, { method: "POST", headers: json, body: JSON.stringify({ email: "smoke@example.test", role: "manager" }) }),
        await fetch(`${base}/functions/v1/dashboard-api/applications/export`, { method: "POST", headers: json, body: JSON.stringify({ scope: "all" }) }),
        await fetch(`${base}/functions/v1/dashboard-api/account/invitations`, { headers: { origin: ORIGIN } }),
        await fetch(`${base}/functions/v1/dashboard-api/account/invitations/00000000-0000-4000-8000-000000000000/accept`, { method: "POST", headers: { origin: ORIGIN } }),
      ];
      const statuses = attempts.map((response) => response.status);
      for (const response of attempts) await response.body?.cancel();
      return statuses.every((status) => status === 401) ? null : `statuses ${statuses.join(", ")}`;
    }],
    ["answers 404 for an unknown route before authenticating", async () => {
      const response = await fetch(`${base}/functions/v1/dashboard-api/no-such-route`);
      return response.status === 404 ? null : `status ${response.status}`;
    }],
    ["answers the CORS preflight only for the allowed origin", async () => {
      const allowed = await fetch(`${base}/functions/v1/dashboard-api/me`, { method: "OPTIONS", headers: { origin: ORIGIN } });
      const other = await fetch(`${base}/functions/v1/dashboard-api/me`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
      if (allowed.headers.get("access-control-allow-origin") !== ORIGIN) return "allowed origin got no CORS header";
      return other.headers.get("access-control-allow-origin") === null ? null : "a foreign origin was granted CORS";
    }],
  ],
};

// Waits until nothing answers on the port any more. The next function must not start until
// the last one has gone: otherwise "is it listening yet?" is answered by the old one and its
// checks are run against the wrong function (seen on a slow machine: the webhook's checks
// answered 403 by the job application function, the dashboard's 405 by the webhook).
async function waitUntilStopped(child) {
  await Promise.race([
    child.exitCode !== null ? Promise.resolve() : new Promise((done) => child.once("exit", done)),
    new Promise((done) => setTimeout(done, 15000)),
  ]);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) });
    } catch {
      return;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`port ${PORT} is still answering 30 seconds after the function was stopped`);
}

async function waitUntilListening(child) {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`exited with code ${child.exitCode}\n${output}`);
    try {
      await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) });
      return () => output;
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  throw new Error(`did not start listening within 2 minutes\n${output}`);
}

let failures = 0;
for (const [name, checks] of Object.entries(FUNCTIONS)) {
  const child = spawn(process.execPath, [denoBin, "run", "--allow-net", "--allow-env", `supabase/functions/${name}/index.ts`], { cwd: root, env });
  try {
    const output = await waitUntilListening(child);
    console.log(`\n${name}: started under Deno`);
    for (const [label, check] of checks) {
      let problem;
      try {
        problem = await check();
      } catch (error) {
        problem = `threw ${error.message}`;
      }
      console.log(`  ${problem ? "FAIL" : "ok  "}  ${label}${problem ? `  ->  ${problem}` : ""}`);
      if (problem) failures += 1;
    }
    // Secrets must never reach the function's own log output.
    if (/smoke-secret-value|smoke-test-not-a-real-key|smoke-cron-secret/.test(output())) {
      console.log("  FAIL  a secret appeared in the function's log output");
      failures += 1;
    } else {
      console.log("  ok    no secret in the function's log output");
    }
  } catch (error) {
    console.log(`\n${name}: FAILED TO START\n${error.message}`);
    failures += 1;
  } finally {
    child.kill();
    try {
      await waitUntilStopped(child);
    } catch (error) {
      console.log(`
${name}: ${error.message}`);
      failures += 1;
    }
  }
}

console.log(failures === 0 ? "\nAll Deno smoke checks passed." : `\n${failures} Deno smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
