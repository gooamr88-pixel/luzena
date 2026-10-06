# PROJECT_MEMORY

Single source of truth for progress and decisions. Read this first in any new session, then
`BLOCKERS.md`, `DEPLOYMENT_CHECKLIST.md` and `ARCHITECTURE.md`.

Last updated: 2026-10-05, after the client's go-ahead to deploy and the change of hosting
from Vercel to the client's Hostinger VPS (section 25). First commit made; nothing is
deployed yet: every remaining step waits on something only the client can do (section 27).

## 1. Project Overview

The website of **Luzena Restaurant & Cafe** at **`luzenarestaurant.com`** (confirmed by the
client; the earlier spelling `luznarestaurant.com` is wrong and a test fails if it returns),
a private owner dashboard for managing the menu, and a backend that keeps both in step with
Clover. Ordering and payment stay in Clover.

Confirmed by the client on 2026-10-05: 315 El Cajon Blvd, El Cajon, CA 92020; phone
+1 619-499-5779; email and recruitment email `fadi.auchi@gmail.com`; open Sunday to
Thursday 8 AM to 12 AM, Friday and Saturday 8 AM to 2 AM; breakfast every day 8 AM to
12 PM; Google Maps link `https://maps.app.goo.gl/WTwNqRWv3dyaetAQ8`. **Photos are postponed
on purpose and are not a blocker.** The client's earlier instruction was "do not deploy
yet"; on 2026-10-05 the client gave the go-ahead to deploy (section 25 has the order and the
rules that came with it).

The folder and package are still named `luzna-web`, from before the spelling was confirmed.

- Project root: `C:\Users\yousef amr\Desktop\resturant\luzna-web`. Its own git repository,
  branch `main`, pushed to `https://github.com/gooamr88-pixel/luzena` (public) on
  2026-10-06. `main` was restarted as one commit before that first push (section 30); the
  earlier commits are on the local branch `local-history`, which is never pushed.
- Sibling `..\grilli-next` is an earlier Next.js port of the open-source Grilli template.
  It is not part of this project and was not modified. The brief forbids React/Next.js.

## 2. Product Scope

In scope and built:

- Public pages: Home, Menu, About, Locations, Gallery, Contact, Join Our Team, Order Online,
  Privacy, 404.
- Owner dashboard: Overview, Items (list + editor), Categories, Modifiers, Clover connection, Activity.
- Backend: public menu, job application with CV upload and email, Clover webhook, dashboard API.
- Clover: OAuth v2, token refresh, full sync, write-through edits, conflict detection.

Out of scope by decision: cart, checkout, payment, POS, delivery, order management;
draft/publish; permanent deletion; bulk price changes; editing restaurant info, locations,
gallery or job positions from the dashboard; tax; stock quantities; user management screens.

## 3. Current Phase

All build phases (0 to 16) are implemented. The production-readiness round of 2026-10-05
did everything that can be done on one machine without outside accounts: real content,
domain, application gating and retention, ordering-link configuration, lint, Deno
execution, real-browser tests with accessibility scans, performance measurement, a security
review, `BLOCKERS.md` and `DEPLOYMENT_CHECKLIST.md`. What remains needs accounts or
decisions that do not exist yet (section 28).

**Status words used in this project:** LOCAL (works on this machine), IMPLEMENTED (code and
tests exist), PRODUCTION READY (proven on deployed infrastructure). Nothing is PRODUCTION
READY: only a test database exists (section 25) and Clover has never been called.

## 4. Current Task

None in progress. See section 27.

## 5. Completed Phases

| Phase | Status |
|---|---|
| 0 Requirements discovery | Done. Finding: client assets are not on this machine. |
| 1 Clover technical discovery (read and write) | Done from documentation only |
| 2 System architecture | Done; revised for the dashboard (Model C hybrid) |
| 3 Database and data contracts | Done; 5 migrations, tested on PGlite and applied to the TEST/STAGING Supabase project |
| 4 UI/UX design system | Done; colours and sans-serif from the client's logo |
| 5 Frontend foundation | Done |
| 6 Website pages | Done with the real content; a Privacy page added |
| 7 Backend infrastructure | Done; type-checked and started under Deno, never against a real Supabase project |
| 8 Clover OAuth | Done in code; never run against Clover |
| 9 Clover menu integration | Done in code; never run against Clover |
| 10 Clover ordering | Done (link-out, one setting); needs the client's ordering URL |
| 11 Join Our Team | Done; online applications switched off until policy and retention exist |
| 12 Email and CV processing | Done in code; never sent a real email |
| 13 Security hardening | Done; reviewed 2026-10-05, see SECURITY.md |
| 14 Testing | Unit, SQL, API, real-browser, Deno; counts in section 24 |
| 15 Performance | Measured in the lab; numbers in TESTING.md. No field data (not deployed). |
| 16 SEO and accessibility | Built in; axe WCAG 2.2 AA scan on every page and screen. No screen-reader pass by a person. |
| Owner dashboard (plan modification 2026-10-05) | Done; exercised in a real browser in demo mode |
| Production-readiness round (2026-10-05) | Done as far as one machine allows |

## 6. Pending Phases

All blocked on things outside this repository. Numbering is `BLOCKERS.md`'s.

| What | Blocked by |
|---|---|
| Deploying the information site | B-5 Supabase (CLI sign-in, owner email), B-6 the Hostinger VPS set-up, a GitHub repository and DNS |
| Live menu and dashboard | B-1 Clover sandbox run of `CLOVER_SANDBOX_TEST_PLAN.md`, then Clover's production approval |
| ORDER ONLINE going to Clover | B-2 the restaurant's ordering link |
| Online job applications | B-3 privacy policy, B-4 retention period, B-7 Resend domain |

## 7. Architecture Decisions

- AD-1 Static multi-page site built by Vite. Restaurant content is compiled in from
  `content/site.json` with Handlebars; it is in the HTML, not rendered by JavaScript.
