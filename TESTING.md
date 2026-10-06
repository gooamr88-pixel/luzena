# Testing

What is tested, how to run it, what the last run showed, and what is still untested.

## Running

```bash
npm run verify                 # everything below except the sandbox tests and the measurements
npm run lint                   # ESLint
npm run typecheck              # TypeScript check of the backend (tsc)
npm run check:content          # what the production content still lacks
npm test                       # unit, SQL and API tests (a few minutes: each database file boots its own Postgres)
npm run check:deno             # Deno type-check of the Edge Functions, then start each one and call it
npm run test:browser           # build the site twice, then drive it in a real Chromium
npm run measure:performance    # load-time and size measurements (after npm run build:e2e)
npm run test:clover-sandbox    # against a real Clover sandbox; skipped until credentials are set
npm run verify:database        # on a real Supabase project, after the migrations: is it closed? (needs DATABASE_URL)
```

`verify:database` reads the connection string from the `DATABASE_URL` environment variable
and changes nothing: every statement runs in a transaction that is rolled back. Run it on
every project after `supabase db push` and before deploying anything else there.

`npm run verify:public-access` is the same question asked from outside: with only the public
key that ships in the website (`SUPABASE_URL`, `SUPABASE_PUBLIC_KEY`), it tries to read
tables, write, call functions and use storage, and reads whether sign-ups are open. Every
attempt must be refused.

`npm run verify:functions` is the outside view of the four deployed Edge Functions
(`SUPABASE_URL`, and `ALLOWED_ORIGIN` set to one origin from that project's
`ALLOWED_ORIGINS`). It is the first check in which the functions have a real database behind
them: an unknown restaurant must answer 404 from the database, not 503. It also checks the
session guard, CORS for the allowed origin only, the closed application form and the webhook
secret. With `SUPABASE_PUBLIC_KEY`, `OWNER_EMAIL` and `OWNER_PASSWORD` it signs in and reads
every dashboard screen. It writes no menu data. **Run against the TEST project on
2026-10-06, after the first deployment there: 15 of 15, and no response showing
internals.** The signed-in half has not run yet (TEST's Auth settings are still to be
applied). Not run against PRODUCTION: nothing is deployed there.

`npm run verify:site` is the outside view of a deployed website (`SITE_URL`, and
`EXPECT_SUPABASE_URL` set to the project that site must use). It checks HTTPS and the
redirects, every header in `deploy/headers.json` exactly as sent (on pages, on hashed files
and on the not-found page), robots, the sitemap, every public page (production content, the
right canonical address, no sample banner), that no dot-file and no repository file can be
fetched, that ORDER ONLINE and the application form are in the state they should be, and
that the pages and the dashboard code name the expected Supabase project and no other. Run
locally against a production build served with the production headers, everything that
needs no backend passes. **Not yet run against the real server:** the site is not deployed,
and the Nginx configuration has never been loaded by an Nginx (2026-10-05).

The browser tests need a Chromium. They use one already installed by Playwright under
`%LOCALAPPDATA%\ms-playwright`, or the executable named in `CHROME_PATH`.

## Last full run: 2026-10-05

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | Clean |
| Types | `npm run typecheck` | Clean |
| Production content | `npm run check:content` | 0 required items missing, 9 optional |
| Unit, SQL, API | `npm test` | **186 passed**, 0 failed, 5 files |
| Real database (TEST/STAGING project) | `npm run verify:database` after `supabase db push` | **30 of 30** checks pass, by query and by acting as each role (after one finding was fixed: see `SECURITY.md`) |
| Real database (PRODUCTION project, us-west-1) | The same | **30 of 30** checks pass |
| Outside view of PRODUCTION | `npm run verify:public-access`, with the public key | Every attempt to read, write, call a function or use storage is refused (14). **One check fails: sign-ups are still on**, a dashboard setting. |
| Deno | `npm run check:deno` | 4 functions type-check; **17 of 17** smoke checks pass |
| Real browser | `npm run test:browser` | **194 passed**, 0 failed, 3 files (public 132, dashboard 43, sample 19) |
| Clover sandbox | `npm run test:clover-sandbox` | **Not run.** No sandbox credentials exist. |
| Production build | `npm run build` | Succeeds. Image files in the output: `favicon.svg`, `media/logo.svg`, `media/og-default.png`, and nothing else. |

