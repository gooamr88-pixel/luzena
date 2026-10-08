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
12 PM; Google Maps link `https://maps.app.goo.gl/WTwNqRWv3dyaetAQ8`. **The restaurant's own photos have not arrived;
since 2026-10-06 placeholder stock photos are shown in their place (section 14).** The client's earlier instruction was "do not deploy
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

- Public site, since 2026-10-06: follows the home page design that was supplied that day.
  Dark (`night`) header, hero, page headers and footer; cream pages (`#F6F4F0`); gold
  (`#C9A063`) buttons and accents; a forest green "visit us" band; rounded photo tiles and
  cards. Playfair Display headings, Open Sauce One text. History: dark with a gold accent
  first; light cream/terracotta/olive from the logo on 2026-10-05; this design on
  2026-10-06. The logo is shown white on the dark surfaces.
- Gold is a fill, never text on light: accent text is `brand` (bronze `#835F20`), which
  turns back to gold inside a dark surface (the `on-dark` scope). Buttons are dark text on
  gold, not white as the supplied design shows: white on gold is 2.4:1.
- The home page header lies over the hero and turns solid on scroll, in CSS only.
- The hero has two forms: photo behind a scrim, or the same dark block with a glow and the
  logo's leaf.
- PLACEHOLDER PHOTOS, by instruction of 2026-10-06: the live site shows
  `content/media/placeholder-*.jpg` (hero, our story, gallery, location) until real photos
  replace them, never the photo-less layouts. They are the design template's stock photos:
  not this restaurant, licence never checked. The photo-less layouts remain in the
  templates for a slot whose photo is removed and not replaced.
- Home page: category tiles and "most popular dishes" cards come from the live menu
  (`featured.js`). A category or dish without a photo of its own gets one of
  `defaultDishPhotos` (placeholders too), so a placeholder can sit beside a real dish's
  name without showing that dish. With that list empty they fall back to green tiles and
  text-only cards.
- "Visit Us" has a Google map (`mapsEmbedUrl`, built from the name and address, no API
  key), beside the details on a laptop and below them on a phone. Also on the Locations
  page. It loads Google's page in a frame, lazily.
- Dashboard, since 2026-10-06: the public site's design language (night sidebar with the
  white logo, gold primary buttons, serif page titles, the same cards and fields), no
  longer a neutral theme of its own. Status colours are its only addition.
- Never fade text with `opacity` to show a state: it lowers contrast invisibly. An
  out-of-stock menu item uses the `muted` colour (`.menu-item-unavailable`).
