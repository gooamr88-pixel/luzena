// Measures how each page of a built site loads on a mid-range phone on a slow connection.
//
//   npm run build:e2e && npm run measure:performance            (the production build)
//   npm run measure:performance -- demo                         (the sample build: photos, menu)
//
// These are LAB numbers from this machine, not field data from real visitors. The browser is
// slowed the way Lighthouse's mobile preset does it: CPU four times slower, 150 ms round
// trip, 1.6 Mbps down. Text is served with Brotli, as the host serves it. Each page is loaded
// three times with an empty cache and the median is reported.
//
// Results are printed and written to .cache/performance-<build>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, ROOT, serveBuild } from "../tests/browser/helpers/site.js";

const BUILD = process.argv[2] ?? "production";
const RUNS = Number(process.env.PERF_RUNS ?? 3);
const CPU_SLOWDOWN = Number(process.env.PERF_CPU_SLOWDOWN ?? 4);
const PAGES = ["/", "/menu/", "/about/", "/locations/", "/gallery/", "/contact/", "/careers/", "/order/", "/privacy/", "/dashboard/"];
const NETWORK = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };

// Runs in the page before any of its own scripts.
const observe = () => {
  const perf = (window.__perf = { lcp: 0, lcpElement: "", cls: 0, blocking: 0 });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      perf.lcp = entry.startTime;
      perf.lcpElement = entry.element ? entry.element.tagName.toLowerCase() : "";
    }
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) perf.cls += entry.value;
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) perf.blocking += Math.max(0, entry.duration - 50);
  }).observe({ type: "longtask", buffered: true });
};

const collect = () => {
  const navigation = performance.getEntriesByType("navigation")[0];
  const resources = performance.getEntriesByType("resource");
  const bytes = (entries) => entries.reduce((sum, entry) => sum + entry.transferSize, 0);
  const kind = (entry) => {
    const path = new URL(entry.name).pathname;
    if (/\.(avif|webp|jpe?g|png|svg)$/.test(path)) return "image";
    if (/\.woff2$/.test(path)) return "font";
    if (/\.css$/.test(path)) return "css";
    if (/\.js$/.test(path)) return "js";
    return "other";
  };
  const byKind = { html: navigation.transferSize, css: 0, js: 0, font: 0, image: 0, other: 0 };
  for (const entry of resources) byKind[kind(entry)] += entry.transferSize;
  return {
    ttfb: navigation.responseStart,
    fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
    lcp: window.__perf.lcp,
    lcpElement: window.__perf.lcpElement,
    cls: window.__perf.cls,
    blocking: window.__perf.blocking,
    load: navigation.loadEventEnd,
    requests: resources.length + 1,
    bytes: navigation.transferSize + bytes(resources),
    byKind,
  };
};

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const site = await serveBuild(BUILD, { compress: true });
const browser = await launchBrowser();
const results = [];

for (const path of PAGES) {
  const runs = [];
  for (let run = 0; run < RUNS; run += 1) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(120_000);
    await page.addInitScript(observe);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", NETWORK);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
    await page.goto(`${site.url}${path}`, { waitUntil: "load" });
    // Long enough for the menu request to settle and for late layout shifts to show up.
    await page.waitForTimeout(3000);
    runs.push(await page.evaluate(collect));
    await context.close();
  }
  const pick = (key) => median(runs.map((entry) => entry[key] ?? 0));
  const middle = runs.find((entry) => entry.lcp === pick("lcp")) ?? runs[0];
  results.push({
    path,
    ttfb_ms: Math.round(pick("ttfb")), fcp_ms: Math.round(pick("fcp")), lcp_ms: Math.round(pick("lcp")),
    lcp_element: middle.lcpElement, cls: Number(pick("cls").toFixed(3)), blocking_ms: Math.round(pick("blocking")),
    load_ms: Math.round(pick("load")), requests: middle.requests, transfer_kb: Number((middle.bytes / 1024).toFixed(1)),
    by_kind_kb: Object.fromEntries(Object.entries(middle.byKind).map(([key, value]) => [key, Number((value / 1024).toFixed(1))])),
  });
  console.log(JSON.stringify(results.at(-1)));
}

await browser.close();
await site.close();

const report = {
  build: BUILD, measured_at: new Date().toISOString(), runs_per_page: RUNS,
  conditions: { viewport: "390x844 @3x", cpu_slowdown: CPU_SLOWDOWN, round_trip_ms: NETWORK.latency, download_mbps: 1.6, upload_kbps: 750, compression: "brotli (text)", cache: "empty" },
  results,
};
mkdirSync(join(ROOT, ".cache"), { recursive: true });
writeFileSync(join(ROOT, ".cache", `performance-${BUILD}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Written to .cache/performance-${BUILD}.json`);
