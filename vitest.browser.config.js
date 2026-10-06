import { defineConfig } from "vitest/config";

// Real-browser tests. Slow, so they are separate from `npm test`:  npm run test:browser
export default defineConfig({
  test: {
    include: ["tests/browser/**/*.spec.js"],
    // One Chromium at a time: these machines are not fast, and parallel browsers make
    // timing-sensitive checks (focus, dialogs) flaky.
    fileParallelism: false,
    hookTimeout: 300_000,
    testTimeout: 300_000,
  },
});