- Hours are shown day by day, then a line per service (breakfast).
- Careers: 18 roles in 5 departments, each a native `<details>` disclosure.
- The sample profile is the real content with sample values laid over only what is missing.
- Dashboard: dense, separate stylesheet. Every field is tagged "Clover" or "Website".
- Switches and save buttons never show a state the server has not confirmed.
- Below 1280 px the item table becomes cards; on phones the editor save bar is fixed to the
  bottom.
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
   - **The test site against TEST, in a real browser (2026-10-06):** `.env.staging.local`
     written with TEST's two public values; `npm run build:staging`; served at
     `http://localhost:4173` with the production headers. `npm run verify:site` passes
     there with the backend checks included (26 of 26, the two HTTPS checks skipped). In
     Chromium, under the real Content-Security-Policy: the menu page asks the TEST function
     and shows "Menu temporarily unavailable"; the home page loads clean; the dashboard
     shows its sign-in form and answers a wrong password with its generic refusal. Not
     done: anything signed in.
   - PRODUCTION was not touched during any of the above.
   **PRODUCTION backend deployed, 2026-10-06, on the client's words "Proceed to PRODUCTION
   now".** This set aside the client's own earlier order (TEST fully verified first): at
   that moment TEST's Auth settings were still unapplied, so **no signed-in request had
   ever been made against a real backend**, on either project. The client had been told
   so twice. Everything that needs no sign-in had passed on TEST. On
   `xqzpuqjrlrxyitjubkqk` only:
   - Before anything: `verify:public-access` 15 of 15 (the client had already switched
     sign-ups off; the email provider is on; a wrong-password sign-in answers "Invalid
     login credentials"). The database held 0 restaurants, 0 users, 0 applications.
   - The four functions deployed (`verify_jwt` false on each). Secrets from
     `.env.production`: `ALLOWED_ORIGINS`, `MENU_SYNC_TTL_SECONDS`, `TOKEN_ENCRYPTION_KEY`,
     `IP_HASH_SALT`, and nothing else: no `CLOVER_*`, no `RESEND_*`, no `JOB_*`.
   - The owner `fadi.auchi@gmail.com` created (no password, no email sent) and the
     restaurant `luzena` provisioned and linked.
   - `verify:functions` 15 of 15 with `https://luzenarestaurant.com` as the origin;
     `verify:public-access` 15 of 15 again. Security advisor: the same 16 notes and the
     `search_path` warning as on TEST, plus the leaked-password warning; no error.
   - `config push` was NOT run on PRODUCTION and must not be run from here. Its Auth is
     as the client set it in the dashboard. Still to set there, by the client: minimum
     password length 12, Site URL and redirect `https://luzenarestaurant.com/dashboard/`.
   **THE INFORMATION SITE IS LIVE: https://luzenarestaurant.com, 2026-10-06.** The client
   ran checklist sections 5 to 7 on the VPS (user and folder, clone over HTTPS, `site.env`,
   `deploy.sh`, certificate for both names valid to 2027-01-04, the Nginx file) after
   pointing the domain's `A` record at the VPS and setting the Auth site address and
   password length in the dashboard. `deploy/deploy.sh` and the generated Nginx file worked
   on the real server without a change. `npm run verify:site` from here, with `WWW_URL`:
   **28 of 28**: HTTPS and both redirects, every header exactly as in `deploy/headers.json`
   (on pages, hashed files and the 404 page), robots, sitemap, the nine public pages, no
   dot-file or repository file reachable, ordering and the application form off, the
   dashboard, the PRODUCTION project and no other, and the backend reached from the site's
   own origin.
   - Lesson for the checklist: paste the VPS commands one block at a time. Pasted all at
     once, the lines typed ahead during `sudo ... git clone` were swallowed, so the first
     attempt enabled Nginx with nothing built (the domain answered 404 for some minutes).
   - `nginx -t` prints "protocol options redefined" warnings on that server. Harmless, and
     there before this site: the sites sharing port 443 do not all name `http2`.
   - **After go-live, the same day:** the client reported the owner's first sign-in done
     ("Dashboard done"); it could not be confirmed from here (the CLI was signed out
     again). The client installed the old domain's redirect: `luznarestaurant.com`, its
     `www` and `/coming-soon` all end on the new site, checked from outside. A second round
     of outside tests on the live site, all passing: `verify:site` 28 of 28,
     `verify:functions` 15 of 15 and `verify:public-access` 15 of 15 on PRODUCTION; a real
     Chromium over the nine public pages at 390 and 1280 px, the 404 page and the
     dashboard's sign-in screen under the real Nginx headers (no script error, blocked
     request, policy violation or sideways scroll; the menu's real "unavailable" answer;
     the generic refusal of a wrong password); TLS 1.0 and 1.1 refused, 1.2 accepted; the
     certificate names both hosts; pages are sent gzip-compressed.
   - **A fault on the VPS, found from the client's pasted output, 2026-10-06.** The client
     installed the redirect and reloaded (that is when it was checked), then also ran the
     two "undo" lines that came next in the instructions, then stopped and deleted the old
     application and deleted the old site file. Result: `sites-enabled/luznarestaurant.com`
     is a link to a file that no longer exists, and the redirect is not linked. The running
     Nginx still holds the redirect in memory, so everything works; but `nginx -t` now
     fails, so the next reload is refused and **a restart or reboot would leave every site
     on that server down**, and certificate renewals would fail. The client was given the
     three-line fix (remove the dead link, link the redirect file, `nginx -t`, reload).
     **Fixed the same hour:** the client's `ls -la /etc/nginx/sites-enabled/` shows every
     link pointing at a file that exists, the redirect among them; `nginx -t` passes and
     Nginx was reloaded; from outside the old domain still redirects and `verify:site`
     passes 28 of 28. The old application is stopped, removed from pm2 and deleted, with a
     small source backup left on the server. Lesson: with this client,
     never put undo commands on the page as a runnable block beside the forward path.
   - The first deployment on the server showed two warnings worth knowing: the server's
     Node is 20.20.2 while `@supabase/supabase-js` and `vitest` now ask for Node 22 (the
     build works; only the browser bundle of the first is used), and npm 11 did not run
     `deno`'s install script (not needed for a build). If Node is upgraded on that server
     it must be checked against its other applications first.
   - Not done yet: a signed-in dashboard walk observed from here (it needs the owner's
     password, which only the owner has); stopping and deleting the old application on the
     VPS (pm2 process `luzna-restaurant`, folder `/var/www/luzna`; the client has the
     commands); TEST's Auth settings; resetting both database passwords; narrowing the CSP
     to the production host; N-11; Clover; ordering link; job applications.
   - (Earlier plan, now done:) the client runs checklist sections 5 to 7 on the VPS (the site's build file
     needs PRODUCTION's publishable key, which the client has been given), then
     `npm run verify:site` from here, then the owner's first sign-in ("Forgot your
     password?"), which will be the first signed-in use of the real backend: watch it.
   **CLOVER PREPARATION, 2026-10-06** (client's brief: have everything ready so that only
   authorising the real restaurant's Clover account is left).
   - **Audit.** Read: `clover/auth.ts`, `client.ts`, `config.ts`, `inventory.ts`, `sync.ts`,
     `dashboard/connection.ts`, `public/webhook.ts`, the dashboard's Clover and Overview
     views, the sandbox test. Compared with Clover's documentation as it reads today
     (`high-trust-app-auth-flow`, `approval`, `creating-a-production-app`): the authorize,
     token and refresh hosts and paths for sandbox and North America, the JSON bodies
     (`client_id`, `client_secret`, `code`; `client_id`, `refresh_token`) and the response
     fields (`access_token`, `access_token_expiration`, `refresh_token`,
     `refresh_token_expiration`, Unix timestamps) all agree with the code. The app must be
     set to Default OAuth Response = Code. Clover's overview pages now do describe `state`
     as echoed back; the sandbox still has to show it (UA-6). No code was rewritten.
   - **One real gap, fixed in code: imported items were public by default.**
     `menu_items.web_hidden` defaulted to false, so the first sync would have published the
     merchant's entire inventory. Migration `20261006000600_imported_items_start_hidden.sql`
     makes new rows start hidden; `createItemHandler` now always writes visibility (shown
     unless the form says hidden) and says which in its message; the connect message, the
     Clover page and the Overview tell the owner that nothing is public until shown.
     Tests: a restaurant that has just imported publishes nothing; showing one item
     publishes that one; an item Clover marks hidden is never public; later syncs keep the
     owner's choices while Clover's fields follow Clover; hiding and archiving leave the
     row and every Clover field untouched. `npm test`: 196 of 196.
     **NOT DEPLOYED: neither project has this migration or the changed functions, and the
     live site has the old dashboard code.**
   - **Sandbox test readiness.** `npm run test:clover-sandbox` exists and drives this
     project's real client, inventory calls and normaliser against
     `apisandbox.dev.clover.com` (hard-wired; it cannot reach production). It now reads
     `.env.clover-sandbox.local` (git-ignored, verified) without printing it, and ends with
     a test that proves the clean-up. **It has never run for real: no credentials exist.**
   - **Blocked on the client's own Clover login** (nothing here can create it): the sandbox
     developer account, a test merchant with a few items, an API token with Inventory read
     and write, the two values in `.env.clover-sandbox.local`; for the OAuth half, a
     sandbox app and its ID and secret.
   - **Blocked on the CLI being signed in** (it is signed out; every call answers 401):
     applying TEST's Auth settings (phase 8 of the brief), the new migration and functions
     on TEST then PRODUCTION.
   - **The limit on "tomorrow":** Clover requires an approved production developer account
     and an approved app before any real merchant can authorise it, and states no review
     time. `BLOCKERS.md` B-1 says this plainly. Do not let the client plan a session with
     the restaurant owner around a date Clover has not confirmed.
   **THE CLIENT'S DECISION, 2026-10-06 (later): connect the REAL merchant tomorrow, no
   sandbox first.** "The owner already has a real Clover merchant account. Stop expanding
   the sandbox setup for now. Prepare the project for the real Clover merchant connection
   tomorrow." Also: do not connect or modify the real merchant yet; do not ask for a fake
   account unless a test needs one. This sets aside the earlier rule of sandbox before
   production; the client was told what stays unproven (`BLOCKERS.md` B-1).
   - **A merchant account is not a Clover app.** OAuth needs an app that Clover has
     approved; none exists and the review has no stated time. Clover's own FAQ says an
     integration that is not a public app should use a merchant-generated API token. So a
     second way to connect was added, beside OAuth, without a schema change:
     `POST /clover/connect-token` (`connectWithToken`), `cloverWithToken`, `sealApiToken`
     and the `API_TOKEN_MARKER` path in `getCredentials` (a token connection is stored like
     an OAuth one, with a marker in the refresh slot and a far-future expiry, so no refresh
     is tried and a rejected token becomes `needs_reauth`); `env.cloverEnvironment`
     (`CLOVER_ENV` with NO default for this path); a token form on the dashboard's Clover
     page, shown when the backend reports `token_connect`.
   - Tests: `tests/token-connect.test.js`, 18 cases against the stand-in: works with no app
     configured; owner only; malformed input never reaches Clover; a rejected token, a
     wrong merchant, a token without inventory access and an unreachable Clover all store
     nothing; the token is encrypted at rest and absent from every log line, audit row and
     response; the import publishes nothing; a deleted token leads to `needs_reauth` with
     no refresh call and the public menu intact; a new token resumes with the owner's
     choices kept; disconnect deletes nothing in Clover; the attempt limit holds.
   - `supabase/functions/.env.production` now also has `CLOVER_ENV=na` (local file; not
     yet sent to Supabase). Still no app id or secret, and no job-application value.
   - **Deployment order when the CLI is signed in** (it is signed out; the client's tokens
     keep expiring, so ask for one that lasts a week): TEST: migration `..600`, the four
     functions, `verify:functions`. PRODUCTION: the same, plus `secrets set` from
     `.env.production`, then `verify:functions` and `verify:public-access`. Then the client
     runs `deploy.sh` on the VPS and `verify:site` is run from here. **Until all of that is
     done, the production dashboard cannot connect a merchant by token, and must not
     connect one any other way.**
   - **DEPLOYED to both Supabase projects, 2026-10-06** (the client signed the CLI in):
     - `supabase db push --dry-run --linked --project-ref <ref>` first on each: exactly one
       migration, `..600`. Then applied. Both now have 6 migrations and
       `menu_items.web_hidden` defaults to true. (`db push` works with the CLI's login role;
       no database password is needed. The `[remotes.*]` blocks in `config.toml` load.)
     - The four functions redeployed to TEST then PRODUCTION. `verify:functions` 15 of 15 on
       each; `verify:public-access` 15 of 15 on PRODUCTION.
     - PRODUCTION secrets now include `CLOVER_ENV=na`, which is what switches the token form
       on. The only Clover-related secrets there are `CLOVER_ENV` and
       `TOKEN_ENCRYPTION_KEY`: no app id, no app secret. PRODUCTION had 0 menu items and 0
       Clover connections before and after.
     - `POST /dashboard-api/clover/connect-token` exists on PRODUCTION and answers 401 to a
       request with no session or a forged one.
     - **First evidence from Clover itself:** with made-up values (no real merchant, no real
       token), `api.clover.com` and `apisandbox.dev.clover.com` both answer a
       `/v3/merchants/.../items` read with HTTP 401 `{"message":"401 Unauthorized"}`. That
       is the answer the code maps to "Clover did not accept this merchant ID and token".
     - **Still to do before a merchant is connected: the website.** The live dashboard is
       the old build, with no token form and none of the new wording. The client runs
       `deploy.sh` on the VPS; then `npm run verify:site` from here.
   - The real merchant has not been touched.
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
- Colours are tokens. Change them in `main.css`, never hard-code a colour in a template;
  on a dark block use the `on-dark` scope, not a second set of colour classes. The `.menu-item` and `.tag` rules in `dashboard.css` must match `main.css`.
- Deploy only in the order the client gave (section 25): TEST before PRODUCTION, and no
  Clover in production before the sandbox plan passes. The only stock photos that may be published are the copies in
  `content/media/placeholder-*.jpg`, and only until real photos replace them: a browser
  test fails if any other image appears in the production build. `content/sample-media/`
  is read only by sample builds, and on the server Nginx's root is the built release, never
  the repository.
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

### 2026-10-06 Checkpoint: public site redesigned to the supplied home page design

A home page design (one image) was supplied with the instruction to match it or better it:
dark photo hero under the header, gold buttons, category photo tiles, popular dish cards, a
story block with a photo and icons, a photo strip, a dark green "visit us" band.

- `src/styles/main.css` rewritten: new tokens (night, forest, gold, bronze `brand`), the
  `on-dark` scope, rounded corners, shadows, and the new components. Every page inherits
  it; `.page-hero` is now dark on all inner pages.
- Home page rebuilt in that order of sections. `src/js/featured.js` now fills category
  tiles and dish cards from `<template>` elements; new `src/js/strip.js` for the photo
  strip's arrows; new `src/partials/icon.html`; new `public/leaf.svg` (the logo's leaf,
  used as a CSS mask).
- Header, footer and phone menu are dark with the logo in white. Menu links from the home
  page (`/menu/#menu-ID`) now scroll to their category once the menu has rendered.
- Content: `hero` text replaced with the design's ("A Place for Every Moment"), not yet
  approved by the owner; `about.values` gained an `icon` each. The About text is unchanged:
  the design's "our story" wording and two of its four points ("Family Friendly", "Local
  Community") are claims nobody has confirmed, so they were not copied.
- Not done: the design's video play button (there is no video).
- Dashboard preview: accent colour and tag corners changed, to stay identical to the
  public menu.

### 2026-10-06 Checkpoint: placeholder photos live, map in "Visit Us", dashboard restyled

Three instructions, all on 2026-10-06, after the public redesign above.

- **Placeholder photos on the live site.** "Keep the sample photos visible on the live site
  as the default images; do not switch to the no-photo fallback; until we replace them with
  the owner's real photos." Eight stock photos copied from `content/sample-media/` to
  `content/media/placeholder-*.jpg` and named in `content/site.json` (hero, about, location,
  five gallery photos). New `defaultDishPhotos` in the content file: `featured.js` gives one
  to a category tile or featured dish that has no photo. The gallery page is therefore
  published and in the sitemap. This reverses the earlier rule that no stock photo may be
  published; the licence question it rested on is still open, and the photos do not show
  this restaurant. `ogImage` and `careers.image` were left unset.
- **Google map.** `locations[0].mapsEmbedUrl` set to a keyless Google Maps embed of the name
  and address; the build refuses any address that is not `https://www.google.com/maps...`.
  `geo` is still unset. The browser tests answer for Google with an empty page.
- **Dashboard restyled** to the public site's design language across every screen: sign-in,
  overview, items, item editor, categories, modifiers, Clover, activity, dialogs, drawer.
  Styling and layout only: `src/styles/dashboard.css`, the shell in `main.js`, the shared
  blocks in `ui.js`, and class names in the views. No request, route, permission or data
  flow changed. Two layout changes: item cards instead of the table below 1280 px, and the
  item filters regrouped. One wording fix: "Up to six featured items" is now four.
- One browser test was made to wait: "asks before leaving with unsaved changes" read the
  address before the dialog had closed, and failed once on a busy machine.
- Nothing committed, nothing deployed.

### 2026-10-06 Checkpoint: job applications become a dashboard workflow; the email leaves the website

Instruction: a complete application system for the Join Our Team page. The applicant's form,
then the database, then the dashboard, then an email to the owner; the owner's address off
every public page but kept as the recipient; nothing committed or deployed.

What existed already: the form (name, email, phone, position, message, CV), the
`job-application` function, the private `cvs` bucket, the recipient in
`restaurants.recruitment_email`, rate limiting, bot traps, the two switches and the
retention period. The email, with the CV attached, was the only record.

What changed:

- **The database is the record, the email a notification.** New migration
  `20261006000700_job_application_workflow.sql`: the new answers, a `status`
  (new, reviewing, shortlisted, interview, hired, rejected), a `submission_id`, and
  `job_application_events` (17 tables now). The applicant is answered once the application
  is stored; the email goes after. A failed or unconfigured email no longer fails the
  application: it is marked, and the dashboard says so. `job_application_create` was
  dropped in favour of `job_application_submit`.
- **The form** asks, besides contact details and position: full-time or part-time, when the
  applicant could work (five boxes), when they could start, how much experience, whether
  they are legally authorized to work in the United States; optionally their experience in
  their own words, an introduction and a CV. The authorization question and the wording of
  every question are the engineer's and have not been approved by the client.
- **Duplicates and spam:** a per-visit `submission_id` makes a repeated send one
  application; 3 a day per email address (hashed) on top of 5 an hour per connection; the
  honeypot, the minimum fill time and the origin check as before.
- **The dashboard** has an Applications section (owners and managers; not staff): list with
  search, stage pills, position and date filters; one application in full with its history;
  stage changes with a note; CV download. A gold number in the sidebar counts new ones.
- **The CV has no address.** It is streamed through the authenticated dashboard API as a
  download. No public URL, no signed URL, not attached to the email. Downloads are recorded.
- **The email:** "New Job Application — name — position", a summary and a button to the
  application in the dashboard. Not in it: the CV and the applicant's own words.
- **The owner's address is off the website.** `locations[0].email` is `null`; it was in the
  footer, on Contact and on Locations, and in the data given to search engines. It stays in
  `supabase/provision-restaurant.sql` and the database as the recipient. A browser test
  scans every file of both builds for it. It is still written in this repository's
  documents, and the repository is public (section 25).
- **Not switched on.** `careers.applications.enabled` is still `false` and the two secrets
  are still unset: B-3 (privacy policy) and B-4 (retention period) are the client's, and the
  migration and both functions are not deployed. Until then the live Careers page says
  applications open soon. The live site also still shows the address until it is redeployed.
- B-7 (Resend) no longer blocks applications, only the notification.
- Tested: `tests/applications.test.js` runs the whole path on the real handlers and real
  SQL (form request, database, dashboard API, email, CV download, access by role and by
  restaurant, retention). Browser tests cover the form and the dashboard screens on the
  demo data. Not tested: any of it against a deployed project, and a real email.

### 2026-10-06 Checkpoint: "push and deploy" — pushed; both deployments wait on the client

The instruction was "push and deploy". Everything since `da003a8` (the redesign, the
placeholder photos, the map, the dashboard restyle, the job application system) was
committed on `main` as `d34c746` and pushed to GitHub, after `npm run verify` passed in full.

Not deployed, and why:

- **Supabase (the new migration and the two changed functions).** The CLI on this machine
  is signed out again: `supabase projects list` answers Unauthorized. Once the client has
  run `supabase login` in their own terminal, the order is the usual one, TEST first:
  `supabase db push --dry-run --linked --project-ref cgxhifkeoesvsycewwfs` (expect exactly
  one migration, `..700`), then without `--dry-run`; then
  `supabase functions deploy dashboard-api public-menu job-application clover-webhook
  --project-ref cgxhifkeoesvsycewwfs --use-api`; `npm run verify:functions`. Then the same on
  PRODUCTION (`xqzpuqjrlrxyitjubkqk`), plus `npm run verify:public-access` and
  `npm run verify:database` (it now expects 17 tables). No secret changes: the two
  job-application switches stay unset.
- **The website.** `deploy.sh` runs on the VPS and nobody connects to it from here. The
  client runs `sudo -u luzena bash /var/www/luzenarestaurant.com/repo/deploy/deploy.sh`;
  then `npm run verify:site` from this machine.

The two are independent and either can go first. The new website works with the old
functions: the dashboard shows "Applications" only when the backend grants the permission,
which the old backend does not. The new functions work with the old website.

Until the website step is done, the live site is still the old design and still shows the
owner's email address.

### 2026-10-06 Checkpoint: DEPLOYED — the redesign and the application system are live

The client supplied a Supabase access token and the CLI was signed in with it. **The token
was pasted into the chat**, so it should be revoked in the Supabase account and replaced; it
is written in no file here.

- One more commit first, `d7a8560`: the migration now grants `job_application_events` to
  `service_role` outright. `db push` runs as the CLI's login role, not the role that applied
  the first migrations, so default privileges could not be relied on. The SQL tests do not
  catch this (they do not run as `service_role`); it was checked on each project afterwards.
- **TEST** (`cgxhifkeoesvsycewwfs`): dry run showed exactly one migration, `..700`; applied.
  17 tables, 7 migrations, row level security on the new table, `service_role` can write
  both application tables, `anon` and `authenticated` hold nothing, the old
  `job_application_create` is gone. The four functions redeployed. `verify:functions`: all
  pass. The new routes answer 401 without a session.
- **PRODUCTION** (`xqzpuqjrlrxyitjubkqk`): the same, with the same results, 0 applications
  before and after. `verify:functions`: all pass. `verify:public-access`: 15 of 15 (run with
  the real publishable key, read from the live dashboard bundle; a first run with a
  truncated key answered "Invalid API key" to everything and proved nothing). The public
  key can neither read `job_application_events` nor call `dash_applications_list`.
  No secret was changed: the two job-application switches are still unset.
- **The website** was already redeployed on the VPS by the client when this was checked.
  `verify:site`: 28 of 28. Spot checks: no email address and no `mailto:` on any public page
  or in the dashboard bundle; the placeholder hero photo is served; the map frame is on the
  home page; `/gallery/` is in the sitemap; the dashboard bundle has the Applications
  section; `/careers/` says "Online applications open soon".
- Not done, because each needs something from the client: opening the application form
  (privacy policy, B-3; retention period, B-4) and the notification email (Resend, B-7).
- Not tested on the live system: anything signed in. The owner opening the dashboard and
  seeing Applications (empty) is the first real use of the new routes.

### 2026-10-06 Checkpoint: applications OPENED — policy drafted, 90 days, backend live; the site waits for one more deploy

The client, asked what the two open items needed, answered: keep applications **90 days**;
**draft the privacy policy for me**; **I have a Resend API key**.

- **Privacy policy** written into `legal.privacy.sections` and published at `/privacy/`
  (commit `26c71b6`). It says what the system does and nothing else: what a visit and an
  application collect, who reads an application, Supabase in the United States, the
  notification through Resend, the hashed address, 90 days, deletion on request by phone,
  the Google map, Clover for payments, no tracking. The engineer wrote it. No lawyer has
  read it and the owner has not approved it.
- **`careers.applications.enabled` is `true`.** The production build now carries the form.
- **Deletion on request**, which the policy promises, did not exist: added
  `DELETE /applications/{id}` (owners and managers) and a "Delete application" button with
  a confirmation. CV first, then the row; the history goes with it; the audit log keeps only
  that it happened.
- **TEST:** functions redeployed; `JOB_APPLICATIONS_ENABLED=true`,
  `JOB_APPLICATION_RETENTION_DAYS=90`. **The first real run of the whole path:** a labelled
  test application with a PDF was accepted; sent again with the same submission id it stayed
  one application; a foreign origin got 403; bad answers got 422 with a message per field.
  In the database: one row with every answer, the CV in the private `cvs` bucket (the first
  file this system has ever stored), history `submitted, email_failed` (TEST has no email
  provider, so this is the designed outcome), found by the dashboard's search function.
  Then the row was aged past 90 days and a second application triggered the clean-up: the
  row, its history and the file were all removed. Left clean: 0 applications, 0 files.
- **PRODUCTION:** functions redeployed; the same two secrets set (also added to the local
  `.env.production` and `.env.test`); `verify:functions` passes with
  `EXPECT_APPLICATIONS=open`. One labelled test application without a CV was accepted,
  stored as `new` with history `submitted, email_failed`, and deleted by SQL. Left clean:
  0 applications, 0 history rows, 0 files. The recipient address is set in the
  restaurant's row.
- **Still to do:**
  1. The client runs `deploy.sh` on the VPS: until then the live Careers page still says
     "open soon" and `/privacy/` is still empty. Then `npm run verify:site` from here with
     `EXPECT_APPLICATIONS=open`.
  2. The client sets `RESEND_API_KEY` and `EMAIL_FROM` on PRODUCTION from their own
     terminal. The sender's domain has to be verified in Resend. Until then applications
     arrive in the dashboard marked "notification not sent". No real email has ever been
     sent by this system.
  3. The owner reads and approves the policy.
  4. The access token pasted into the chat is still the CLI's login: revoke and replace it.
- **A promise to watch:** the policy says deleted after 90 days; the clean-up runs when an
  application arrives or the dashboard overview is opened, so it can run late in a quiet
  spell (`BLOCKERS.md` N-9 is the scheduled version).
- Not tested anywhere real: the signed-in dashboard (list, open, status, CV download,
  delete) against a deployed project. It needs the owner's password.

### 2026-10-07 Checkpoint: Careers page, form first; a file control of the site's own

The client, looking at the live form: the file field read "No file chosen" in Arabic and
looked plain; make it English and professional, and put the form at the top of the page with
everything else under it.

- The wording was the browser's, not the site's: a browser labels `<input type="file">` in
  its own language. The input is now visually hidden and a control of the site's own stands
  in for it (`.file-drop`): "Choose a file or drop it here", then the chosen file's name and
  size with Remove. A wrong kind of file is refused when it is chosen.
- Careers page order: page header, **the form**, the three steps, the open positions.
- Verified: 243 unit tests and the Deno checks; the browser run was cut through by the
  machine going to sleep (three timeouts in the sample tests, one "lasting" 1.9 hours), so
  the sample file was run again on its own: 23 of 23. Public and dashboard files passed in
  the first run.
- Website only: no function or database change. Needs `deploy.sh` on the VPS.

### 2026-10-07 Checkpoint: the owner changes the website's photos from the dashboard

The client: "all images in landing page, img of gallery, hero, main photos: add ability to
change them from dashboard professionally."

- **What can be changed:** the home page's hero photo, the "our story" photo (home and
  About), and the gallery (Gallery page; its first eight are the row on the home page).
  Dish photos were already changeable per item. Still build-time only: the logo, the
  location photo, the link preview image, the default dish photos.
