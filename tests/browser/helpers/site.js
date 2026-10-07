// Serves a built site the way production will, and drives a real Chromium against it.
//
// The server applies the response headers from deploy/headers.json, including the
// Content-Security-Policy, so a page that only works without those headers fails here
// rather than after deployment. The production Nginx configuration is generated from the
// same file (scripts/build-nginx-config.mjs).
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { chromium } from "playwright-core";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif",
  ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
};

const { headers } = JSON.parse(readFileSync(join(ROOT, "deploy", "headers.json"), "utf8"));
const HEADER_RULES = headers.map((rule) => ({ pattern: new RegExp(`^${rule.source}$`), headers: rule.headers }));

const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".xml", ".txt"]);

// `compress` answers with Brotli where the browser accepts it, as the host does. Only the
// performance measurement asks for it; the tests do not care how the bytes travel.
export function serveBuild(name, { compress = false } = {}) {
  const dir = join(ROOT, ".cache", "e2e", name);
  if (!existsSync(join(dir, "index.html"))) {
    throw new Error(`No build at ${dir}. Run \`npm run build:e2e\` first (npm run test:browser does it for you).`);
  }
  const compressed = new Map();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
    for (const rule of HEADER_RULES) {
      if (rule.pattern.test(path)) for (const header of rule.headers) response.setHeader(header.key, header.value);
    }
    let file = join(dir, path);
    if (existsSync(file) && statSync(file).isDirectory()) {
      // As Nginx does for a directory asked for without its trailing slash.
      if (!path.endsWith("/")) {
        response.writeHead(301, { location: `${path}/` });
        return response.end();
      }
      file = join(file, "index.html");
    }
    const found = existsSync(file) && statSync(file).isFile();
    const target = found ? file : join(dir, "404.html");
    const type = TYPES[extname(target)] ?? "application/octet-stream";
    if (compress && COMPRESSIBLE.has(extname(target)) && /\bbr\b/.test(request.headers["accept-encoding"] ?? "")) {
      if (!compressed.has(target)) compressed.set(target, brotliCompressSync(readFileSync(target)));
      response.writeHead(found ? 200 : 404, { "content-type": type, "content-encoding": "br", vary: "accept-encoding" });
      return response.end(compressed.get(target));
    }
    response.writeHead(found ? 200 : 404, { "content-type": type });
    createReadStream(target).pipe(response);
  });
  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => ready({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (existsSync(base)) {
    const builds = readdirSync(base).filter((entry) => /^chromium-\d+$/.test(entry)).sort().reverse();
    for (const build of builds) {
      for (const candidate of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]) {
        if (existsSync(join(base, build, candidate))) return join(base, build, candidate);
      }
    }
  }
  throw new Error("No Chromium found. Set CHROME_PATH to a Chrome or Chromium executable.");
}

export const launchBrowser = () => chromium.launch({ executablePath: findChromium(), headless: true });

// Opens a page and records everything that should never happen on it: script errors,
// console errors (which include Content-Security-Policy violations), failed requests and
// error responses for sub-resources.
//
// `prepare` is given the browser context before the page loads, for a test that answers a
// request the page makes as it opens.
//
// Pages open as for a visitor who has asked for reduced motion, unless `motion` is true. The
// site's animations do not exist for that visitor, so what is measured (positions, sizes,
// contrast) is the page as it comes to rest, not a frame of something still moving. The
// animations have tests of their own, which ask for `motion`.
export async function openPage(browser, url, { width = 1280, height = 900, allowRequestFailures = [], prepare, motion = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion ? "no-preference" : "reduce" });
  await prepare?.(context);
  // The map on the home and locations pages is Google's own page in a frame. The tests
  // answer for it with an empty page, so they check this site's markup and layout and do not
  // pass or fail with Google or with the network.
  await context.route("https://www.google.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html lang="en"><title>Map</title><body></body></html>' }));
  const page = await context.newPage();
  // A cold browser on a busy machine has been seen to take over a minute to load one page
  // and ten seconds to answer a click. The defaults (30 s) turned that into false failures.
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(90_000);
  const problems = [];
  const allowed = (text) => allowRequestFailures.some((pattern) => pattern.test(text));
  page.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !allowed(message.text())) problems.push(`console error: ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    if (!allowed(request.url())) problems.push(`request failed: ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url() !== url && !allowed(response.url())) {
      problems.push(`HTTP ${response.status()}: ${response.url()}`);
    }
  });
  const response = await page.goto(url, { waitUntil: "load" });
  return { page, context, problems, status: response.status() };
}

// Runs axe-core against the WCAG 2.2 AA rule set. page.evaluate is used to load axe
// because the site's CSP rightly blocks injected <script> tags.
export async function accessibilityViolations(page, { exclude = [] } = {}) {
  await page.evaluate(AXE_SOURCE);
  const result = await page.evaluate((excluded) => window.axe.run(
    excluded.length ? { exclude: excluded.map((selector) => [selector]) } : document,
    { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } },
  ), exclude);
  return result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.slice(0, 4).map((node) => `${node.target.join(" ")} :: ${node.failureSummary?.split("\n").slice(1, 3).join(" ").trim()}`),
  }));
}

export const describeViolations = (violations) =>
  violations.map((violation) => `[${violation.impact}] ${violation.id}: ${violation.help}\n    ${violation.nodes.join("\n    ")}`).join("\n");

// True when nothing on the page is wider than the viewport.
export const hasHorizontalOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

export const VIEWPORT_WIDTHS = [360, 390, 430, 768, 1024, 1280, 1440];