Everything above except the "Real database" row ran on one Windows machine. Nothing ran
against a deployed site, deployed functions, or Clover.

## What each layer is

### 1. Unit, SQL and API tests (`npm test`)

Vitest in Node. There are no mocks of the database: SQL tests and API tests run the real
migrations on PGlite, which is Postgres compiled to WebAssembly.

| File | Tests | What it exercises |
|---|---|---|
| `tests/sql.test.js` | 33 | The migrations and SQL functions directly, on a database that starts with Supabase's real default privileges: privileges on tables, sequences and functions, RLS, tenant isolation, listing filters and sorting, the public menu's visibility rules, sync preserving website data, locks, rate limiting, idempotency, OAuth state. |
| `tests/dashboard.test.js` | 51 | The dashboard API end to end: the real router and handlers, real SQL, and a fake Clover. Authentication, roles, validation, write-through, conflicts, partial saves, lost responses, idempotent creates, bulk actions, categories, modifiers, photos, token refresh, OAuth, audit. |
| `tests/public.test.js` | 28 | Public menu (including Clover being down, and its rate limit), Clover webhook, job application (both switches, the missing retention period, validation, file checks, bot traps, email failure, rate limit), deletion of applications past the retention period. |
| `tests/units.test.js` | 31 | Clover client retry rules, token parsing, normalisation of Clover data, encryption, log redaction, configuration, file sniffing, request validation. |
| `tests/frontend.test.js` | 39 | Money parsing and formatting, opening hours, the content gate (what blocks a build and what does not), the confirmed address, phone, hours and domain, the ordering-link rules, the application switch, the sample overlay, job departments, sitemap, robots, structured data. |

### 2. Edge Functions under Deno (`npm run check:deno`)

`deno check` type-checks the four entry files and everything they import. Then
`scripts/deno-smoke.mjs` starts each function under Deno, with test values for every secret
and **no database behind it**, and sends real HTTP requests. It checks what can be checked
without a database: that each function starts, refuses a missing or forged session,
answers CORS only to the allowed origin, validates input before touching anything, answers a
database outage with the safe message and no stack trace, and prints no secret in its logs.

It does **not** prove the functions work against a real Supabase project.

### 3. Real-browser tests (`npm run test:browser`)

`playwright-core` drives Chromium against two builds served by a small local server that
applies the response headers from `deploy/headers.json`, including the
Content-Security-Policy. A page that only works without those headers fails here. The
production Nginx configuration is generated from the same file, and a unit test in
`tests/frontend.test.js` fails if the committed configuration is stale or if any Nginx
`location` lacks a security header.

| File | Tests | Build | What it exercises |
|---|---|---|---|
| `tests/browser/public.spec.js` | 132 | **Production** build: real content, no sample data, no backend | Every public page: no script error, failed request or policy violation; one `h1`, no skipped heading level, title, language, skip link; WCAG 2.2 AA scan; no sideways scroll at 360, 390, 430, 768, 1024, 1280 and 1440 px. Canonical addresses on the confirmed domain, share image, sitemap, robots, structured data. No broken internal link. Phone, email, map and Instagram links. Address, hours and breakfast on the page and in the footer. ORDER ONLINE stays on-site while no Clover link exists. The menu's "unavailable" state. Careers with applications off: 18 roles, no form, no upload field. Skip link, focus ring, phone navigation dialog, tap-target sizes. **Only the logo, the icon and the generated share image are in the build: no photograph.** |
| `tests/browser/sample.spec.js` | 19 | Sample build | What needs data to exist: the rendered menu (prices, out-of-stock, market price, options, category chips), featured items, photo hero, gallery viewer with keyboard, and the application form: labels, validation, file-type refusal, a successful send (request intercepted and inspected), server validation errors, network failure, server failure. |
| `tests/browser/dashboard.spec.js` | 43 | Sample build, dashboard in **demo mode** | Sign-out and sign-in, password reset, overview, item list (search, filters, sorting, stock and visibility switches, archive with confirmation, bulk actions), item editor (source labels, live preview, unsaved-changes guard, save, validation, create, duplicate, missing item), categories (reorder, undo, add, rename, hide, archive), modifiers, Clover page, activity log, WCAG 2.2 AA scan of every screen, phone layout, no sideways scroll at the same seven widths. |