- **How:** the built photos stay in the HTML as the default and the fallback. A new public,
  read-only function `public-site` tells the page which photos the owner has chosen;
  `src/js/site-media.js` swaps them in. Nothing chosen, a late answer (4 s) or a failure all
  leave the built photos. The hero photo is held back until the answer is in so nobody sees
  it change, and lets itself in after two seconds without the script.
- **Dashboard:** a Photos page (`#/photos`, permission `site.manage`: owner and manager).
  "Your photo" or "Starting photo" on each; replace, describe, go back to the starting
  photo; gallery of up to 24 with add several at once, reorder, describe, remove. Photos are
  resized in the browser to two sizes and re-encoded; the server checks them again.
- **Database:** migration `20261007000800_site_photos.sql`, table `site_photos` (18 tables
  now). Files in the public `menu-images` bucket under `<restaurant>/site/<slot>/`.
- **Decision:** a chosen gallery replaces the built gallery whole, rather than mixing the
  owner's photos with placeholders.
- **Verified locally:** 262 unit tests, Deno checks for five functions, 231 browser tests
  (see `TESTING.md` for the sleep that split the run). `verify:functions` and `verify:site`
  have new checks for the endpoint.
- **Deployment order matters:** backend first (migration, then the five functions, TEST then
  PRODUCTION), then `deploy.sh` on the VPS. A site deployed first only logs a failed request
  and shows the built photos.
