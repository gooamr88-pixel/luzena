// The outside view of the four deployed Edge Functions on a real Supabase project: do they
// answer, do they reach the database, and do they refuse what they should? Run it after
// `supabase functions deploy` and `supabase secrets set`, on EVERY project.
// `npm run check:deno` asks the same questions with no database behind the functions; this
// is the first check that has one.
//
//   PowerShell:  $env:SUPABASE_URL = "https://<ref>.supabase.co"
//                $env:ALLOWED_ORIGIN = "<one origin from that project's ALLOWED_ORIGINS>"
//                npm run verify:functions
//
// Optional, to prove a real sign-in end to end (dashboard, tenant resolution, every read):
//                $env:SUPABASE_PUBLIC_KEY = "<publishable or anon key>"
//                $env:OWNER_EMAIL = "..."; $env:OWNER_PASSWORD = "..."
//
// Set these in the shell only. Do not put them in a file. Nothing here writes menu data;
// the only rows it leaves are rate-limit counters, which expire.
const base = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const origin = (process.env.ALLOWED_ORIGIN ?? "").replace(/\/$/, "");
const slug = process.env.RESTAURANT_SLUG ?? "luzena";
const publicKey = process.env.SUPABASE_PUBLIC_KEY ?? "";
const ownerEmail = process.env.OWNER_EMAIL ?? "";
const ownerPassword = process.env.OWNER_PASSWORD ?? "";
if (!base || !origin) {
  console.error("Set SUPABASE_URL and ALLOWED_ORIGIN (see the top of this file).");
  process.exit(2);
}

