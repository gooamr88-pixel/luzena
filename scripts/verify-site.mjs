// The outside view of a deployed website: is it served over HTTPS with the security headers,
// are robots.txt, the sitemap and every public page right, is it the production content and
// not the sample, and does it point at the Supabase project it is supposed to?
// Run it after every deployment.
//
//   PowerShell:  $env:SITE_URL = "https://luzenarestaurant.com"
//                $env:EXPECT_SUPABASE_URL = "https://<ref>.supabase.co"
//                npm run verify:site
//
// EXPECT_SUPABASE_URL is the project THIS deployment must use: the test project for a
// test build, the production project for the live site. A site that names any other project
// fails. Optional: WWW_URL (must redirect to SITE_URL), EXPECT_ORDERING_URL (the Clover
// ordering link once it is set), EXPECT_APPLICATIONS=open (once the form is switched on).
// Nothing is changed; every request is a read.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES } from "../build/pages.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = JSON.parse(readFileSync(resolve(ROOT, "content", "site.json"), "utf8"));
const { headers: HEADER_RULES } = JSON.parse(readFileSync(resolve(ROOT, "deploy", "headers.json"), "utf8"));

const base = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const expectedSupabase = (process.env.EXPECT_SUPABASE_URL ?? "").replace(/\/$/, "");
const wwwUrl = (process.env.WWW_URL ?? "").replace(/\/$/, "");
const expectedOrdering = process.env.EXPECT_ORDERING_URL ?? "";
if (!base || !expectedSupabase) {
  console.error("Set SITE_URL and EXPECT_SUPABASE_URL (see the top of this file).");
  process.exit(2);
}
const origin = new URL(base).origin;
const local = ["127.0.0.1", "localhost"].includes(new URL(base).hostname);
const PUBLIC_PAGES = PAGES.filter((page) => !["notfound", "dashboard"].includes(page.id));
const SUPABASE_HOST = /https:\/\/[a-z0-9]{20}\.supabase\.co/g;

async function get(url, { redirect = "manual", headers = {} } = {}) {
  const response = await fetch(url, { redirect, headers, signal: AbortSignal.timeout(60_000) });
  return { status: response.status, headers: response.headers, text: await response.text(), url: response.url };
}
const header = (r, name) => r.headers.get(name) ?? "";
// The headers a path must carry: every matching rule, a later one replacing an earlier one.
function headersFor(path) {
  const merged = new Map();
  for (const rule of HEADER_RULES) {
    if (!new RegExp(`^${rule.source}$`).test(path)) continue;
    for (const { key, value } of rule.headers) merged.set(key.toLowerCase(), { key, value });
  }
  return [...merged.values()];
}
const foreignProjects = (text) => [...new Set(text.match(SUPABASE_HOST) ?? [])].filter((host) => host !== expectedSupabase);