- **State at this checkpoint:** committed and pushed. **Not deployed:** the Supabase CLI on
  this machine is signed out (the access token pasted into chat on 2026-10-06 was revoked,
  as advised), so the migration and the functions wait for the client to sign in again.

### 2026-10-07 Checkpoint: Order Online and Join Our Team redesigned; ordering connected to Clover

The client asked for these two public pages only, and for ordering to be connected. Not to
be touched: dashboard, Supabase, authentication, RLS, the Clover integration, the database,
the backend. "Do not commit or deploy yet."

- **The ordering link is set:** `ordering.url` in `content/site.json` is
  `https://luzna-cafe-el-cajon.cloveronline.com/menu/all`, given by the client. BLOCKERS B-2
  is resolved in the repository; it is live after the next deployment.
- **The path is website -> Order Online page -> Clover**, as the client specified. Every
  ORDER ONLINE button now leads to `/order/` (`orderHref` is always `/order/`); before, a
  configured link would have sent the buttons straight to Clover. Only the Order page links
  to Clover, with two ORDER NOW buttons. No cart, no payment, no form on the page.
- **Not embedded:** Clover's page forbids framing by other sites (`frame-ancestors`), so it
  is linked in the same tab.
- **Order page:** compact header with ORDER NOW on the first screen (a photo beside it from
  1024 px), three steps, the owner's featured dishes from the live menu (hidden when the menu
  cannot be loaded), three questions as disclosures, address and hours, a closing band.
