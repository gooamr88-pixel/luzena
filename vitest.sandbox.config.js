import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Tests that talk to the REAL Clover sandbox. They need credentials and are never part of
// `npm test`. See CLOVER_SANDBOX_TEST_PLAN.md.   Run: npm run test:clover-sandbox
//
// Credentials come from the environment, or from .env.clover-sandbox.local in this folder
// (git-ignored). Only CLOVER_SANDBOX_* names are read from the file, and nothing in it is
// ever printed. A value already in the environment wins.
const FILE = new URL("./.env.clover-sandbox.local", import.meta.url);
const fromFile = {};
if (existsSync(FILE)) {
  for (const line of readFileSync(FILE, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(CLOVER_SANDBOX_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && match[2] !== "" && process.env[match[1]] === undefined) {
      fromFile[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
}

export default defineConfig({
  test: {
    include: ["tests/sandbox/**/*.sandbox.js"],
    env: fromFile,
    fileParallelism: false,
    // Calls run one after another so the per-token rate limit is never the thing under test.
    sequence: { concurrent: false },
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