// Each check returns the reason it failed, "skipped", or null.
const CHECKS = [
  ["the site is served over HTTPS, and http:// redirects to it", async () => {
    if (local) return "skipped";
    if (!base.startsWith("https://")) return "SITE_URL is not https";
    const r = await get(base.replace(/^https:/, "http:") + "/");
    return [301, 308].includes(r.status) && header(r, "location").startsWith("https://") ? null : `HTTP ${r.status} location ${header(r, "location")}`;
  }],
  ["www redirects to the bare domain, keeping the path", async () => {
    if (!wwwUrl) return "skipped";
    const r = await get(`${wwwUrl}/menu`, { redirect: "follow" });
    return r.url === `${base}/menu/` && r.status === 200 ? null : `ended at ${r.url} (HTTP ${r.status})`;
  }],
  ["every header in deploy/headers.json is on the home page, exactly", async () => {
    const r = await get(`${base}/`);
    const wrong = headersFor("/").filter(({ key, value }) => header(r, key) !== value).map(({ key }) => key);
    return wrong.length === 0 ? null : `missing or different: ${wrong.join(", ")}`;
  }],
  ["the not-found page carries the security headers too", async () => {
    const r = await get(`${base}/zz-verify-no-such-page/`);
    const wrong = headersFor("/").filter(({ key, value }) => header(r, key) !== value).map(({ key }) => key);
    return wrong.length === 0 ? null : `missing or different: ${wrong.join(", ")}`;
  }],
  ["hashed assets are cached for a year, and still carry the security headers", async () => {
    const home = await get(`${base}/`);
    const asset = home.text.match(/\/assets\/[^"']+\.(?:css|js)/)?.[0];
    if (!asset) return "no /assets/ file referenced by the home page";
    const r = await get(`${base}${asset}`);
    if (r.status !== 200) return `HTTP ${r.status}`;
    const wrong = headersFor(asset).filter(({ key, value }) => header(r, key) !== value).map(({ key }) => key);
    if (wrong.length > 0) return `missing or different: ${wrong.join(", ")}`;
    return /immutable/.test(header(r, "cache-control")) ? null : `cache-control ${header(r, "cache-control")}`;
  }],
  ["nothing that starts with a dot is served", async () => {
    for (const path of ["/.env", "/.git/config", "/.git/HEAD"]) {
      const r = await get(`${base}${path}`);
      if (r.status !== 404) return `${path} answers HTTP ${r.status}`;
    }
    return null;
  }],
  ["the repository is not what is being served", async () => {
    // These exist in the repository and never in a build. Any of them answering means the
    // web server's root points at the checkout: backend source and development photos.
    for (const path of ["/package.json", "/content/site.json", "/supabase/config.toml", "/content/sample-media/hero.jpg", "/deploy/deploy.sh"]) {
      const r = await get(`${base}${path}`);
      if (r.status !== 404) return `${path} answers HTTP ${r.status}`;
    }
    return null;
  }],

  ["robots.txt allows crawling, keeps the dashboard out and names the sitemap", async () => {
    const r = await get(`${base}/robots.txt`);
    if (r.status !== 200) return `HTTP ${r.status}`;
    const lines = r.text.split(/\r?\n/).map((line) => line.trim());
    if (lines.includes("Disallow: /")) return "it blocks the whole site: this is a sample build";
    const wanted = ["Allow: /", "Disallow: /dashboard/", `Sitemap: ${site.siteUrl}/sitemap.xml`];
    const missing = wanted.filter((line) => !lines.includes(line));
    return missing.length === 0 ? null : `missing: ${missing.join(" | ")}`;
  }],
  ["sitemap.xml lists the indexable pages on the real domain, and each one answers", async () => {
    const r = await get(`${base}/sitemap.xml`);
    if (r.status !== 200) return `HTTP ${r.status}`;
    const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    if (locs.length < 5) return `only ${locs.length} pages listed`;
    const offDomain = locs.filter((loc) => !loc.startsWith(`${site.siteUrl}/`));
    if (offDomain.length > 0) return `not on ${site.siteUrl}: ${offDomain.join(", ")}`;
    if (locs.some((loc) => loc.includes("/dashboard"))) return "the dashboard is listed";
    for (const loc of locs) {
      const page = await get(`${base}${loc.slice(site.siteUrl.length)}`);
      if (page.status !== 200) return `${loc} answers HTTP ${page.status}`;
    }
    return null;
  }],

  ...PUBLIC_PAGES.map((page) => [`page ${page.path} is the production page`, async () => {
    const r = await get(`${base}${page.path}`);
    if (r.status !== 200) return `HTTP ${r.status}`;
    if (!header(r, "content-type").startsWith("text/html")) return `content-type ${header(r, "content-type")}`;
    if (/sample-banner|Sample address/.test(r.text)) return "it shows the SAMPLE banner";
    if (!/<title>[^<]*Luzena[^<]*<\/title>/.test(r.text)) return "no title naming the restaurant";
    const canonical = r.text.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    const noindex = /<meta name="robots" content="noindex/.test(r.text);
    if (!noindex && canonical !== `${site.siteUrl}${page.path}`) return `canonical is ${canonical}`;
    if (/luznarestaurant\.com/.test(r.text)) return "the old domain spelling appears";
    return foreignProjects(r.text).length === 0 ? null : `it names another Supabase project: ${foreignProjects(r.text).join(", ")}`;
  }]),
  ["a path without its trailing slash redirects to the one with it", async () => {
    const r = await get(`${base}/menu`);
    return [301, 307, 308].includes(r.status) && /\/menu\/$/.test(header(r, "location")) ? null : `HTTP ${r.status} location ${header(r, "location")}`;
  }],
  ["an unknown address answers 404 with the site's own page", async () => {
    const r = await get(`${base}/zz-verify-no-such-page/`);
    return r.status === 404 && /Page not found/.test(r.text) ? null : `HTTP ${r.status}`;
  }],

  ["the menu page loads its menu from the expected Supabase project", async () => {
    const r = await get(`${base}/menu/`);
    // The attribute is HTML-escaped in the page ("=" is written as "&#x3D;").
    const url = (r.text.match(/data-menu-url="([^"]*)"/)?.[1] ?? "").replace(/&#x3D;/gi, "=").replace(/&amp;/g, "&");
    const wanted = `${expectedSupabase}/functions/v1/public-menu?restaurant=${site.restaurantSlug}`;
    return url === wanted ? null : `data-menu-url is "${url}". The site was built with a different or missing VITE_SUPABASE_URL.`;
  }],
  ["the home, about and gallery pages ask the expected project for the owner's photos", async () => {
    const wanted = `${expectedSupabase}/functions/v1/public-site?restaurant=${site.restaurantSlug}`;
    for (const path of ["/", "/about/", "/gallery/"]) {
      const r = await get(`${base}${path}`);
      const url = (r.text.match(/data-site-url="([^"]*)"/)?.[1] ?? "").replace(/&#x3D;/gi, "=").replace(/&amp;/g, "&");
      if (url !== wanted) return `${path}: data-site-url is "${url}"`;
    }
    return null;
  }],
  ["ORDER ONLINE goes where it should", async () => {
    // Website -> Order Online page -> Clover: the home page's buttons stay on the site, and
    // only the Order page links to Clover.
    const cloverLinks = (text) => [...new Set(text.match(/href="https:\/\/[^"]*clover(?:online)?\.com[^"]*"/g) ?? [])];
    const home = await get(`${base}/`);
    if (!home.text.includes('href="/order/"')) return "the home page has no link to /order/";
    if (cloverLinks(home.text).length > 0) return `the home page links straight to Clover: ${cloverLinks(home.text).join(", ")}`;
    const order = await get(`${base}/order/`);
    if (expectedOrdering) return order.text.includes(`href="${expectedOrdering}"`) ? null : "the Order page does not link to EXPECT_ORDERING_URL";
    // No link expected: the Order page says ordering opens soon and names no Clover address.
    return cloverLinks(order.text).length === 0 ? null : `unexpected ordering link: ${cloverLinks(order.text).join(", ")}`;
  }],
  ["the application form is not published", async () => {
    if (process.env.EXPECT_APPLICATIONS === "open") return "skipped";
    const r = await get(`${base}/careers/`);
    return /data-apply-form/.test(r.text) ? "the careers page contains the application form" : null;
  }],

  ["the dashboard is served, never cached and kept out of search", async () => {
    const r = await get(`${base}/dashboard/`);
    if (r.status !== 200) return `HTTP ${r.status}`;
    const wrong = headersFor("/dashboard/").filter(({ key, value }) => header(r, key) !== value).map(({ key }) => key);
    if (wrong.length > 0) return `missing or different: ${wrong.join(", ")}`;
    if (!/noindex/.test(header(r, "x-robots-tag"))) return `x-robots-tag is "${header(r, "x-robots-tag")}"`;
    return /no-store/.test(header(r, "cache-control")) ? null : `cache-control is "${header(r, "cache-control")}"`;
  }],
  ["the dashboard signs in against the expected Supabase project, and is not the demo", async () => {
    const page = await get(`${base}/dashboard/`);
    const api = page.text.match(/data-api="([^"]*)"/)?.[1] ?? "";
    if (api !== `${expectedSupabase}/functions/v1`) return `data-api is "${api}"`;
    // Follow the scripts the page loads, one level of imports deep, and read what they name.
    const seen = new Set();
    let queue = [...page.text.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((match) => match[1]);
    let code = "";
    for (let depth = 0; depth < 3 && queue.length > 0; depth++) {
      const next = [];
      for (const path of queue) {
        if (seen.has(path) || seen.size >= 40) continue;
        seen.add(path);
        const script = await get(`${base}${path}`);
        if (script.status !== 200) return `${path} answers HTTP ${script.status}`;
        code += script.text;
        for (const match of script.text.matchAll(/["'`](?:\.\/|assets\/)([A-Za-z0-9_.-]+\.js)["'`]/g)) next.push(`/assets/${match[1]}`);
      }
      queue = next;
    }
    if (!code.includes(expectedSupabase)) return "the dashboard code does not name the expected project (VITE_SUPABASE_URL missing at build time?)";
    if (foreignProjects(code).length > 0) return `it names another Supabase project: ${foreignProjects(code).join(", ")}`;
    // The demo's code is a separate file that only a demo build contains.
    return [...seen].some((path) => /\/demo-/.test(path)) ? "this is the demo dashboard" : null;
  }],

  ["the backend answers this site's origin, and reaches its database", async () => {
    const r = await get(`${expectedSupabase}/functions/v1/public-menu?restaurant=zz-verify-no-such-restaurant`, { headers: { origin } });
    let code = null;
    try { code = JSON.parse(r.text)?.error?.code; } catch { /* not JSON */ }
    if (r.status !== 404 || code !== "menu_unavailable") return `HTTP ${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 100)}`;
    return header(r, "access-control-allow-origin") === origin ? null : `${origin} is not in that project's ALLOWED_ORIGINS`;
  }],
  [`the backend knows the restaurant "${site.restaurantSlug}"`, async () => {
    const r = await get(`${expectedSupabase}/functions/v1/public-menu?restaurant=${site.restaurantSlug}`, { headers: { origin } });
    // 503 is right until Clover is connected: the page then says the menu is unavailable.
    return r.status === 200 || r.status === 503 ? null : `HTTP ${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 100)}`;
  }],
  ["the backend answers with the website's photos", async () => {
    const r = await get(`${expectedSupabase}/functions/v1/public-site?restaurant=${site.restaurantSlug}`, { headers: { origin } });
    let photos = null;
    try { photos = JSON.parse(r.text)?.photos; } catch { /* not JSON */ }
    if (r.status !== 200 || !Array.isArray(photos?.gallery)) return `HTTP ${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 100)}`;
    return header(r, "access-control-allow-origin") === origin ? null : `${origin} is not in that project's ALLOWED_ORIGINS`;
  }],
  ["the dashboard API refuses a visitor who is not signed in", async () => {
    const r = await get(`${expectedSupabase}/functions/v1/dashboard-api/me`, { headers: { origin } });
    return r.status === 401 ? null : `HTTP ${r.status}`;
  }],
];

let failures = 0;
let skipped = 0;
console.log(`Checking ${base}  (expected backend: ${expectedSupabase})\n`);
for (const [label, check] of CHECKS) {
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

console.log(failures === 0
  ? `\nAll site checks passed.${skipped > 0 ? ` (${skipped} skipped)` : ""}`
  : `\n${failures} site check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