- AD-2 **Source of truth is Model C (hybrid).** Clover owns name, price, availability,
  `hidden`, categories, modifiers. This system owns description, photo, featured, dietary
  labels, website visibility, archive, item order within a category. Reason: Clover's item
  schema has no description or image field, and staff also edit in Clover. Full reasoning in
  ARCHITECTURE.md section 2.
- AD-3 Dashboard writes to Clover-owned fields are write-through: Clover first, mirror only
  from Clover's answer. No optimistic UI.
- AD-4 No draft/publish: Clover writes are live at once. Preview is client-side.
- AD-5 No hard delete anywhere. Archive is website-only and reversible.
- AD-6 All Clover calls happen in Edge Functions. The browser never holds a Clover credential.
- AD-7 All database access goes through SQL functions executable only by the service role.
  RLS is on for every table with no policies.
- AD-8 Multi-tenant backend (`restaurant_id` everywhere, tenant from the user's membership).
  The static site is one restaurant per deployment.
- AD-9 Backend logic lives in `supabase/functions/_shared` as handlers with injected
  dependencies and Web-standard APIs only, so it runs under Node for tests. Only
  `runtime.ts` and the `index.ts` files need Deno.
- AD-10 Restaurant info, locations, gallery and job positions stay in `content/site.json`.
  No tables for them, because no screen edits them.

## 8. Technical Decisions

- Vanilla HTML/CSS/JS, Tailwind CSS v4 (`@tailwindcss/vite`), Vite 8. No framework.
- Handlebars and sharp at build time only.
- Fonts self-hosted through `@fontsource` (Playfair Display variable, Open Sauce One).
- `@supabase/supabase-js` in the dashboard only, for Supabase Auth.
- Tests: Vitest; SQL on PGlite (Postgres in WebAssembly); a fake Clover built from the docs;
  `playwright-core` driving an already-installed Chromium, with axe-core, against the built
  site served with the headers from `deploy/headers.json`.
- Hosting: Nginx on the client's Hostinger VPS (section 25). `deploy/headers.json` is the
  one list of response headers; `npm run build:nginx` generates the Nginx site file from it
  and a unit test fails if the committed file is stale or a `location` lacks a header.
  `deploy/deploy.sh` runs on the VPS. `vercel.json` and `.vercelignore` were removed.
- The test site is local: `npm run build:staging` (Vite mode `staging`, reads
  `.env.staging.local`) and `npm run preview:staging` on `http://localhost:4173`. The mode
  is not called `test` because Vitest runs in mode `test` and would read the same file.
- Deno comes from the `deno` npm package, so `npm run check:deno` needs no separate install.
- ESLint (flat config) with rules that forbid `innerHTML`, `eval` and `localStorage`.
- Email: Resend HTTP API, behind an `EmailSender` interface. Chosen by the engineer, not the client.
- A content gate: `npm run build` fails while required content is missing, when the
  ordering link is a placeholder, or when the application form is on without a privacy policy.
- A demo mode for the dashboard (`VITE_DASHBOARD_DEMO=1`), allowed only in sample builds.
- The ordering link is ONE value, `CLOVER_ORDERING_URL` at build time,
  overriding `ordering.url` in `content/site.json`.
- Job applications need two switches (`careers.applications.enabled` in the site content,
  `JOB_APPLICATIONS_ENABLED` in the backend) and `JOB_APPLICATION_RETENTION_DAYS`, which has
  **no default**: choosing one would be making the client's legal decision for them.

## 9. Clover Decisions

- CD-1 OAuth v2 high-trust authorization code flow. PKCE not used (it is for apps that
  cannot keep a secret).
- CD-2 Refresh tokens are single use, so refresh is serialised with a database lock.
- CD-3 `state` is sent, but is not documented for v2. Protection also relies on a single-use
  nonce bound to user and restaurant. `CLOVER_REQUIRE_STATE=true` by default.
- CD-4 The redirect URI is the dashboard page; it posts the code to the backend with the
  owner's session.
- CD-5 Sync is a full inventory read applied in one SQL transaction. Triggers: connect,
  manual, webhook, stale-on-read. No queue, no cron.
- CD-6 Webhooks are only a signal to re-sync. Their payload is never applied.
- CD-7 Conflicts: field-level comparison against Clover before writing; 409 with both values.
- CD-8 Creates use our own idempotency keys plus reconcile-by-name after an unknown outcome.
- CD-9 Creates are retried only on 429. Updates and reads retry on 429, 5xx, timeouts.
- CD-10 `DELETE` endpoints are never called.
- CD-11 Ordering is a link to the merchant's Clover Online Ordering page.

## 10. Verified Clover Capabilities

See `CLOVER_CAPABILITY_MATRIX.md`. "Verified" there means confirmed in official
documentation on 2026-10-04/05. **Zero capabilities are sandbox-tested or production-tested.**

## 11. Unverified Assumptions

- UA-1 RESOLVED 2026-10-05: the name is "Luzena Restaurant & Cafe" (client message + logo).
- UA-2 RESOLVED 2026-10-05: colours and the sans-serif now come from the client's logo file.
  Still assumed: Playfair Display as the heading font (the logo's own wordmark font, Hello
  Paris Serif, is commercial and not licensed for the site).
- UA-3 Currency USD, locale en-US.
- UA-12 RESOLVED 2026-10-05: the domain is `luzenarestaurant.com`.
- UA-13 Whether the restaurant is already open. It now has a public address and opening
  hours, which suggests it is; the careers text still says "we are building our opening
  team". Asked of the client in `BLOCKERS.md` N-5. Nothing on the site promises a date.
- UA-16 Map coordinates. The Maps short link confirms a listing but carries no coordinates;
  `geo` is left empty and was not guessed.
- UA-14 The cuisine line. The Instagram bio was read through an automated page summary,
  which returned: "Welcome to Luzna Cafe, where Mediterranean flavors meet Western comfort
  food. We serve fresh, made-to-order dishes". The hero, description and About text are
  built on that sentence and nothing else.
- UA-4 Clover's token endpoints accept a JSON body.
- UA-5 Clover list responses are `{ "elements": [...] }`.
- UA-6 Whether Clover echoes `state` back.
- UA-7 The merchant's Clover region.
- UA-8 The body key for `item_modifier_groups` is `modifierGroup`.
- UA-9 `filter=name=<value>` is an exact match.
- UA-10 What `hidden: true` does at the Clover register.
- UA-11 Hero copy, the About page, page intros and button labels were written by the
  engineer and have not been approved by the client. They state only what UA-14 supports,
  plus what "Restaurant & Cafe" implies (meals and coffee).
- UA-15 The 18 job descriptions are standard descriptions of each role. They are not
  specific to this restaurant, and no position has a contract type or pay.

## 12. Database Decisions

16 tables (list in ARCHITECTURE.md section 6). Menu tables use `(restaurant_id, clover_id)`
as the primary key. In `menu_items` and `menu_categories`, unprefixed columns belong to
Clover and `web_*` + `archived_at` belong to this system. Rows are never deleted by sync:
missing objects are marked `removed_from_clover_at`.

## 13. Security Decisions

See SECURITY.md. Headlines: tokens AES-256-GCM encrypted at rest; deny-by-default database;
tenant resolved server-side; strict request schemas rejecting unknown keys; file types
sniffed from bytes; CSP without inline script or style; no `innerHTML`.

## 14. UI/UX Decisions

- Public site: LIGHT, built on the logo: cream page (`#F6F4F0`), terracotta red (`#BC4749`)
  for buttons and prices, olive (`#606C38`) for labels. Playfair Display headings, Open
  Sauce One text. Square corners, one gradient (hero scrim). The first version was dark with
  a gold accent; it was replaced on 2026-10-05 because the logo is drawn for a light ground.
- The hero has two forms: photo with white text, or text-only on `sand` when there is no
  photo. Production uses the text-only form until real photos arrive.
- Do not set normal-size text in `brand` on a `sand` surface (4.27:1). See DESIGN_SYSTEM.md.
- Never fade text with `opacity` to show a state: it lowers contrast invisibly. An
  out-of-stock menu item uses the `muted` colour (`.menu-item-unavailable`).
- Hours are shown day by day, then a line per service (breakfast).
- Careers: 18 roles in 5 departments, each a native `<details>` disclosure.
- The sample profile is the real content with sample values laid over only what is missing.
- Dashboard: light, dense, separate stylesheet. Every field is tagged "Clover" or "Website".
- Switches and save buttons never show a state the server has not confirmed.
- Phones: item table becomes cards; editor save bar is fixed to the bottom.
- ORDER ONLINE links straight to Clover when configured; otherwise to `/order/`.

## 15. Design System

`docs/DESIGN_SYSTEM.md`, `src/styles/main.css`, `src/styles/dashboard.css`.

## 16. Folder Structure

ARCHITECTURE.md section 7.

## 17. Environment Variables

Reference: `docs/CONFIGURATION.md` (every setting, per environment). Templates:
`.env.example` (build) and `supabase/functions/.env.example` (backend). Since 2026-10-05 two
git-ignored secrets files exist, `supabase/functions/.env.test` and
`supabase/functions/.env.production`, holding only generated keys and non-secret settings
(section 25). No Clover, Resend, database or Supabase credential is in any file.

## 18. API Contracts

ARCHITECTURE.md section 5.

## 19. Data Models

`supabase/migrations/20261005000100_schema.sql` and `..._200_functions.sql`. Clover-side
shapes: `supabase/functions/_shared/clover/normalize.ts`.

## 20. Known Issues

- KI-1 Edge Functions are type-checked by Deno and each is started under Deno and sent
  requests (`npm run check:deno`), but with the database unreachable. `runtime.ts`, the
  Supabase client wiring, has never talked to a real project.
- KI-2 RESOLVED 2026-10-05: the storage migration applied cleanly to the real project; both
  buckets exist with the right visibility and no storage policies. No file stored yet.
- KI-3 Vitest prints "Timeout terminating forks worker" for database test files. Tests pass;
  PGlite is slow to shut down.
- KI-4 The item-order-within-category API exists but no dashboard screen uses it.
- KI-5 A reset link signs the owner in before the new password is set; the dashboard guards
  this in the client (`recovering` flag in `main.js`). An invite link has no such guard, so
  owners should be onboarded with "Forgot your password?", as DEPLOYMENT.md says.
- KI-6 This machine is slow under load. A cold headless Chromium has taken 69 seconds to
  load one local page and 10 seconds to answer a click. The browser tests therefore use
  long timeouts (`tests/browser/helpers/site.js`); a timeout in them is first a suspect for
  machine load, not for a broken feature. The whole browser suite takes tens of minutes here.
- KI-7 Retention clean-up has no scheduler: it runs when an application arrives and when an
  owner opens the dashboard (`BLOCKERS.md` N-9).

## 21. Bugs

None open. Found by the real-browser tests on 2026-10-05 and fixed:

- Pressing a category chip on the Menu page could stop at the wrong category: the script
  that keeps the current chip in view called `scrollIntoView`, which also scrolls the page
  and cancelled the smooth scroll the press had started. It now scrolls only the chip row.
- An out-of-stock menu item was drawn at 60% opacity, which put its name, price and
  "Unavailable today" tag below AA contrast. Now a colour, not opacity.
- The "new item" form focused its Name field and then lost focus to the page container.
- The item list redrew its whole toolbar when the category list arrived, discarding a
  search the owner had started typing. Only the category menu is filled in now.
- The gallery viewer returned focus to the photo that opened it, not the one on screen.
- Demo mode sorted an item without a price first when sorting by price, high to low; the
  real query puts it last. Demo now matches.
- The public menu endpoint had no rate limit (found in the security review).
- Found on the real Supabase project, missed by the tests: two id sequences were left open
  to `anon` and `authenticated` by Supabase's default privileges. Closed by migration
  `..500_sequence_privileges.sql`. Root cause of the miss: the test database did not start
  with Supabase's default grants. `tests/helpers/db.js` now sets them, so the tests run
  against a database that is open until the migrations close it.

Fixed earlier, after being seen in screenshots:

- Conditional values passed to `Element.append()` printed "false"/"null" in the dashboard.
  All dashboard appends now go through a helper that drops empty values.
- The hero grew without limit on very tall screens. Now capped at 54rem.
- Hero buttons were cramped side by side at phone width. Now stacked below 640 px.
- An item without a price drew a leader line to nothing.

## 22. Technical Debt

- TD-1 RESOLVED 2026-10-05: retention is configurable and applications past it are deleted
  (files, then rows). Still no scheduler: see KI-7.
- TD-2 No Clover token recovery endpoint; a lost refresh response forces a reconnect.
- TD-3 No re-encryption tool for rotating `TOKEN_ENCRYPTION_KEY`.
- TD-4 CSP allows `https://*.supabase.co`; narrow to the project host after it exists.
- TD-5 RESOLVED 2026-10-05: `npm run test:browser`. The dashboard is driven in demo mode,
  so its browser tests prove the interface; what the real API does is proven separately in
  `tests/dashboard.test.js`. Nothing yet drives the dashboard against a real backend.
- TD-6 `rate_limits`, `idempotency_keys`, `oauth_states`, `integration_logs` grow slowly and
  have only opportunistic cleanup.
- TD-7 No JobPosting structured data (needs real position descriptions first).
- TD-8 The menu is rendered client-side. Search engines that run JavaScript see it; a
  build-time snapshot would serve those that do not.

## 23. Tests

TESTING.md. Five files under `tests/` (`npm test`), three under `tests/browser/`
(`npm run test:browser`), one under `tests/sandbox/` (`npm run test:clover-sandbox`, skipped
without credentials), plus `scripts/deno-smoke.mjs` (`npm run check:deno`).

Checks of real things, outside `npm run verify`: `verify:database` (a real database, from
inside), `verify:public-access` (a real project, with the public key), `verify:functions`
(the deployed functions, optionally with a real sign-in), `verify:site` (a deployed site).

## 24. Test Results

Last full run 2026-10-05:

- `npm run lint`: clean. `npm run typecheck`: clean.
- `npm run check:content`: 0 required items missing, 9 optional.
- `npm test`: **186 passed, 0 failed**, 5 files
  (sql 33, dashboard 51, public 28, units 31, frontend 43: four new tests of the generated
  Nginx configuration). Re-run after the hosting change, with lint and typecheck: clean.
  A fifth Nginx test (the old domain's redirect file) was added on 2026-10-06; only
  `tests/frontend.test.js` was re-run for it: 44 of 44.
- Real database, TEST/STAGING project: 5 migrations applied; `npm run verify:database`
  **30 of 30**, by query and by acting as `anon`, `authenticated` and `service_role`.
- Real database, PRODUCTION project: 5 migrations applied; `npm run verify:database`
  **30 of 30**; `npm run verify:public-access` 14 of 15 (data, functions and storage all
  refused; sign-ups still on).
- `npm run check:deno`: four functions type-check under Deno; 17 of 17 smoke checks pass.
- `npm run test:browser`: **194 passed, 0 failed**, 3 files (public 132, dashboard 43,
  sample 19). Re-run after the hosting change (headers now from `deploy/headers.json`,
  pages sent `no-cache`): same result. Includes the WCAG 2.2 AA scan of every public page and dashboard screen, and
  seven widths from 360 to 1440 px.
- `npm run test:clover-sandbox`: **never run** (no sandbox credentials).
- `npm run build` (production): succeeds. Its only image files are `favicon.svg`,
  `media/logo.svg` and `media/og-default.png`. It stops if required content is removed, if
  the ordering link is a placeholder, if applications are on without a privacy policy, or
  if `VITE_DASHBOARD_DEMO=1` is set.
- Performance, lab, slow-phone conditions, production build: LCP 1.4 to 2.1 s on every
  public page, CLS 0.037 or less, 157 to 161 kB per page of which fonts are 131 kB. Tables
  and method in TESTING.md.

What has still only been seen in screenshots or not at all: the look of pages in Safari
and Firefox, and anything on a real phone. The interface behaviour (clicking, typing,
dialogs, keyboard, focus) is now exercised by the browser tests, not just captured.

## 25. Deployment Status

**Two Supabase projects exist, each with only its database set up. No functions, no
website, no Clover anywhere.**

The client's decision, in their words (2026-10-05): "Use the current Ireland Supabase
project as TEST/STAGING only. Do not treat it as production. I will create a new Supabase
project in a US region for Luzena Production. Keep the existing test project untouched and
use it for all Clover Sandbox and integration testing. Once I provide the new production
project, run the existing migrations against it and repeat the full RLS/security
verification before deploying anything."

**TEST / STAGING project**

- Ref `cgxhifkeoesvsycewwfs`, region eu-west-1 (Ireland). (It was first labelled production
  for a few hours on 2026-10-05; the client then re-designated it. Nothing production was
  ever put in it.)
- Five migrations applied with `supabase db push --db-url ...` through the session pooler
  (`aws-0-eu-west-1.pooler.supabase.com:5432`, user `postgres.<ref>`), recorded in the
  migration ledger. `npm run verify:database`: 30 of 30.
- Otherwise empty: no restaurant row, no Auth user, no functions, no secrets.
- **Leave it as it is** until the client asks for the Clover sandbox or integration work.
  All such work happens here and only here.
- Its database password is **not written in any file**. The client is to reset it before
  launch (`BLOCKERS.md` B-5); after that, `db push` needs the new one.

**PRODUCTION project**

- Ref `xqzpuqjrlrxyitjubkqk`, region **us-west-1** (N. California), supplied by the client
  on 2026-10-05 with its URL, database password and publishable key
  (`sb_publishable_...`: the new-style public key; it is public by design and goes in
  `VITE_SUPABASE_ANON_KEY`).
- Confirmed empty first (read-only). Then the five existing migrations were applied with
  `supabase db push --db-url ...` through `aws-0-us-west-1.pooler.supabase.com:5432`, user
  `postgres.<ref>`. (The direct host `db.<ref>.supabase.co` does not resolve from this
  machine: it is IPv6 only.)
- `npm run verify:database`: **30 of 30**. `npm run verify:public-access`: every attempt to
  read, write, call a function or use storage with the public key is refused (14 of 14);
  the 15th check fails: **sign-ups are on** (Supabase's default). The client has to switch
  it off in the dashboard, or sign the CLI in so it can be set. Checked afterwards: the
  attempts left nothing behind (0 restaurants, 0 users, 0 applications).
- **Nothing else is deployed to it**: no functions, no secrets, no Auth settings, no owner.
  Do not deploy functions without the client saying so.
- To verify with new-style keys at function-deploy time (unproven): that
  `SUPABASE_SERVICE_ROLE_KEY` is still injected into Edge Functions on a project that uses
  publishable/secret keys. `runtime.ts` depends on it. `verify_jwt` is already `false` for
  all four functions, so the gateway will not reject the non-JWT publishable key.
- The client pasted `supabase login`, `supabase init`, `supabase link --project-ref ...`
  (Supabase's onboarding text). None was run: `login` opens a browser on the client's
  account; `init` would offer to overwrite the existing `supabase/` configuration; `link`
  would make production the silent default target in a folder that serves two projects.

The Supabase CLI on this machine is not signed in (`supabase projects list` answers
Unauthorized). A database password cannot deploy functions or set secrets.

No Clover app or email account exists. There is no Docker, no `gh` and no Linux (WSL) on
this machine. The Vercel CLI happens to be installed; **it must not be used** (see the
correction below).

**The go-ahead (client, 2026-10-05).** "You have my go-ahead to begin the deployment
process." The order given: first commit; `npm run verify`; the four functions to TEST;
TEST secrets; TEST Auth; the owner account, from an email the client will supply; real
integration, security, API and function tests against TEST; fix what the first real
deployment finds without weakening security or changing the architecture; only then
PRODUCTION functions and configuration; the website (first said to be on Vercel, corrected
the same day: see below); `luzenarestaurant.com`; post-deployment checks. The goal is the information site live first, with the menu, Clover
ordering and online applications off until their dependencies exist. Rules restated with it:
TEST is Ireland and PRODUCTION is N. California; never mix their credentials; no Clover in
production before the sandbox plan passes; no secret in code, Git, logs or chat; no
`supabase init`; no `supabase link`; name the project on every command; invent nothing.

**Done since the go-ahead, without outside accounts:**

- First commit, after checking that no `.env` file and no credential was in it.
- One secrets file per environment, git-ignored, each with its own freshly generated
  `TOKEN_ENCRYPTION_KEY` and `IP_HASH_SALT`: `supabase/functions/.env.test` (allowed
  origins are local previews for now; `CLOVER_ENV=sandbox`, no Clover app yet) and
  `supabase/functions/.env.production` (the two real origins; **no `CLOVER_*` value and no
  job-application value at all**). Neither has been sent to Supabase. Their values have
  never been printed.
- `npm run verify:functions` (`scripts/verify-functions.mjs`): the outside view of the
  deployed functions, including a real sign-in when an owner's credentials are given. Run
  once against TEST to prove the script: every check answers "function not found", which
  confirms nothing is deployed there.
- `npm run verify:site` (`scripts/verify-site.mjs`): the post-deployment check of a site
  address: HTTPS and redirects, every header in `deploy/headers.json` as actually sent,
  robots, sitemap, every public page, that no dot-file or repository file can be fetched,
  the dashboard, and that the pages and the dashboard code name the expected Supabase
  project and no other. Run against a local production build served with the production
  headers: everything passes except the three checks that need the deployed functions.
  Run against a sample build: 16 failures, as it should.

**The correction (client, 2026-10-05, after the go-ahead): "Vercel is NOT part of this
deployment."** The website is hosted on the client's existing Hostinger VPS. Do not run
`vercel login`, create a Vercel project, deploy to Vercel or configure the domain there.
The architecture in the client's words: GitHub -> Hostinger VPS -> Luzena Website/Backend
-> Supabase Production (N. California) -> Clover Production. Asked what that means in
detail, the client chose:

- **The backend stays on Supabase** (the four Edge Functions, as on TEST). The VPS serves
  the built website files only. No architecture change.
- **Nginx** serves websites on the VPS.
- **A deploy script on the VPS** pulls from GitHub, builds and switches the live folder.
- **No SSH from this machine.** Every file and an exact command list are prepared here; the
  client runs them on the VPS and sends back the output.

Done for it: `vercel.json` and `.vercelignore` removed; `deploy/headers.json`,
`scripts/build-nginx-config.mjs` and the generated `deploy/nginx/luzenarestaurant.com.conf`;
`deploy/deploy.sh` (release folders, atomic switch, `--rollback`, refuses the wrong Supabase
project, a secret key or sample content); `deploy/site.env.example`; `.gitattributes`
(Unix line endings for what runs on the server); the test server in the browser tests reads
the new header list; pages are now sent `Cache-Control: no-cache`, which Vercel did by
default and Nginx does not; every document that named Vercel rewritten.

**Not proven, and it must not be described as proven:** nothing in `deploy/` has run on
Linux or on the real server. `deploy.sh` is syntax-checked and its refusals were exercised
with Git Bash on Windows; its build, switch and rollback were not. The Nginx file has never
been loaded by an Nginx. The VPS has not been seen at all: operating system, Nginx and Node
versions, what else it hosts. `DEPLOYMENT_CHECKLIST.md` section 5.1 is the read-only look
the client is asked to run first.

**Everything else waits on things only the client can do** (none can be done from
here: each is a sign-in on the client's own account, or a fact only the client knows):

1. `supabase login` in a terminal on this machine. After it, with no database password
   needed: functions deploy with `--project-ref <ref> --use-api`; `supabase secrets set
   --env-file ... --project-ref <ref>`; SQL runs with `supabase db query --project-ref
   <ref> -f <file>` (for `provision-restaurant.sql`); `supabase db advisors --project-ref
   <ref> --type security` is an extra check. For Auth settings, try `supabase config push
   --project-ref <ref>` WITHOUT `--yes` first and read the diff it prints: `config.toml`
   has no site URL, and pushing CLI defaults over a hosted project would be wrong.
2. The owner's sign-in email. Not assumed to be the recruitment address.
3. DONE 2026-10-06: the GitHub repository, `gooamr88-pixel/luzena`, public.
4. On the VPS: the read-only commands of checklist section 5.1 and their output; later the
   set-up itself (sections 5 to 7) and the DNS of `luzenarestaurant.com`.

## 26. Production Readiness

**Not production ready**, and not claimed to be. The code is IMPLEMENTED and verified
LOCALLY. `BLOCKERS.md` lists what is between here and live, by who has to act.

The site can go live in stages: the information site first (needs only infrastructure),
then the menu and dashboard (after the Clover sandbox plan), then ordering (the link), then
applications (policy, retention, email).

## 27. Next Immediate Task

1. DONE 2026-10-05: first commit. The client has approved deployment (section 25).
2. **Waiting on the client:** `supabase login`, the owner's sign-in email, the GitHub
   repository address, and the output of the read-only VPS commands (checklist 5.1).
   Also still open from before: switch off sign-ups on both projects (or it is done with
   the Auth step once the CLI is signed in), and reset both database passwords.
   **State on 2026-10-06:** the Supabase CLI is signed in, but with an account that sees
   only PRODUCTION (`xqzpuqjrlrxyitjubkqk`). On TEST (`cgxhifkeoesvsycewwfs`) it answers
   403 "does not have the necessary privileges": the two projects are under different
   accounts or organisations. **So nothing was deployed: TEST cannot be reached, and
   PRODUCTION must not go first.** Needed: the TEST project's owner invites the signed-in
   account to its organisation, or a token for the account that owns TEST.
   The remote `origin` is `https://github.com/gooamr88-pixel/luzena.git`. That repository
   is **PUBLIC, by the client's decision** (2026-10-06), made after being told what it
   contains, including the stock photos whose licence for publication was never checked
   (`content/sample-media/NOTICE.md`). See section 30 for what that means for these files.
   **Later on 2026-10-06:** that token stopped working (401 on every call), so the CLI is
   signed out again. The client supplied the owner's sign-in email, `fadi.auchi@gmail.com`
   (now in `provision-restaurant.sql`), and the first read-only look at the VPS: Ubuntu
   24.04.4, Nginx 1.24.0, Node 20.20.2, npm 11.18.0, git 2.43.0, certbot 2.9.0, address
   `187.77.1.72`. It hosts other, unrelated sites, which must not be disturbed. It also
   serves `luznarestaurant.com`, the OLD spelling: a live "Grilli - Coming Soon" Next.js
   page (the earlier build), whose DNS already points at the VPS. `luzenarestaurant.com`
   itself still shows Hostinger's parking page (`2.57.91.91`). Open: the second read-only
   look (existing site files, checklist 5.1). Nothing on the VPS was changed.
   **Decided by the client (2026-10-06): after launch, the old-spelling address redirects
   to `https://luzenarestaurant.com`.** Prepared, not installed:
   `deploy/nginx/luznarestaurant.com.redirect.conf` (generated; reuses that domain's
   existing certificate, which covers `www` too) and checklist section 7.1.
   The second read-only look was done the same day: no site on the server claims the new
   domain or clashes with its file; a default server refuses unclaimed names; certbot has
   its Nginx plugin; the old build is in `/var/www/luzna`, a different folder from ours.
   **The VPS side is now ready to be set up, but only after TEST has passed and PRODUCTION
   Supabase is deployed.**
   **TEST backend deployed, 2026-10-06** (the client signed the CLI in with an account
   that reaches both projects). On `cgxhifkeoesvsycewwfs` only:
   - The four functions deployed with `--project-ref ... --use-api`; `verify_jwt` is false
     on each, as `config.toml` says. Secrets set from `.env.test`.
     `SUPABASE_SERVICE_ROLE_KEY` IS injected on a project with the new-style keys: the
     open question in section 25 is answered.
   - **KI-1 is resolved: the functions worked against a real project on first contact.**
     No change to `runtime.ts` was needed.
   - The owner `fadi.auchi@gmail.com` created (no password, no email sent) and
     `provision-restaurant.sql` run with `supabase db query --linked --project-ref <ref>
     -f ...` (`--project-ref` alone is refused by that command; no link file is created).
   - `npm run verify:functions`: 15 of 15, plus no response showing internals.
     `npm run verify:public-access`: 15 of 15. `supabase db advisors --type security`:
     no error; 16 notes that tables have RLS and no policy (the design); one warning class
     about 44 functions without a fixed `search_path` (`BLOCKERS.md` N-11); two Auth
     warnings (leaked-password check off, few MFA options).
   - **A mistake, and what it found.** `supabase config push --project-ref <test>` was run
     without `--yes`, meaning to read the difference only. Its prompt defaults to yes, also
     with nothing answering, so it APPLIED `config.toml`'s Auth section to TEST. That file
     had `[auth.email] enable_signup = false`, which is not "no email sign-ups" but "email
     provider off": afterwards TEST answered every sign-in with "Email logins are
     disabled". Had this reached production the owner could not have signed in. TEST had
     no users with a password, so nothing was lost. `config.toml` is now corrected and
     written out in full, with each project's site address under `[remotes.*]`.
     **Never run `config push` as a preview, and never on PRODUCTION except by the client,
     in their own terminal, reading the difference.**
   - **Still open on TEST:** applying the corrected Auth settings. An automatic apply
     (`--yes`) was refused by the session's safety check, rightly; the client runs
     `supabase config push --project-ref cgxhifkeoesvsycewwfs` and reads the difference, or
     sets the same in the dashboard. Then: confirm a wrong-password sign-in answers
     "Invalid login credentials"; the signed-in half of `verify:functions` with a
     throwaway owner; the test site (`build:staging`) in a browser.
   - PRODUCTION was not touched.
2a. (Superseded by the note above; kept for the order.) As soon as the CLI can reach TEST, TEST project (`cgxhifkeoesvsycewwfs`) first, in
   this order: deploy the four functions; set secrets from `.env.test`; Auth settings; a
   test owner; `provision-restaurant.sql`; `npm run verify:functions` with the signed-in
   checks; `npm run verify:public-access`. Expect small fixes in `runtime.ts` on first
   contact (KI-1). This is where those fixes should be found, not in production.
2b. Only when TEST passes: the same on PRODUCTION (`xqzpuqjrlrxyitjubkqk`) with
   `.env.production`, then the website on the Hostinger VPS (the client runs checklist
   sections 5 to 7), the domain, and `npm run verify:site` from here.
3. Create a Clover sandbox app; run `CLOVER_SANDBOX_TEST_PLAN.md`; record results and dates
   in the capability matrix.
4. Ask the client for: the Clover Online Ordering link, a privacy policy, a retention
   period, approval of the text, whether the restaurant is open yet.

## 28. Blockers

The maintained list is `BLOCKERS.md` (B-1 to B-7 blocking, N-1 to N-10 not). Nothing in it
was invented or worked around with a fake value. In one line each:

- B-1 Clover sandbox testing (Clover account, app, test merchant; then production approval).
- B-2 The restaurant's Clover Online Ordering link.
- B-3 Privacy policy (blocks online applications only).
- B-4 Retention period for applications (blocks online applications only).
- B-5 Supabase project(s).
- B-6 The website on the Hostinger VPS: a GitHub repository, the one-time server set-up,
  DNS for `luzenarestaurant.com`.
- B-7 Resend account with the domain verified (blocks online applications only).

Not blockers: photos (postponed by the client), text approval, map coordinates, contract
type per role.

## 29. Client Requirements

From the master brief and the 2026-10-05 plan modification: the eight public pages; Clover
as the source of the menu; no in-house ordering; job applications by email with CV upload;
stack of vanilla HTML/CSS/JS + Tailwind + Vite, Supabase Edge Functions and Postgres,
hosting on Vercel (changed by the client on 2026-10-05 to their Hostinger VPS); a private, authenticated, multi-tenant owner dashboard with menu, item, category
and modifier management, Clover connection page, sync with clear states, conflict handling,
audit log, role-based access designed for future roles.

## 30. Things That Must Not Change

- No Clover secret, token or service-role key in frontend code or any `VITE_*` variable.
- Clover stays the owner of names, prices, availability, categories and modifiers. Sync
  must never write a `web_*` column or `archived_at`.
- The dashboard never shows "saved" for a Clover field unless Clover accepted the write.
- No Clover `DELETE` call.
- No cart, checkout or payment on this site.
- The production build must fail when required content is missing, and must refuse the
  demo flag. Sample values must never reach a production build: they live only in
  `site.sample.json` and are applied only by the sample profile.
- Colours come from the logo. Change the tokens in `main.css`, never hard-code a colour in
  a template. The `.menu-item` and `.tag` rules in `dashboard.css` must match `main.css`.
- Deploy only in the order the client gave (section 25): TEST before PRODUCTION, and no
  Clover in production before the sandbox plan passes. Do not publish the stock photos in
  `content/sample-media/`: only sample builds read them, a browser test fails if any photo
  appears in the production build, and on the server Nginx's root is the built release,
  never the repository.
- Hosting is the client's Hostinger VPS. Never Vercel. The VPS holds no secret, runs no
  application code and proxies nothing; nobody connects to it from this machine.
- The Nginx file is generated from `deploy/headers.json`. Never edit it by hand, here or on
  the server.
- **The GitHub repository is public** (client's decision, 2026-10-06). Everything committed
  is readable by anyone, for ever. So beyond "no secrets": write nothing in any file that
  would help someone attack the system or the server. No statement about how strong or
  weak a credential is or where one was exposed, nothing about the VPS beyond what this
  site needs (not its other sites, not who logs in or how), no access tokens even expired.
  The history was restarted as one commit before the first push for this reason; the
  earlier local commits are on the local branch `local-history`, which is never pushed.
- The domain is `luzenarestaurant.com`. Never `luznarestaurant.com`.
- `JOB_APPLICATION_RETENTION_DAYS` has no default, and no privacy policy text is to be
  written here: both are the restaurant's legal decisions.
- The ordering link is never invented. Unset means every ORDER ONLINE button stays on-site.
- Do not write facts about the restaurant that the client has not supplied (see UA-14).
- Tables stay RLS-enabled with no policies for `anon` or `authenticated`; SQL functions stay
  executable by `service_role` only.
- Tenant and role are resolved on the server from the session, never from request data.
- No `innerHTML` with data; no inline styles (the CSP forbids both).
- In the capability matrix, "Sandbox tested" becomes "Yes" only with a date and a real run.

## 31. Change History

### 2026-10-04 Checkpoint: Phases 0 and 1

Discovery of the workspace and of Clover's read APIs. Files: `PROJECT_MEMORY.md`.
Outcome: client assets not found on disk; Clover item images and descriptions not available
through the Inventory API.

### 2026-10-05 Checkpoint: plan modification (owner dashboard)

Clover write APIs researched. Source-of-truth decision: Model C hybrid. Architecture revised
for multi-tenancy, Supabase Auth and write-through.

### 2026-10-05 Checkpoint: database

Files: `supabase/migrations/*`, `tests/sql.test.js`, `tests/helpers/db.js`.
Tests: 31 passed.

### 2026-10-05 Checkpoint: backend

Files: `supabase/functions/**`, `tests/dashboard.test.js`, `tests/public.test.js`,
`tests/units.test.js`, `tests/helpers/*`. Tests: 133 passed. Typecheck clean.

### 2026-10-05 Checkpoint: public website

Files: `build/*`, `content/*`, `src/partials/*`, `src/styles/main.css`, `src/js/**`, page
HTML files, `vite.config.js`. Sample build succeeds. Reviewed from screenshots; four layout
defects fixed.

### 2026-10-05 Checkpoint: owner dashboard

Files: `dashboard/index.html`, `src/dashboard/**`, `src/styles/dashboard.css`. Demo mode
added so the dashboard can be reviewed without a backend. Reviewed from screenshots; the
"false"/"null" rendering bug found and fixed.

### 2026-10-05 Checkpoint: logo, name, colours, About page, jobs

Client supplied the logo PDF, the name "Luzena Restaurant & Cafe", an Instagram account and
a Google share link, and asked for: colours to suit the logo, an About page, and every
restaurant and cafe job.

- Logo exported from the PDF to `content/media/logo.svg` (text as outlines, background
  removed, cropped). Leaf mark made into `public/favicon.svg`. Exact colours and font names
  read from the PDF.
- Public site re-themed from dark/gold to light cream/terracotta/olive. Fonts changed to
  Playfair Display and Open Sauce One. Old fonts uninstalled.
- `content/site.json`: name, full name, slug `luzena`, description, hero, About text with
  three values, Instagram, careers intro, 18 positions in 5 departments.
- About page rebuilt: story, "how we do things", call to action; logo panel when no photo.
- Careers page rebuilt: department jump links and a disclosure per role.
- Text-only hero and "coming soon" panel added, so the site can be published before the
  address, hours and photos exist. `locations` and `hero.image` changed from required to
  optional.
- Sample profile changed to an overlay on the real content.
- Dashboard: logo in the sidebar and sign-in card; menu preview re-coloured to match.
- A scripted edit damaged `careers/index.html` (every capital "I" replaced by a space, in
  two places). Found by reading the file, repaired by hand, and confirmed in the build.
- Tests: 152 passed. Typecheck clean. Production and demo builds succeed.
- Not done: nothing committed, nothing deployed; the About and hero text and the job
  descriptions await the client's approval.

### 2026-10-05 Checkpoint: documentation and final verification

Files: `README.md`, `ARCHITECTURE.md`, `CLOVER_INTEGRATION.md`,
`CLOVER_CAPABILITY_MATRIX.md`, `SECURITY.md`, `DEPLOYMENT.md`, `TESTING.md`,
`docs/DESIGN_SYSTEM.md`, `vercel.json`, `.env.example`, `tests/frontend.test.js`.
Tests: 148 passed. Status: stopped at the external blockers in section 28.

### 2026-10-05 Checkpoint: production readiness (no deployment)

The client supplied the domain, address, phone, email, hours, breakfast hours and Maps
link, postponed photos, and asked for everything locally solvable to be finished without
deploying.

- Content: real details in `content/site.json`; hours shown per day plus services;
  footer, Contact, Locations, structured data, sitemap and canonicals on
  `luzenarestaurant.com`. Sample profile reduced to an overlay of what is still missing.
- New: `/privacy/` page (fills from content, hidden from search while empty), a share
  image generated from the logo, `.vercelignore`, `docs/CONFIGURATION.md`.
- Job applications: two switches plus `JOB_APPLICATION_RETENTION_DAYS` (no default);
  migration `..400_application_retention.sql`; `_shared/public/retention.ts`.
- Ordering: `CLOVER_ORDERING_URL`; production build refuses placeholder or non-https links.
- Security review: public-menu rate limit added; `SECURITY.md` rewritten with a table of
  each control and the test that proves it.
- Tooling: ESLint; Deno through npm with `scripts/deno-smoke.mjs`; real-browser tests in
  `tests/browser/` with axe-core; `tests/sandbox/clover.sandbox.js`;
  `scripts/measure-performance.mjs`.
- Seven defects found by the browser tests and the review, all fixed (section 21).
- Documents: `BLOCKERS.md`, `DEPLOYMENT_CHECKLIST.md`, `CLOVER_SANDBOX_TEST_PLAN.md`
  created; every other document brought up to date.
- Results: section 24. Not done: nothing committed, nothing deployed, Clover never called.

### 2026-10-05 Checkpoint: production database

The client supplied a Supabase project (ref, database password, connection strings) and,
asked whether to apply the migrations and whether it was test or production, answered
"Apply, as PRODUCTION". The project was confirmed empty first (read-only).

- Applied the four migrations with `supabase db push --db-url`. The storage migration ran
  on a real project for the first time, cleanly.
- Verification found two sequences open to the public roles. Added and applied migration
  `..500_sequence_privileges.sql`; made the test database start with Supabase's default
  grants; two new SQL tests. `npm test`: 182 passed. Real database: 19 of 19 checks pass.
- Stopped there: functions, secrets and Auth need the CLI signed in, and were not approved.

### 2026-10-05 Checkpoint: the Ireland project becomes TEST/STAGING

The client re-designated the project: test/staging only, for all Clover sandbox and
integration testing. A new US-region project will be production (section 25 has the
instruction in full). No change was made to the project itself.

- The verification became a repeatable command, `npm run verify:database`
  (`scripts/verify-database.mjs`, dev dependency `pg`), so the identical check runs on the
  production project. It reads `DATABASE_URL` from the environment and rolls everything
  back. 30 checks; run once against the test project: all pass.
- Every document that called the Ireland project "production" was corrected.

### 2026-10-05/06 Checkpoint: go-ahead to deploy; hosting moved to the Hostinger VPS

The client approved deployment, then corrected the hosting: the client's existing Hostinger
VPS, not Vercel (section 25 has both instructions and the four choices that followed).

- First commit (`a554188`), after checking it held no `.env` file and no credential.
- `npm run verify` in full: lint, typecheck and content clean; 182 unit/SQL/API; 17 Deno;
  194 browser. After the hosting change: 186 unit/SQL/API and 194 browser, lint and
  typecheck clean.
- New: `scripts/verify-functions.mjs`, `scripts/verify-site.mjs`,
  `scripts/build-nginx-config.mjs`, `deploy/` (headers, generated Nginx file, deploy
  script, server env template), `.gitattributes`, `npm run build:staging` and
  `preview:staging`, one git-ignored secrets file per environment.
- Removed: `vercel.json`, `.vercelignore`.
- Nothing was deployed anywhere. The Supabase CLI is still not signed in; the client asked
  how to sign in with an access token and was given `supabase login --token`, typed in
  their own terminal so the token is never in the chat.
- Not done, and waiting on the client: `supabase login`, the owner's email, a GitHub
  repository, the read-only look at the VPS.