const api = `${base}/functions/v1`;
const FOREIGN_ORIGIN = "https://evil.example";
const NOBODY = "00000000-0000-4000-8000-000000000000";
const LEAK = /ECONN|"stack"|\bat \S+ \(\S+:\d+|service_role|Database call/i;

// Every response from every check is also screened for internals.
const leaks = [];
async function call(path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${api}${path}`, { method, headers, body, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  if (LEAK.test(text)) leaks.push(`${method} ${path}`);
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, text, data, code: data?.error?.code ?? null };
}
const describe = (r) => `HTTP ${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 120)}`;

// Each check returns the reason it failed, or null.
const CHECKS = [
  ["public-menu reaches the database (an unknown restaurant is 404, not 503)", async () => {
    const r = await call("/public-menu?restaurant=zz-verify-no-such-restaurant", { headers: { origin } });
    return r.status === 404 && r.code === "menu_unavailable" ? null : describe(r);
  }],
  [`public-menu knows the restaurant "${slug}"`, async () => {
    const r = await call(`/public-menu?restaurant=${slug}`, { headers: { origin } });
    if (r.status === 200 && Array.isArray(r.data?.categories)) return null;
    // 503 with the safe message is right until Clover is connected and has synced once.
    if (r.status === 503 && r.data?.error?.message === "Menu temporarily unavailable. Please try again shortly.") return null;
    return r.code === "menu_unavailable" ? "404: no restaurant with this slug. Run supabase/provision-restaurant.sql." : describe(r);
  }],
  ["public-menu grants CORS to the allowed origin only", async () => {
    const allowed = await call(`/public-menu?restaurant=${slug}`, { headers: { origin } });
    const foreign = await call(`/public-menu?restaurant=${slug}`, { headers: { origin: FOREIGN_ORIGIN } });
    if (allowed.headers.get("access-control-allow-origin") !== origin) return `${origin} got no CORS header. Is it in ALLOWED_ORIGINS?`;
    return foreign.headers.get("access-control-allow-origin") === null ? null : "a foreign origin was granted CORS";
  }],
  ["public-menu refuses POST", async () => {
    const r = await call(`/public-menu?restaurant=${slug}`, { method: "POST" });
    return r.status === 405 ? null : describe(r);
  }],

  ["dashboard-api refuses a request with no session", async () => {
    const r = await call("/dashboard-api/me", { headers: { origin } });
    return r.status === 401 && r.code === "unauthenticated" ? null : describe(r);
  }],
  ["dashboard-api refuses a forged token (asked of Supabase Auth)", async () => {
    const r = await call("/dashboard-api/items", { headers: { authorization: "Bearer forged.token.value" } });
    return r.status === 401 && r.code === "unauthenticated" ? null : describe(r);
  }],
  ["dashboard-api refuses the public key used as a session", async () => {
    if (!publicKey) return "skipped";
    const r = await call("/dashboard-api/me", { headers: { authorization: `Bearer ${publicKey}`, apikey: publicKey } });
    return r.status === 401 ? null : describe(r);
  }],
  ["dashboard-api answers 404 for an unknown route", async () => {
    const r = await call("/dashboard-api/no-such-route");
    return r.status === 404 && r.code === "not_found" ? null : describe(r);
  }],
  ["dashboard-api answers the CORS preflight only for the allowed origin", async () => {
    const allowed = await call("/dashboard-api/me", { method: "OPTIONS", headers: { origin } });
    const foreign = await call("/dashboard-api/me", { method: "OPTIONS", headers: { origin: FOREIGN_ORIGIN } });
    if (allowed.headers.get("access-control-allow-origin") !== origin) return `${origin} got no CORS header`;
    return foreign.headers.get("access-control-allow-origin") === null ? null : "a foreign origin was granted CORS";
  }],

  ["job-application refuses a request with no allowed origin", async () => {
    const r = await call("/job-application", { method: "POST", body: new FormData() });
    return r.status === 403 && r.code === "forbidden_origin" ? null : describe(r);
  }],
  ["job-application refuses a foreign origin", async () => {
    const r = await call("/job-application", { method: "POST", headers: { origin: FOREIGN_ORIGIN }, body: new FormData() });
    return r.status === 403 ? null : describe(r);
  }],
  ["job-application is closed (JOB_APPLICATIONS_ENABLED and the retention period are not both set)", async () => {
    if (process.env.EXPECT_APPLICATIONS === "open") return "skipped";
    const form = new FormData();
    form.append("full_name", "Verification Check");
    const r = await call("/job-application", { method: "POST", headers: { origin }, body: form });
    return r.status === 503 && r.code === "applications_closed" ? null : describe(r);
  }],

  ["clover-webhook rejects an event without the shared secret", async () => {
    const r = await call("/clover-webhook", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchants: { ABCDEFGHJKLMN: [{ objectId: "I:ABCDEFGHJKLMN", type: "UPDATE" }] } }),
    });
    return r.status === 401 ? null : describe(r);
  }],
  ["clover-webhook rejects an event with a wrong secret", async () => {
    const r = await call("/clover-webhook", {
      method: "POST", headers: { "content-type": "application/json", "x-clover-auth": "not-the-secret" },
      body: JSON.stringify({ merchants: { ABCDEFGHJKLMN: [{ objectId: "I:ABCDEFGHJKLMN", type: "UPDATE" }] } }),
    });
    return r.status === 401 ? null : describe(r);
  }],
  ["clover-webhook refuses GET", async () => {
    const r = await call("/clover-webhook");
    return r.status === 405 ? null : describe(r);
  }],
];

// With an owner's credentials: sign in exactly as the dashboard does, then read every screen.
async function signedInChecks() {
  const response = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST", signal: AbortSignal.timeout(60_000),
    headers: { apikey: publicKey, "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  });
  const session = await response.json().catch(() => ({}));
  if (!response.ok || !session.access_token) {
    return [["the owner can sign in", () => `HTTP ${response.status} ${session.error_code ?? session.msg ?? ""}`]];
  }
  const signedIn = { authorization: `Bearer ${session.access_token}`, origin };
  const reads = ["/overview", "/items", "/categories", "/modifier-groups", "/clover", "/activity"];
  return [
    ["the owner can sign in", () => null],
    [`the owner's session resolves to the restaurant "${slug}" with the owner role`, async () => {
      const r = await call("/dashboard-api/me", { headers: signedIn });
      if (r.status !== 200) return describe(r);
      if (r.data?.restaurant?.slug !== slug) return `restaurant is ${JSON.stringify(r.data?.restaurant?.slug)}`;
      return r.data?.role === "owner" ? null : `role is ${JSON.stringify(r.data?.role)}`;
    }],
    ...reads.map((path) => [`the owner can read ${path}`, async () => {
      const r = await call(`/dashboard-api${path}`, { headers: signedIn });
      return r.status === 200 ? null : describe(r);
    }]),
    ["the owner cannot select a restaurant that is not theirs", async () => {
      const r = await call("/dashboard-api/me", { headers: { ...signedIn, "x-restaurant-id": NOBODY } });
      return r.status === 403 && r.code === "forbidden" ? null : describe(r);
    }],
    ["a write with no body is refused before anything changes", async () => {
      const r = await call("/dashboard-api/items", { method: "POST", headers: signedIn });
      return r.status >= 400 && r.status < 500 ? null : describe(r);
    }],
    ["signing out ends the session", async () => {
      await fetch(`${base}/auth/v1/logout`, {
        method: "POST", headers: { apikey: publicKey, authorization: `Bearer ${session.access_token}` }, signal: AbortSignal.timeout(60_000),
      });
      const r = await call("/dashboard-api/me", { headers: signedIn });
      return r.status === 401 ? null : describe(r);
    }],
  ];
}

let failures = 0;
let skipped = 0;

async function run(checks) {
  for (const [label, check] of checks) {
    let problem;
    try {
      problem = await check();
    } catch (error) {
      problem = `threw ${error.message}`;
    }
    if (problem === "skipped") {
      skipped += 1;
      console.log(`skip  ${label}`);
      continue;
    }
    if (problem) failures += 1;
    console.log(`${problem ? "FAIL" : "ok  "}  ${label}${problem ? `  ->  ${problem}` : ""}`);
  }
}

console.log(`Checking ${api}\n`);
await run(CHECKS);
if (publicKey && ownerEmail && ownerPassword) {
  console.log("");
  await run(await signedInChecks());
} else {
  console.log("\nskip  signed-in checks (set SUPABASE_PUBLIC_KEY, OWNER_EMAIL and OWNER_PASSWORD to run them)");
}

if (leaks.length > 0) failures += 1;
console.log(`${leaks.length > 0 ? "FAIL" : "ok  "}  no response shows internals${leaks.length > 0 ? `  ->  ${leaks.join(", ")}` : ""}`);

console.log(failures === 0
  ? `\nAll function checks passed.${skipped > 0 ? ` (${skipped} skipped)` : ""}`
  : `\n${failures} function check(s) FAILED. Fix them before pointing a website at this project.`);
process.exit(failures === 0 ? 0 : 1);