- **Careers page:** compact header, then the form at once as one white card in four numbered
  parts with the send button in its foot; "What happens next" and a privacy note beside it
  on a wide screen and under it on a phone; the open positions below. Every field, id, name,
  rule and the submission code are as they were; `src/js/careers.js` is unchanged.
- The build accepts `cloveronline.com` as Clover's own host (it warned for anything not on
  `clover.com`).
- **Verified:** lint, types, content; 263 unit tests; 234 browser tests including the
  accessibility scan and the seven widths for both pages. **Not verified:** that the Clover
  page is live (it answers automated visitors with HTTP 406).
- **State:** nothing of this is committed or deployed, by instruction. The photos work
  before it is committed and pushed (`9188f58`) but its backend is not deployed: the
  Supabase CLI on this machine is signed out.

### 2026-10-07 Checkpoint: the photos backend DEPLOYED to TEST and PRODUCTION

The client signed the Supabase CLI in again (an access token pasted in chat; it is in no
file and no commit, and should be revoked and replaced). Deployed from commit `9188f58`;
the `supabase/` folder had no uncommitted change.

- **TEST** (`cgxhifkeoesvsycewwfs`), then **PRODUCTION** (`xqzpuqjrlrxyitjubkqk`), each: the
  dry run named exactly `20261007000800_site_photos.sql`; applied; the five functions
  deployed with `--use-api` (`public-site` is new).
