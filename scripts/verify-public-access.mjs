// The outside view of a Supabase project: what can a stranger do with the PUBLIC key that
// ships in the website's JavaScript? The answer has to be "nothing". Run it after
// `npm run verify:database`, which checks the same thing from inside the database.
//
//   PowerShell:  $env:SUPABASE_URL = "https://<ref>.supabase.co"
//                $env:SUPABASE_PUBLIC_KEY = "<publishable or anon key>"
//                npm run verify:public-access
//
// Every attempt below is expected to be refused. If one succeeds it may leave a row or a
// file named "intruder" behind: the output says so, and it must be removed by hand.
const base = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const key = process.env.SUPABASE_PUBLIC_KEY ?? "";
if (!base || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_PUBLIC_KEY (see the top of this file).");
  process.exit(2);
}

const NOBODY = "00000000-0000-0000-0000-000000000000";
const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ATTEMPTS = [
  ["read menu_items", "GET", "/rest/v1/menu_items?select=*"],
  ["read job_applications", "GET", "/rest/v1/job_applications?select=*"],
  ["read clover_connections", "GET", "/rest/v1/clover_connections?select=*"],
  ["read audit_logs", "GET", "/rest/v1/audit_logs?select=*"],
  ["read restaurant_users", "GET", "/rest/v1/restaurant_users?select=*"],
  ["insert a restaurant", "POST", "/rest/v1/restaurants", json({ slug: "intruder", name: "Intruder" })],
  ["delete restaurants", "DELETE", "/rest/v1/restaurants?slug=neq.x"],
  ["call clover_connection_secret", "POST", "/rest/v1/rpc/clover_connection_secret", json({ p_restaurant: NOBODY })],
  ["call public_menu", "POST", "/rest/v1/rpc/public_menu", json({ p_restaurant: NOBODY })],
  ["call rate_limit_hit", "POST", "/rest/v1/rpc/rate_limit_hit", json({ p_key: "intruder", p_max: 5, p_window_seconds: 60 })],
  ["list the cvs bucket", "POST", "/storage/v1/object/list/cvs", json({ prefix: "", limit: 10 })],
  ["upload a file to the cvs bucket", "POST", "/storage/v1/object/cvs/intruder.pdf", { headers: { "content-type": "application/pdf" }, body: "%PDF-1.7 intruder" }],
  ["upload a file to the menu-images bucket", "POST", "/storage/v1/object/menu-images/intruder.png", { headers: { "content-type": "image/png" }, body: "\x89PNG intruder" }],
  ["download from the cvs bucket", "GET", "/storage/v1/object/cvs/anything.pdf"],
];

let failures = 0;
let gotThrough = 0;
for (const [label, method, path, extra = {}] of ATTEMPTS) {
  let status = 0;
  let text;
  try {
    const response = await fetch(`${base}${path}`, {
      method, body: extra.body, signal: AbortSignal.timeout(30_000),
      headers: { apikey: key, authorization: `Bearer ${key}`, ...extra.headers },
    });
    status = response.status;
    text = (await response.text()).replace(/\s+/g, " ").slice(0, 110);
  } catch (error) {
    text = `request failed: ${error.message}`;
  }
  // Listing a bucket answers 200 with an empty list when no policy allows reading: that is
  // a refusal too. Anything else in the 2xx range means the stranger got through.
  const emptyList = label.startsWith("list") && status === 200 && text === "[]";
  const refused = (status >= 400 && status < 500) || emptyList;
  if (!refused) {
    failures += 1;
    gotThrough += 1;
  }
  console.log(`${refused ? "ok  " : "FAIL"}  a stranger cannot ${label}  (HTTP ${status}) ${text}`);
}

// Sign-ups are read from the project's public settings, not tried: trying would create a
// real account if they are open.
try {
  const response = await fetch(`${base}/auth/v1/settings`, { headers: { apikey: key }, signal: AbortSignal.timeout(30_000) });
  const settings = await response.json();
  const closed = settings.disable_signup === true;
  if (!closed) failures += 1;
  console.log(`${closed ? "ok  " : "FAIL"}  a stranger cannot create an account  (disable_signup = ${settings.disable_signup})${closed ? "" : "  Fix: Authentication > Sign In / Providers > turn off \"Allow new users to sign up\"."}`);
} catch (error) {
  failures += 1;
  console.log(`FAIL  could not read the sign-up setting: ${error.message}`);
}

console.log(failures === 0
  ? "\nThe public key can do nothing here."
  : `\n${failures} check(s) FAILED. Do not deploy to this project until they pass.${gotThrough > 0 ? ' Look for and remove anything named "intruder".' : ""}`);
process.exit(failures === 0 ? 0 : 1);
