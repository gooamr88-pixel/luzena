import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { ROOT } from "./build/content.js";
import { PAGES } from "./build/pages.js";
import { sitePlugin } from "./build/site-plugin.js";

export default defineConfig(({ command, mode }) => {
  // CONTENT_PROFILE=sample lays sample photos, a sample menu and a sample ordering link
  // over the real content and marks every page as a sample. Anything else is a production
  // build, which reads the real content only and refuses to run if required parts are missing.
  const profile = process.env.CONTENT_PROFILE === "sample" ? "sample" : "production";
  // Variables from the hosting dashboard arrive in process.env; local .env files are read
  // here. VITE_* values reach the browser. CLOVER_ORDERING_URL is used by the build only.
  const env = loadEnv(mode, ROOT, ["VITE_", "CLOVER_ORDERING_URL"]);

  return {
    appType: "mpa",
    plugins: [
      tailwindcss(),
      sitePlugin({
        profile,
        strict: command === "build" && profile === "production",
        supabaseUrl: (env.VITE_SUPABASE_URL ?? "").replace(/\/$/, ""),
        demoDashboard: env.VITE_DASHBOARD_DEMO === "1",
        buildEnv: { CLOVER_ORDERING_URL: env.CLOVER_ORDERING_URL ?? "" },
      }),
    ],
    build: {
      target: "es2022",
      rollupOptions: {
        input: Object.fromEntries(PAGES.map((page) => [page.id, resolve(ROOT, page.file)])),
      },
    },
  };
});