- **Checked on each by query:** 18 tables; row level security on `site_photos`, no policy;
  `anon` and `authenticated` can neither read the table nor call its functions;
  `service_role` can write and call.
- **`verify:functions`:** all passed on both, including the three new checks (the public
  endpoint's answer, what it refuses, and the dashboard routes without a session).
  **`verify:public-access`** on PRODUCTION: 15 of 15.
- The live endpoint answers `{"hero":null,"story":null,"gallery":[]}`: nothing chosen yet.
- **The website is NOT yet deployed with this:** the live home page carries no
  `data-site-url`. It needs `deploy.sh` on the VPS, which will publish `origin/main`
  (`9188f58`: the Photos page and the photo swap). Then `npm run verify:site`.
- **Still only on this machine, by instruction:** the Order Online and Join Our Team
  redesign and the Clover ordering link. Not committed, so `deploy.sh` will not publish it.
- Not tested: a signed-in owner uploading a real photo on the live dashboard.

### 2026-10-07 Checkpoint: Join Our Team becomes the application form alone

The client, after the redesign went to GitHub (`a8bf499`): "Remove hero section and the
below. Put the form only. But make it very professional."

- The page header, the "What happens next" column and the list of open positions are gone.
  The page is one card: a head that carries the title (`h1` "Join Our Team", the intro,
  three assurances), the four numbered parts, and the consent and send button in its foot.
- The 18 roles are still offered, as the choices of the Position list, by department, with
  "Other". Their descriptions stay in `content/site.json` but are shown nowhere.
- No field, rule or request changed. `src/js/careers.js` lost only the code for the
  "Apply" buttons that were on the removed role cards.
- The meta description no longer says "Open positions".

### 2026-10-07 Checkpoint: BUG fixed, the application form slid sideways on a phone once a file was chosen

Reported by the client with a screenshot of the live site on a phone: after choosing a CV,
the page was wider than the screen.

- **Cause:** a browser will not make a `<fieldset>` narrower than its widest unbroken
  content. The chosen file's name was kept on one line, so the group of questions around it
  grew to that line's width and took the page with it. The earlier test of the file control
  used a short name on a laptop-sized screen, so it never saw this.
- **Fix:** `fieldset { min-width: 0 }` in the public stylesheet's base layer. The name now
  takes up to two lines, broken anywhere (file names often have no spaces), with the whole
  name as its title.
- **Test added first, and seen to fail:** a 72-character file name at 320, 360 and 390 px;
  the page must not scroll sideways, the row must stay inside the card and Remove on screen.
- Verified: lint; 234 browser tests. Not committed at this checkpoint.
- The screenshot also showed the live site is still the version before the redesign: the
  VPS has not been deployed since `2d4f8b4`.

### 2026-10-07 Checkpoint: full audit of the codebase; motion added to the public site

**The audit** (asked for by the client: front end, back end, database, UX/UI, responsive,
dead code, security). Read: every shared backend module, the migrations, the deployment
files, the public scripts and the dashboard's entry, sign-in and photos code. Run:
`npm audit` (0 vulnerabilities), a scan for unused styles and exports, `verify:site` on
the live site (all passed), an accessibility scan of five live pages (no violations), and a
test on TEST of whether an invented X-Forwarded-For header gets round the public rate limit
(it does not: 120 of 140 answered either way). Nothing in the audit was fixed except the
stale home page copy below; the rest is open.

Open findings, most serious first:

1. **Gallery: the same photo uploaded twice shares one file; removing either copy deletes
   the file the other still uses** (broken image on the live gallery). Confirmed with a
   throwaway test. `site-photos.ts` / `dash_site_photo_remove`: files are named by a hash of
   their content and removed without asking whether another row names them.
2. **The placeholder stock photos are live and their licence was never checked** (N-1).
3. **The notification email was not configured on PRODUCTION when last seen** (`RESEND_API_KEY`,
   `EMAIL_FROM`): without it applications arrive in the dashboard marked "email failed". Not
   checked again: the CLI is signed out.
4. **The owner's sign-in has no second factor**, and the dashboard holds applicants'
   personal details and CVs. TOTP is enabled in the Supabase config but the dashboard has no
   screen for it.
5. The Supabase access token pasted into chat twice: the CLI on this machine answers
   "Unauthorized" again, so it appears to have been revoked. Nothing to do if so.
6. **Uploads are capped by the Content-Length header only** (job application, item and site
   photos): a caller who lies about it is limited by the platform, not by this code.
   `http.ts` already says the header cannot be trusted and `readJson` counts real bytes.
7. **The job application limit is 5 an hour per address, counted before validation.** People
   on one mobile carrier or one Wi-Fi share an address; a hiring day could hit it.
8. **Tables that only grow:** `rate_limits` (one row per address per endpoint, removed only
   when that address returns), `idempotency_keys`, `sync_runs` (a row every five minutes
   while the site has visitors), `integration_logs`.
9. **Deleting applications after 90 days depends on someone visiting**: it runs after an
   application or when the overview is opened (N-9).
10. **`deploy.sh` carries every older release's asset files forward for ever**: it copies
    all of the previous release's `assets/`, which already holds the ones before it.
11. Live menu content: no dish has a description, 49 of 53 have no photo, none is marked
    featured (so "Most Popular Dishes" never shows), and "Tanur French Bread, Saj Bread" is
    priced $0.00 and printed so.
12. CSP allows any `*.supabase.co` for images and requests, not this project's host only.
13. The Clover webhook writes any caller's "verificationCode" to the log before checking
    who is calling, and reads the whole body before checking its size.
14. An item photo is uploaded before the item row is updated; a failed update leaves the file.
15. Dead code: `orderIsExternal` is always false (seven template branches); the role
    descriptions and `careers.image` in the content are shown nowhere; `.alert-success`;
    the Order page's "opening soon" branch is in no built site and no browser test.
16. `npm:@supabase/supabase-js@2` in the functions is not pinned to a version.
17. Never done: a signed-in session against the live dashboard, a real application through
    the live form, a real notification email, the Clover write paths against real Clover.

Fixed in passing: the home page still said "See the open positions" and its button "See
Open Positions", for a page that is now the form alone. Now "Applying online takes about
five minutes" and "Apply Now".

**Motion** (the client: "I need more professional and animations"). Public site only; the
dashboard is unchanged. See "Motion" in `docs/DESIGN_SYSTEM.md`: page-to-page cross-fade,
header words arriving, scroll reveal with staggered cards, hover lift, things that open.
All of it is off for reduced motion. The browser tests now open pages as a reduced-motion
visitor (the page at rest) and the animations have 14 tests of their own, chiefly that
nothing is ever left hidden. Not committed at this checkpoint.

### 2026-10-07 Checkpoint: the audit's findings fixed, except those that are not code

The client refused the push of the motion work with "Fix all first". Numbers are those of
the list in the checkpoint above.

**Fixed, each with a test:**

- **1. Gallery duplicate.** A file is deleted only when no photo on the website still shows
  it (`noLongerShown`), on remove, on replace, when a full gallery refuses a photo, and when
  saving fails. No database change.
- **6. Upload sizes.** `readBytes` and `readForm` in `http.ts` count the bytes that arrive
  and stop at the cap. Used by the application form, both photo uploads, JSON bodies and the
  Clover webhook.
- **7. Application limit** per address: 20 an hour, was 5. The limit of 3 a day per email
  address and the bot traps are unchanged.
- **8 and 9. Clean-up.** `upkeep` runs about once an hour on the back of `public-menu` and
  `public-site` requests: expired applications, then `housekeeping()` (new migration
  `20261007000900_housekeeping.sql`).
- **10. deploy.sh** notes which hashed files each release built (`shared/own-assets/`) and
  carries only those into the next release. Its lines were run over four pretend releases.
- **11 (part).** A price of zero is no longer printed on the website; the dashboard's item
  list still shows it. The other content gaps are the owner's to fill in the dashboard.
- **13. Webhook.** At most five verification requests an hour are written to the log; the
  body is read under a cap.
- **14. Item photo.** A file stored for a photo that then cannot be saved is removed.
- **15. Dead code.** `orderIsExternal` and its seven template branches; `.alert-success`.
- **16.** `@supabase/supabase-js` pinned to 2.117.2 in the functions.

**Not fixed, and why:**

- **4. A second sign-in factor.** A feature, not a fix: an enrolment screen, a challenge at
  sign-in and enforcement in the backend. It cannot be tried from here (no sign-in to the
  live project) and a mistake locks the owner out. Needs the client's go-ahead and a test
  account.
- **12. The security policy naming one Supabase project** instead of any. The policy file
  is shared by TEST, PRODUCTION and the tests, and the server's copy is installed by hand
  with sudo; the gain is small. Left as it is.
- **2, 3, 5, 11 (rest), 17** are not code: the photos' licence, the email key, the token,
  the menu's descriptions and photos, and the things only the owner can try.
- The role descriptions and `careers.image` stay in the content file: unused, but written
  work that may be wanted back.

**Deployment this needs:** the backend first: migration `..900_housekeeping`, then the five
functions, TEST then PRODUCTION (the Supabase CLI is signed out). Then `deploy.sh`. If the
functions go first, the hourly pass logs `upkeep_failed` until the migration is there and
nothing else is affected.

### 2026-10-08 Checkpoint: category photos from the dashboard; backend DEPLOYED; second audit

The client: use the access token given earlier to sign in, let the owner control the photos
of the home page's category tiles from the dashboard's Photos page, audit again, push.

**Category photos.** `menu_categories.web_image_path` (migration
`20261008001000_category_photos.sql`), website-only, untouched by synchronisation. It
reaches the page inside `public-menu` as each category's `image_url`. A tile shows the
first that loads: the category's own photo, a dish's, a starting photo. The dashboard's
Photos page has a "Menu categories" section that draws each tile as a visitor sees it, with
its place on the home page, and says where the photo comes from ("Your photo", "From one of
its dishes", "Starting photo") and why a category is not on the home page. Photos are
resized to 960 px in the browser. Routes `POST` and `DELETE /categories/<id>/image`,
permission `site.manage`. 14 backend tests, 4 browser tests.

**Deployed to TEST, then PRODUCTION** (the token still worked: the "Unauthorized" seen on
2026-10-07 was this machine's stored sign-in, not a revoked token):

- Dry run on each named exactly `..900_housekeeping` and `..1000_category_photos`; applied.
- The five functions deployed to each, so the audit's backend fixes are live too.
- By query on each: 18 tables, the new column there, the new functions closed to `anon`
  and `authenticated` and open to `service_role`.
- `verify:functions` passed on both; `verify:public-access` 15 of 15 on PRODUCTION; the
  live menu's 8 categories each carry `image_url` and no storage path.
- The hourly pass is running on PRODUCTION: its counter is there, and no rate-limit row is
  older than two days.

**Verified locally:** lint, types, content; 291 unit tests (9 files); Deno checks; 252
browser tests.

**Second audit.** `npm audit` 0; the unused-code scan found nothing real; `verify:site`
passed on the live site. Read this time: the Clover client and token code, in full.

Still open, none of it new code to write without a decision:

1. **The notification email is not configured on PRODUCTION.** Checked by name: neither
   `RESEND_API_KEY` nor `EMAIL_FROM` is set. Applications will arrive marked "email failed".
2. **No application has ever been received on PRODUCTION** (0 rows): the live form, the
   dashboard's Applications pages and the email have never been used for real.
3. **The access token is still valid**, has been pasted in chat three times, and is stored
   on this machine. It should be revoked and replaced.
4. **No second sign-in factor** on the owner's account.
5. The placeholder stock photos are live, licence unchecked. The owner can now replace
   every one of them from the dashboard except the location photo and the link preview.
6. Menu content: no descriptions, 49 of 53 dishes without a photo, none featured.
7. A single "unauthorized" answer from Clover to a merchant API token marks the connection
   as needing a new token (`clover/auth.ts`). Right if the token was revoked; a one-off
   wrong answer from Clover would stop the menu refreshing until the owner re-enters it.
8. A category that Clover removes keeps its photo file in storage.
9. The number of category tiles on the home page (six) is written in two places:
   `src/js/featured.js` and `src/dashboard/views/photos.js`.
10. The security policy allows any `*.supabase.co`; the role descriptions are unused.

**The website is not deployed with any of this**: the live home page still says "See Open
Positions". `deploy.sh` on the VPS publishes the motion, the fixes and the category tiles.

### 2026-10-08 Checkpoint: six open items closed; menu labels and the allergy notice. NOTHING DEPLOYED

Two requests from the client in one round, both with "do not deploy". Everything below is
in the working tree and in the tests. **None of it is applied to TEST or PRODUCTION, and
none of it is on the live website.**

**A. The six items left open by the audit.**

1. **Two-step sign-in.** Built on Supabase Auth's own MFA (TOTP); no secret of it is stored
   by this application. Dashboard > **Security** (`views/security.js`) enrols an
   authenticator app (QR code, setup key, six digits) and removes it after asking. After
   the password, an account that has one is asked for the code (`secondStepView` in
   `views/login.js`). The backend enforces it: `authenticate` in `dashboard/session.ts`
   answers `403 mfa_required` to a session below `aal2` when the account has a verified
   factor (`_shared/auth-level.ts`). Read from the projects on 2026-10-08: TOTP is enabled
   on PRODUCTION, disabled on TEST; the "factor added / removed" emails are off on both.
   **Proven against stand-ins only**, never against the real Supabase Auth. The Supabase
   account itself (the one that administers the projects) can only be protected by its
   owner, by hand: `docs/CONFIGURATION.md` section 10.
2. **Dish descriptions** already existed end to end (`web_description`). Added: 9 backend
   tests, a browser test, and `dir="auto"` so Arabic reads right to left.
3. **Featured dishes** already existed end to end (`web_featured`). Added: 8 backend tests
   and browser tests. No dish is featured by the code; the home page leaves the row out
   when none is.
4. **Clover "unauthorized".** One `401` is asked again once (after 1.5 s for a merchant
   token, after a refresh for OAuth). A second is counted in
   `clover_connections.auth_failures` and that attempt fails with "try again in a few
   minutes"; the connection stays connected. It is marked `needs_reauth` only when at least
   3 attempts have failed and Clover has been refusing for 10 minutes; any accepted request
   clears the count. Visitors do not set off a synchronisation within 2 minutes of a
   refusal. Migration `20261008001100_clover_auth_failures.sql`. No token in any log line
   (tested).
5. **Photos of categories Clover has removed** are deleted by the hourly pass 30 days after
   the category went (`ORPHANED_PHOTO_GRACE_DAYS` in `public/retention.ts`), only when the
   path is inside that category's own folder and nothing else shows the file. Migration
   `20261008001200_orphaned_category_photos.sql`.
6. **The "six categories" rule** is `MAX_HOME_CATEGORIES` in `src/js/lib/home.js`, imported
   by `featured.js` and the dashboard's Photos page. A test fails if it is written again.

**B. Menu labels and the allergy notice.**

- Migration `20261008001300_menu_labels_and_notice.sql`: tables `menu_labels`,
  `menu_item_labels`, `site_settings` (21 tables in all), RLS on with no policy, closed to
  `anon` and `authenticated`. Every restaurant gets nine starting labels, **attached to no
  dish**. Dietary tags a restaurant already had (`web_dietary`) are copied over as labels on
  the same dishes; the old column and the old `dietary` field of the API are left in place,
  so the website that is live today keeps working until it is redeployed.
- Dashboard > **Labels** (`views/labels.js`): add, rename, describe, choose one of 18
  icons, switch off, reorder, delete; and the allergy notice (on/off, one text per
  language out of en, ar, es, fr, tr, zh, live preview). The item editor has a "Dietary and
  menu labels" group of tick boxes. Nothing is ever ticked by the code.
- Public menu: `labels` on each dish (name, icon key, description; active only; in the
  owner's order) and `notice` when switched on. Drawn by `src/js/lib/menu-item.js` as a
  small line icon and the name; more than four fold into "+N more". Icons are path data
  from Lucide (ISC), in `src/js/lib/label-icons.js`; no emoji anywhere. The notice is an
  `aside` at the foot of the menu (`src/js/lib/menu-notice.js`), not styled as an error.
- Synchronisation never reads or writes labels or the notice (tested).
- **The wording of the notice is the restaurant's to write.** The example in the brief is
  shown only as placeholder text in the dashboard; nothing here is approved wording, and
  the dashboard says so.

**Verified locally (2026-10-08):** lint, types, content clean; `npm test` **384 passed**
(14 files); Deno type check and smoke checks passed; `npm run test:browser`
**282 passed (3 files: public 151, sample 49, dashboard 82)**. Detail in `TESTING.md`.

**To put it live, in this order, when the client says so:**

1. `supabase db push --dry-run`, then `supabase db push`, on TEST: it must name exactly
   `..1100`, `..1200`, `..1300`. Then the five functions. Then the same on PRODUCTION.
   No new secret and no new environment variable.
2. `deploy.sh` on the VPS for the website (which also publishes everything since
   `6ce935e`).
3. The backend can go first safely: the new fields are additions and the live website
   ignores them. The website must not go first: its dashboard would call routes that do
   not exist yet.

**Still for people, not code:** two-step sign-in on the Supabase, GitHub and Hostinger
accounts; the owner enrolling in Dashboard > Security (first on TEST, with TOTP switched on
there); the notice's wording and which dishes carry which label; descriptions and featured
dishes; and the items carried over from the checkpoint above (notification email on
PRODUCTION, the access token to revoke, the photos' licence).

### 2026-10-08 Checkpoint: the round above DEPLOYED to TEST; two-step sign-in still unproven there

The client: "Test, Commit, Production", with the access token given earlier (passed to each
command in its environment; not stored on this machine again).

**TEST (`cgxhifkeoesvsycewwfs`):**

- The dry run named exactly `..1100_clover_auth_failures`, `..1200_orphaned_category_photos`
  and `..1300_menu_labels_and_notice`; applied. This is the first time these migrations ran
  on a real Postgres.
- The five functions deployed.
- By query: 21 tables, none without row level security, 0 policies, no table and no
  function open to `anon` or `authenticated`, none closed to `service_role`; the three new
  columns on `clover_connections`; the 13 new functions; 1 restaurant with its 9 starting
  labels, on 0 dishes; no notice switched on.
- `verify:functions`: every check passed (2 skipped: they need the public key and an
  owner's login).
- TOTP was switched on for the project (`mfa_totp_enroll_enabled`, `mfa_totp_verify_enabled`).

**Two-step sign-in was NOT proven against the real Supabase Auth.** The attempt (a
throwaway account: enrol, wrong code, right code, the backend's answer at each level, turn
off, delete) stopped at its first sign-in: **email sign-in is switched off on TEST**
("Email logins are disabled"), which is also why nobody can sign in to a dashboard there.
The throwaway account was deleted (checked: none left, no factor left). Switching email
sign-in on for TEST was not done. `supabase/config.toml` asks for it on every project;
PRODUCTION has it on. Until it is on, the only real proof available is the owner's own
first enrolment.
