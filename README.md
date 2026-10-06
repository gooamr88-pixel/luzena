# Luzena Restaurant & Cafe: website and owner dashboard

A public restaurant website, a private dashboard where the owner manages the menu, and a
backend that keeps both in step with Clover. Ordering and payment stay in Clover.

Domain: `luzenarestaurant.com`. (The folder and package are still called `luzna-web`, from
before the spelling was confirmed.)

> **Current state (2026-10-06).** The information site is **live at
> https://luzenarestaurant.com**, with its backend on the production Supabase project. The
> menu, online ordering and online job applications are switched off until Clover, the
> ordering link and the privacy policy exist. It has **never run against Clover**. The code
> is on GitHub in a public repository. The real name, logo, address, phone, hours,
> About text and job list are in place. The restaurant's own photos have not arrived: placeholder
> stock photos stand in for them on the live site (`content/media/README.md`). What stands between here and a live site is listed in
> `BLOCKERS.md`; the order to do it in is `DEPLOYMENT_CHECKLIST.md`.

## Try it now

```bash
npm install
npm run dev          # http://localhost:5173  sample content, dashboard in demo mode
```

- Public site: `/`
- Dashboard: `/dashboard/` (demo mode: sample data in memory, nothing is saved)

Every page shows a "sample content" banner in this mode.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with sample content and the dashboard in demo mode |
| `npm run build` | **Production build** from the real content only. Stops if required content is missing or a setting points at a placeholder. |
| `npm run build:sample` | The real content plus sample photos, a sample menu and a sample privacy policy (marked as sample, blocked from search engines) |
| `npm run build:demo` | Sample build plus the dashboard demo mode |
| `npm run preview` | Serve the last build |
| `npm run build:staging`, `npm run preview:staging` | The test site: a production-content build that reads `.env.staging.local` (the TEST Supabase project), served at `http://localhost:4173` |
| `npm run build:nginx` | Regenerate the production Nginx configuration from `deploy/headers.json` |
| `npm run check:content` | List what `content/site.json` still needs |
| `npm run lint` | ESLint over the site, build and test code |
| `npm run typecheck` | Type-check the backend with `tsc` |
| `npm run check:deno` | Type-check the Edge Functions with Deno and start each one |
| `npm test` | Unit, SQL and API tests |
| `npm run test:browser` | Builds the site twice and drives it in a real Chromium: every page, the dashboard, accessibility scans |
| `npm run measure:performance` | Load-time and size measurements of the built site (run `npm run build:e2e` first) |
| `npm run test:clover-sandbox` | Tests against a real Clover sandbox. Skipped until sandbox credentials are set. |
| `npm run verify:database` | On a real Supabase project, after the migrations: proves the database is closed to the public roles. Needs `DATABASE_URL`. Changes nothing. |
| `npm run verify:public-access` | The same question from outside, with only the public key: can a stranger read, write or sign up? Needs `SUPABASE_URL` and `SUPABASE_PUBLIC_KEY`. |
| `npm run verify:functions` | On a real Supabase project, after the functions are deployed: do all four answer, reach the database and refuse what they should? Needs `SUPABASE_URL` and `ALLOWED_ORIGIN`; with an owner's sign-in it also reads every dashboard screen. |
| `npm run verify:site` | On a deployed site address: HTTPS, the response headers, robots, sitemap, every public page, the dashboard, and that the site names the expected Supabase project and no other. Needs `SITE_URL` and `EXPECT_SUPABASE_URL`. |
| `npm run verify` | Everything above except the sandbox tests, the measurements and the four `verify:*` checks, which need a real project or site |

## How it fits together

| Part | Technology | Where |
|---|---|---|
| Public website | Static HTML, Tailwind CSS v4, vanilla JS, built by Vite | `*.html`, `src/` |
| Owner dashboard | Vanilla JS single-page app, Supabase Auth | `dashboard/`, `src/dashboard/` |
| Backend | Supabase Edge Functions (TypeScript, Deno) | `supabase/functions/` |
| Database | Supabase Postgres | `supabase/migrations/` |
| Photos, CVs | Supabase Storage | |
| Hosting | Nginx on the client's Hostinger VPS, serving the built files; deployed from GitHub by a script on the server | `deploy/` |

**Who owns which data.** Clover owns names, prices, availability, categories and modifiers;
the dashboard writes those to Clover. This system owns what Clover cannot store:
descriptions, photos, featured items, dietary labels, website visibility. The reasoning is
in `ARCHITECTURE.md`.

## Editing content

| To change | Do this |
|---|---|
| Menu items, prices, availability, categories, modifiers | Dashboard (writes to Clover), or Clover itself |
| Item descriptions, photos, featured items | Dashboard |
| Restaurant name, story, address, hours, phone, gallery, job positions, social links, privacy policy | `content/site.json` and `content/media/`, then redeploy |
| The ORDER ONLINE link | `CLOVER_ORDERING_URL` in the server's `shared/site.env`, then redeploy |
| Colours and fonts | `src/styles/main.css` (see `docs/DESIGN_SYSTEM.md`) |

## What is still needed

`BLOCKERS.md` is the full list, with who has to act on each. In short:

- **To put the information site live:** the Supabase CLI signed in, the owner's email, the
  repository on GitHub, the one-time setup of the Hostinger VPS, and the domain's DNS.
- **For the live menu and the dashboard:** a Clover sandbox run of
  `CLOVER_SANDBOX_TEST_PLAN.md` before any real merchant is connected.
- **For ORDER ONLINE:** the restaurant's Clover Online Ordering link.
- **For online job applications** (the form, the dashboard's Applications section and the
  notification email are built and tested; see `ARCHITECTURE.md`): a privacy policy, a retention period, and a Resend
  account with the domain verified.
- **From the client, when convenient:** photos, approval of the written text, full-time or
  part-time for each role.

## Documentation

| File | Contents |
|---|---|
| `PROJECT_MEMORY.md` | Progress, decisions, test results. Start here when resuming work. |
| `BLOCKERS.md` | What stops launch, and whose move each item is |
| `DEPLOYMENT_CHECKLIST.md` | The order of work for going live, with a box per step |
| `docs/CONFIGURATION.md` | Every setting, per environment, and what refuses to run without it |
| `ARCHITECTURE.md` | Structure, source-of-truth decision, sync, conflicts, API |
| `CLOVER_CAPABILITY_MATRIX.md` | What Clover supports, with sources and test status |
| `CLOVER_INTEGRATION.md` | OAuth, tokens, calls, webhooks, ordering |
| `CLOVER_SANDBOX_TEST_PLAN.md` | The 20 checks to run against a Clover sandbox |
| `SECURITY.md` | Controls, the review, and what is not covered |
| `DEPLOYMENT.md` | Deployment in detail and its known gaps |
| `TESTING.md` | What is tested, how, the measurements, and what is not tested |
| `docs/DESIGN_SYSTEM.md` | Tokens, components, states |

## Licence and third-party material

Fonts (Playfair Display, Open Sauce One) are under the SIL Open Font Licence. The photos in
`content/sample-media/` are template stock images, read only by sample builds. Copies of
eight of them, `content/media/placeholder-*.jpg`, are published on the live site as
placeholders until the restaurant's own photos arrive; their licence for publication was
never checked. See the notices in both folders. On the
server they exist only inside the repository checkout, which Nginx never serves.
