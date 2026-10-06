import { defineConfig } from "vitest/config";

// Tests that talk to the REAL Clover sandbox. They need credentials and are never part of
// `npm test`. See CLOVER_SANDBOX_TEST_PLAN.md.   Run: npm run test:clover-sandbox
export default defineConfig({
  test: {
    include: ["tests/sandbox/**/*.sandbox.js"],
    fileParallelism: false,
    // Calls run one after another so the per-token rate limit is never the thing under test.
    sequence: { concurrent: false },
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
