// Lint rules for the JavaScript in this repository. The TypeScript under
// supabase/functions is checked by `npm run typecheck` (tsc) and `npm run check:deno`.
import js from "@eslint/js";
import globals from "globals";

const strict = {
  ...js.configs.recommended.rules,
  eqeqeq: ["error", "always"],
  "no-var": "error",
  "prefer-const": "error",
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
  // The site's Content-Security-Policy forbids both. Keep them out of the source too.
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-restricted-properties": ["error",
    { property: "innerHTML", message: "Build DOM nodes with h() from src/js/lib/dom.js. innerHTML with data is an XSS risk." },
    { property: "outerHTML", message: "Build DOM nodes with h() from src/js/lib/dom.js." },
    { property: "insertAdjacentHTML", message: "Build DOM nodes with h() from src/js/lib/dom.js." },
  ],
  "no-restricted-globals": ["error",
    { name: "localStorage", message: "Nothing in this codebase stores data in localStorage. The Supabase client manages its own session." },
  ],
};

export default [
  { ignores: ["dist/**", ".cache/**", ".visual/**", "node_modules/**", "supabase/**"] },
  {
    files: ["src/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.browser },
    rules: strict,
  },
  {
    files: ["build/**/*.js", "scripts/**/*.{js,mjs}", "tests/**/*.js", "*.config.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: strict,
  },
  {
    // Browser test code runs partly inside the page (page.evaluate callbacks).
    files: ["tests/browser/**/*.js", "scripts/measure-performance.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    // Tests read the rendered markup to assert on it; they never write it.
    rules: { "no-restricted-properties": "off" },
  },
];
