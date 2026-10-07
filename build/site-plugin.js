// Vite plugin: renders the HTML pages from the content file at build time (Handlebars),
// serves and emits the optimised photos, and writes sitemap.xml and robots.txt.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import Handlebars from "handlebars";
import { ROOT, loadContent } from "./content.js";
import { buildMedia, cacheDir, jpegNear, largestJpeg, pictureHtml } from "./media.js";
import { PAGES, pageMeta } from "./pages.js";
import { jsonLdScript, restaurantJsonLd, robotsTxt, sitemapXml } from "./seo.js";

const PARTIALS_DIR = resolve(ROOT, "src", "partials");
const SAMPLE_MENU = resolve(ROOT, "content", "sample-menu.json");
const SAMPLE_SITE = resolve(ROOT, "content", "sample-site.json");

const MIME = { avif: "image/avif", webp: "image/webp", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml" };

export function sitePlugin({ profile, strict, supabaseUrl, demoDashboard = false, buildEnv = {} }) {
  const sample = profile === "sample";
  let site;
  let manifest = {};

  const refresh = async () => {
    if (!sample && demoDashboard) {
      throw new Error("VITE_DASHBOARD_DEMO=1 is only allowed with the sample profile. Remove it for a production build.");
    }
    const loaded = loadContent(profile, buildEnv);
    if (strict && loaded.issues.errors.length > 0) {
      throw new Error(
        "Production build stopped: the content or configuration is not fit to publish.\n" +
          loaded.issues.errors.map((error) => `  - ${error}`).join("\n") +
          "\nRun `npm run check:content` for the full list, or `npm run build:sample` to build with sample content.",
      );
    }
    site = loaded.site;
    manifest = await buildMedia(profile, site);
  };

  const render = (html, file) => {
    const engine = Handlebars.create();
    for (const name of readdirSync(PARTIALS_DIR)) {
      engine.registerPartial(basename(name, ".html"), readFileSync(resolve(PARTIALS_DIR, name), "utf8"));
    }
    engine.registerHelper("picture", (name, options) =>
      new engine.SafeString(pictureHtml(manifest, name, {
        alt: options.hash.alt, sizes: options.hash.sizes, className: options.hash.class,
        loading: options.hash.loading, fetchpriority: options.hash.fetchpriority,
      })));
    engine.registerHelper("eq", (a, b) => a === b);
    engine.registerHelper("or", (a, b) => a || b);
    engine.registerHelper("inc", (value) => Number(value) + 1);
    // URL of a vector file (the logo) for places that need a plain address, not a <picture>.
    engine.registerHelper("mediaUrl", (name) => manifest[name]?.url ?? "");
    engine.registerHelper("photoUrl", (name, width) => jpegNear(manifest, name, width) ?? "");
    engine.registerHelper("first", (list, count) => (Array.isArray(list) ? list.slice(0, count) : []));

    const page = PAGES.find((entry) => entry.file === file);
    if (!page) return html;
    const meta = pageMeta(page, site);
    // Link preview image: a chosen photo, or the one generated from the logo.
    const ogImage = (site.ogImage ? largestJpeg(manifest, site.ogImage) : null) ?? manifest.__og?.url ?? null;
    const apiBase = supabaseUrl ? `${supabaseUrl}/functions/v1` : "";

    return engine.compile(html)({
      site,
      page: {
        ...meta,
        noindex: meta.noindex || sample,
        ogImage: ogImage ? `${site.siteUrl}${ogImage}` : null,
        jsonLd: new engine.SafeString(page.id === "home" || page.id === "locations" || page.id === "contact"
          ? jsonLdScript(restaurantJsonLd(site, manifest))
          : ""),
      },
      build: {
        sample,
        apiBase,
        // Where the public menu is fetched from. The sample profile reads a local fixture.
        menuUrl: sample
          ? "/sample-api/menu.json"
          : apiBase ? `${apiBase}/public-menu?restaurant=${site.restaurantSlug}` : "",
        // Where the pages ask which photos the owner has chosen in the dashboard. Empty when
        // there is no backend: the pages then keep the photos they were built with.
        siteUrl: sample
          ? "/sample-api/site.json"
          : apiBase ? `${apiBase}/public-site?restaurant=${site.restaurantSlug}` : "",
        year: new Date().getFullYear(),
      },
    });
  };

  return {
    name: "restaurant-site",

    async buildStart() {
      await refresh();
    },

    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        const file = relative(ROOT, context.filename).replace(/\\/g, "/");
        return render(html, file);
      },
    },

    configureServer(server) {
      server.watcher.add([resolve(ROOT, "content"), PARTIALS_DIR]);
      server.watcher.on("change", async (path) => {
        if (path.includes("content") || path.includes("partials")) {
          await refresh();
          server.ws.send({ type: "full-reload" });
        }
      });
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? "").split("?")[0];
        if (url.startsWith("/media/")) {
          const file = resolve(cacheDir(profile), basename(url));
          if (existsSync(file)) {
            response.setHeader("content-type", MIME[file.split(".").pop()] ?? "application/octet-stream");
            return response.end(readFileSync(file));
          }
        }
        if (sample && url === "/sample-api/menu.json") {
          response.setHeader("content-type", "application/json");
          return response.end(readFileSync(SAMPLE_MENU));
        }
        if (sample && url === "/sample-api/site.json") {
          response.setHeader("content-type", "application/json");
          return response.end(readFileSync(SAMPLE_SITE));
        }
        next();
      });
    },

    generateBundle() {
      for (const entry of Object.values(manifest)) {
        for (const fileName of entry.files) {
          this.emitFile({ type: "asset", fileName: `media/${fileName}`, source: readFileSync(resolve(cacheDir(profile), fileName)) });
        }
      }
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemapXml(site) });
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robotsTxt(site, sample) });
      if (sample) {
        this.emitFile({ type: "asset", fileName: "sample-api/menu.json", source: readFileSync(SAMPLE_MENU) });
        this.emitFile({ type: "asset", fileName: "sample-api/site.json", source: readFileSync(SAMPLE_SITE) });
      }
    },
  };
}