**What the dashboard browser tests do and do not prove.** Demo mode replaces Supabase Auth
and the dashboard API with an in-memory stand-in. So these tests prove the interface: what
is shown, when, what is sent, where focus goes. What the real API does with a request
(permissions, Clover writes, conflicts, partial saves) is proven in
`tests/dashboard.test.js`. **Nothing yet drives the real dashboard against a real backend**;
that needs a Supabase project.

The accessibility scan is axe-core with the WCAG 2.0, 2.1 and 2.2 A and AA rule sets. An
automated scan finds a minority of accessibility problems. It does not replace a pass with a
screen reader by a person, which has not been done.

### 4. Clover sandbox tests (`npm run test:clover-sandbox`)

`tests/sandbox/clover.sandbox.js` calls a real Clover sandbox through this project's own
Clover client. It is **skipped** unless `CLOVER_SANDBOX_MERCHANT_ID` and
`CLOVER_SANDBOX_TOKEN` are set, and it has **never been run**: there is no sandbox account.
`CLOVER_SANDBOX_TEST_PLAN.md` describes it and the manual checks that go with it.

## Performance measurements

`npm run measure:performance` loads each page of the built site in Chromium set up like
Lighthouse's mobile preset: a 390 px phone screen, CPU four times slower, 150 ms round trip,
1.6 Mbps down, empty cache, text compressed with Brotli as the host will serve it. Each page
is loaded three times and the median is reported.

**These are lab numbers from one machine.** They are not field data, the server was on the
same machine (so time to first byte is unrealistically small: a real visitor adds their
network distance to every figure), and the production build has no photographs yet.

### Production build, measured 2026-10-05

| Page | LCP | CLS | Blocking time | Requests | Transferred |
|---|---|---|---|---|---|
| `/` | 1.74 s | 0.002 | 1 ms | 14 | 161 kB |
| `/menu/` | 1.46 s | 0.001 | 0 ms | 14 | 161 kB |
| `/about/` | 1.66 s | 0.001 | 39 ms | 11 | 158 kB |
| `/locations/` | 1.55 s | 0.024 | 0 ms | 11 | 158 kB |
| `/gallery/` | 1.44 s | 0.000 | 0 ms | 11 | 157 kB |
| `/contact/` | 1.69 s | 0.000 | 0 ms | 11 | 158 kB |
| `/careers/` | 1.88 s | 0.037 | 16 ms | 11 | 160 kB |
| `/order/` | 2.05 s | 0.001 | 0 ms | 11 | 157 kB |
| `/privacy/` | 1.54 s | 0.017 | 0 ms | 11 | 157 kB |
| `/dashboard/` (sign-in not configured) | 0.90 s | 0.000 | 0 ms | 8 | 64 kB |

Google's "good" thresholds are LCP under 2.5 s and CLS under 0.1. Every page is inside both
under these conditions.

Where the bytes go on a public page (first visit): fonts 131 kB, logo 14.5 kB, CSS 8.8 kB,
HTML 2 to 5 kB, JavaScript 1.1 to 4.2 kB. **Fonts are four fifths of the page**: one
variable Playfair Display file and four weights of Open Sauce One (400, 500, 600, 700).
They do not delay the first paint (text shows in a fallback font and swaps), and they are
cached for a year after the first page. If the weight ever matters, dropping the 500 weight
is the cheapest saving, at the cost of a small change to how some labels look.

The small layout shifts on `/careers/` and `/locations/` come from that font swap: the web
font is slightly wider than the fallback, so a row of chips re-wraps.

### Sample build (stock photos, sample menu, dashboard demo), same conditions

Shown only to indicate what photographs and a live menu will add. The photos are stand-ins.

