import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    // Each database test file boots its own Postgres (PGlite, WASM), which takes several
    // seconds on a cold start.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