| Page | LCP | CLS | Blocking time | Requests | Transferred |
|---|---|---|---|---|---|
| `/` (photo hero, featured items) | 2.32 s | 0.028 | 171 ms | 17 | 220 kB |
| `/menu/` (12 items) | 1.71 s | 0.028 | 220 ms | 15 | 162 kB |
| `/gallery/` (6 photos) | 2.14 s | 0.027 | 0 ms | 18 | 308 kB |
| `/careers/` (form on) | 1.90 s | 0.296 | 35 ms | 12 | 163 kB |
| `/dashboard/` (demo, signed in) | 1.45 s | 0.001 | 406 ms | 11 | 117 kB |

The 0.296 on the sample `/careers/` was traced: the green "sample content" banner, which
only sample builds have, wraps onto a second line at 390 px when the web font arrives and
pushes the page down 16 px at the moment the chips re-wrap. The production build has no
banner; its careers page measures 0.037. Re-measure `/careers/` on the test deployment once
the application form is switched on.

The home page with a photo hero is the closest to the 2.5 s limit. When real photos arrive,
measure again: the hero photo becomes the largest element and decides this number.

The raw results are written to `.cache/performance-production.json` and
`.cache/performance-demo.json` (not committed).

## What "fake Clover" means, and its limit

`tests/helpers/fakeClover.js` is an in-memory stand-in for the Clover REST API. It
implements the endpoints this project calls, with the request and response shapes from
Clover's documentation, and it can inject failures: an error status, a dropped connection
before the write, or a dropped connection **after** the write was applied.

It proves how **this code** behaves for a given Clover response. It does **not** prove that
the real Clover API behaves as documented. No test that has been run talks to Clover.

## What is not tested

| Gap | Why | What to do |
|---|---|---|
| Real Clover API: OAuth, token refresh, inventory reads and writes, webhooks, rate limits | No Clover developer account exists | `CLOVER_SANDBOX_TEST_PLAN.md` |
| Edge Functions against a real Supabase project | Not deployed: needs the Supabase CLI signed in | `DEPLOYMENT_CHECKLIST.md` section 2 |
| Uploading to and reading from Storage | The buckets exist on the real project and are checked (private CVs, no policies); no file has been stored yet | First photo upload and first application after the functions are deployed |
| Supabase Auth itself (sign-in, reset emails, sessions) | Third-party service; API tests substitute a token-to-user map, browser tests a stand-in | Sign in on the test project |
| The dashboard against the real API in a browser | Needs a Supabase project | After the test deployment |
| Email delivery through Resend | No account | Send one real application on the test deployment |
| Accessibility with a screen reader | Needs a person | NVDA or VoiceOver pass over the public pages and the dashboard |
| Browsers other than Chromium | Only Chromium is installed | Open the deployed site in Safari (iPhone) and Firefox |
| Field performance (real visitors, real network, real photos) | Not deployed, photos postponed | Lighthouse and Search Console after go-live |
| Load | Not done | Not expected to matter at one restaurant's traffic |

## Visual checks

```bash
npm run build:demo
npx vite preview --port 4317 --host 127.0.0.1      # keep running
powershell -ExecutionPolicy Bypass -File scripts/screenshots.ps1
```

Screenshots land in `.visual/` (git-ignored) for every page at 390 px and 1440 px.
`build:demo` uses sample content and runs the dashboard on in-memory data, so no backend is
needed.

## A note on slow machines

The browser tests use long timeouts on purpose (`tests/browser/helpers/site.js`). On the
machine this was built on, a cold Chromium has taken over a minute to load one local page.
With Playwright's default 30 seconds that looked like broken sign-out and broken
navigation; it was neither. If a browser test times out, run it again alone before
believing it.

## Adding tests

- Backend logic: write the handler against the `Deps` ports in `_shared/types.ts`, then test
  it through `createHarness()` in `tests/helpers/harness.js`.
- New SQL: add it to a new migration and cover it in `tests/sql.test.js`.
- A new Clover call: add the route to `fakeClover.js` from Clover's documentation, add a row
  to the capability matrix, and say in the test name what behaviour of ours it proves.
- Anything a visitor or the owner sees or presses: `tests/browser/`. Test in the page what
  must be instantaneous (see the stock-switch test), and wait for a condition, never for a
  fixed time.
