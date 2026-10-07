# Deployment

**Status (2026-10-05): only the two databases are set up.** TEST/STAGING is
`cgxhifkeoesvsycewwfs` (Ireland), for Clover sandbox and integration testing only.
PRODUCTION is `xqzpuqjrlrxyitjubkqk` (us-west-1). Both have the migrations applied and
verified. No functions are deployed anywhere, the website is on no server, and no Clover
app exists. Apart from the database step, **the steps below have not been run**: the server
files in `deploy/` were written from documentation and have never been used on the real
server, so expect to adjust details the first time.

This file explains each step. **`DEPLOYMENT_CHECKLIST.md` is the list to tick off**, in
order, with the test environment before production. `BLOCKERS.md` says what has to exist
before each part can go live, and `docs/CONFIGURATION.md` lists every setting per
environment. The production domain is `luzenarestaurant.com`.

## How it is hosted

Decided by the client on 2026-10-05. Vercel is not used.

```
GitHub (github.com/gooamr88-pixel/luzena, public by the client's decision)
   |  the server pulls a commit, builds it, switches the live folder
   v
Hostinger VPS: Nginx serves the built website files for luzenarestaurant.com
   |  nothing is proxied: the visitor's browser calls the backend directly
   v
Supabase PRODUCTION, N. California: five Edge Functions, Postgres, Storage, Auth
   |  only the Edge Functions hold credentials or talk to Clover
   v
Clover PRODUCTION (only after the sandbox plan has passed)
```

| Part | Where it runs | Deployed with | From |
|---|---|---|---|
| Website and dashboard (static files) | Nginx on the Hostinger VPS | `deploy/deploy.sh`, on the VPS | GitHub |
| Backend (five Edge Functions) | Supabase | `supabase functions deploy ... --project-ref <ref>` | this machine |
| Database | Supabase | `supabase db push` | this machine |
| Test site | this machine, `http://localhost:4173` | `npm run build:staging` | this folder |

Three things follow from this and are worth keeping in mind:

- **The VPS holds no secret.** It has the public Supabase URL and the publishable key, both
  of which are printed in the website anyway. Clover credentials, the token encryption key
  and the email key exist only as Supabase function secrets.
- **The VPS runs none of our code at request time.** It serves files. If it is slow or
  down, the site is; nothing about the menu, the dashboard's data or Clover lives there.
- **TEST and PRODUCTION behave the same**, because the backend is the same five functions
  on Supabase in both.

## 0. What you need

- On this machine: Node 20.19 or newer and the Supabase CLI, signed in (`supabase login`).
- The GitHub repository holding this code. It is public: nothing secret may be committed.
- The Hostinger VPS: a login with `sudo`; Nginx (already there); Node 20.19 or newer, git
  and certbot. Access to the DNS of `luzenarestaurant.com`.
- A Clover developer account, and a Resend account with a verified sending domain, for the
  parts that need them (`BLOCKERS.md`).
- From the client: everything `npm run check:content` lists as REQUIRED.

## 1. Content

1. `content/site.json` already holds the real name, address, phone, hours and text. The
   photos it names are placeholders (`content/media/placeholder-*.jpg`): when the real ones
   arrive, put them in `content/media/` and replace each name (see the README there).
2. Run `npm run check:content`. It must end with "All required content is present."

`npm run build` runs the same check and stops if anything required is missing, or if the
ordering link is a placeholder, or if the application form is switched on without a privacy
policy. That is deliberate: it makes it impossible to publish the sample content.

## 2. Supabase (TEST first, then PRODUCTION)

```bash
supabase db push --db-url "<connection string>"      # applies supabase/migrations/
supabase functions deploy dashboard-api public-menu public-site job-application clover-webhook --project-ref <ref> --use-api
```

There are two projects, so `supabase link` is not used here: it would make one of them the
silent default. Every command names its project.

Then:

1. **Auth settings** (dashboard > Authentication): disable sign-ups; set the Site URL to
   `<site address>/dashboard/`; add the same URL to the redirect allow-list. For TEST the
   site address is `http://localhost:4173`; for PRODUCTION it is
   `https://luzenarestaurant.com`. `supabase/config.toml` carries these values for local
   development; confirm them in the hosted project.
2. **Secrets**: one git-ignored file per environment, `supabase/functions/.env.test` and
   `supabase/functions/.env.production` (template: `.env.example`). Fill in the one for this
   project and run
   `supabase secrets set --env-file supabase/functions/.env.<environment> --project-ref <ref>`.
   `TOKEN_ENCRYPTION_KEY` and `IP_HASH_SALT` are generated freshly per file; never copy
   them between projects.
3. **Create the owner**: Authentication > Users > Add user (the owner's email).
4. **Provision the restaurant**: in `supabase/provision-restaurant.sql`, set `v_owner` to
   the owner's sign-in email (the other three values are already filled in: check them), and
   run it in the SQL editor. `v_slug` must equal `restaurantSlug` in `content/site.json`
   (`luzena`).
5. The owner opens `/dashboard/`, chooses "Forgot your password?", and sets a password from
   the emailed link.

Check: `curl "https://<ref>.supabase.co/functions/v1/public-menu?restaurant=<slug>"` returns
HTTP 503 with "Menu temporarily unavailable" (correct before Clover is connected). A 404
means the slug does not match. `npm run verify:functions` runs this and the rest of the
outside checks on all five functions.

## 3. The test site

There is no public test address. The test site is the real content, built against the TEST
project and served on this machine:

1. `.env.staging.local` (git-ignored) with the TEST project's `VITE_SUPABASE_URL` and
   publishable key.
2. `npm run build:staging`, then `npm run preview:staging`: `http://localhost:4173`.

The TEST project's `ALLOWED_ORIGINS` already lists that address. This is where the real
dashboard first talks to a real backend, and where the Clover sandbox plan is run. `vite
preview` does not send the production response headers; those are covered by the browser
tests and, on the live server, by `npm run verify:site`.

## 4. Clover

Follow `CLOVER_INTEGRATION.md` section 1. Start in the **sandbox** (`CLOVER_ENV=sandbox`)
and work through `CLOVER_SANDBOX_TEST_PLAN.md` before touching a live merchant. Production
needs Clover's approval of the developer account and the app. **No `CLOVER_*` secret goes
into the PRODUCTION project before the sandbox plan has passed.**

Check: in the dashboard, Clover > Connect Clover ends on "Connected", and Items fills with
the merchant's inventory.

## 5. The website on the Hostinger VPS

The exact commands are in `DEPLOYMENT_CHECKLIST.md` sections 5 to 7. What they set up, and
why it is shaped this way:

```
/var/www/luzenarestaurant.com/
  repo/              a clone of the GitHub repository. Never served.
  shared/site.env    the build variables: public values only
  releases/<id>/     one folder of built files per deployment (the last five are kept)
  current            a link to the live release. This is Nginx's root.
  acme/              used by certificate renewal
```

**A user of its own.** A `luzena` user owns that folder and nothing else on the VPS. The
build runs as that user, never as root.

**Read-only access to the code.** The repository is public, so the server clones it over
HTTPS with no key and no GitHub login. A compromised server cannot change the code.

**`deploy/deploy.sh`** (run on the VPS; default `origin/main`, or a commit as its argument):

1. Reads `shared/site.env` and refuses to go on if it names the wrong Supabase project for
   this server (`DEPLOY_ENVIRONMENT`), holds a secret key, or sets `CONTENT_PROFILE` or
   `VITE_DASHBOARD_DEMO`.
2. Fetches the commit, `npm ci`, `npm run build`. The build's own content gate applies.
3. Checks the result: the pages exist, no sample banner, `robots.txt` does not block the
   site, the menu page points at the expected project.
4. Copies it to a new release folder and repoints `current` with a single rename, so no
   visitor ever gets half of one version and half of another. The previous release's
   hashed files are kept alongside for one more release, so a page opened just before the
   deployment can still load its scripts.
5. Anything failing before step 4 leaves the live site exactly as it was.

`deploy.sh --rollback` puts the previous release back; `deploy.sh --list` shows the kept ones.

**The Nginx configuration** (`deploy/nginx/luzenarestaurant.com.conf`) is generated by
`npm run build:nginx` from `deploy/headers.json`, the one list of response headers, which
the browser tests also serve the site with. It is generated because Nginx does not carry
`add_header` lines into a `location` that has any of its own: written by hand, the usual
result is that `/assets/` or `/dashboard/` quietly loses the Content-Security-Policy. A
unit test fails if the committed file is stale or any location lacks a header. It:

- redirects `http://` and `www` to `https://luzenarestaurant.com`;
- serves `current` and nothing else, with `/menu` redirected to `/menu/` and unknown
  addresses answered by the site's own 404 page;
- sends pages `no-cache` (always revalidated, so a deployment is seen at once), hashed
  files cacheable for a year, the dashboard `no-store` and `noindex`;
- answers 404 for anything starting with a dot;
- proxies nothing.

**The old spelling.** The client also owns `luznarestaurant.com`, which points at the same
server and showed an earlier "coming soon" page. By the client's decision it redirects to
the real domain after launch. `npm run build:nginx` writes that file too
(`deploy/nginx/luznarestaurant.com.redirect.conf`); it reuses the certificate that domain
already has on the server. It is installed last, after the real site has been checked
(`DEPLOYMENT_CHECKLIST.md` section 7.1).

**The certificate** is Let's Encrypt, obtained with certbot before the configuration is
enabled (the configuration names the certificate files, so Nginx will not accept it until
they exist).

**After every deployment**, from this machine:

```powershell
$env:SITE_URL = "https://luzenarestaurant.com"
$env:WWW_URL = "https://www.luzenarestaurant.com"
$env:EXPECT_SUPABASE_URL = "https://xqzpuqjrlrxyitjubkqk.supabase.co"
npm run verify:site
```

It checks HTTPS and both redirects, every header in `deploy/headers.json` as actually sent,
robots, the sitemap, each public page, that no dot-file or repository file can be fetched,
the dashboard, that the site names the PRODUCTION project and no other, and that the
backend answers this site's origin and reaches its database.

What the pages should show on the first deployment:

- `/` shows the real content with no "Sample content" banner.
- `/menu/` says "Menu temporarily unavailable" until Clover is connected.
- `/dashboard/` shows the sign-in form.
- `/careers/` lists the roles and says online applications open soon. (The form appears
  only after a privacy policy, a retention period and the email account exist: see
  `BLOCKERS.md` B-3, B-4, B-7. Then send one test application and confirm it arrives.)

## 6. Tighten after launch

- In `deploy/headers.json`, replace `https://*.supabase.co` in the CSP with the production
  project's exact host, run `npm run build:nginx`, deploy, and install the new Nginx file.
- Set `CLOVER_ORDERING_URL` in `shared/site.env` to the restaurant's Clover ordering link
  and deploy again.
- Submit `sitemap.xml` in Google Search Console and claim the Google Business Profile.

## Updating

| Change | What to do |
|---|---|
| Menu items, prices, photos, descriptions | Nothing to deploy. The owner uses the dashboard, or Clover. |
| Restaurant text, hours, address, gallery, positions | Edit `content/site.json`, commit, push to GitHub, run `deploy.sh` on the VPS, `npm run verify:site`. |
| The ordering link | `CLOVER_ORDERING_URL` in `shared/site.env` on the VPS, run `deploy.sh`. No commit. |
| Response headers | `deploy/headers.json`, `npm run build:nginx`, commit, push, `deploy.sh`, then copy the Nginx file to `/etc/nginx/sites-available/`, `sudo nginx -t`, reload. |
| Backend code | `supabase functions deploy <name> --project-ref <ref> --use-api`, TEST first. |
| Database | Add a new migration file. Never edit one that has been applied. `supabase db push`, TEST first. |

## Rolling back

- Site: `deploy.sh --rollback` on the VPS, or `deploy.sh <older commit>`.
- Functions: redeploy the previous commit's functions.
- Database: migrations here only add objects. To undo one, write a new migration that
  reverses it. Take a backup before any migration that changes existing data.

## Environment variables

The reference, with what each one does and what refuses to run without it, is
`docs/CONFIGURATION.md`.

Website build (`deploy/site.env.example` on the server, `.env.example` for the test site):
`DEPLOY_ENVIRONMENT` (server only), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`CLOVER_ORDERING_URL`, optional `VITE_DASHBOARD_DEMO` (sample builds only).

Backend (`supabase/functions/.env.example`): `ALLOWED_ORIGINS`, `CLOVER_ENV`,
`CLOVER_APP_ID`, `CLOVER_APP_SECRET`, `CLOVER_REDIRECT_URI`, `CLOVER_WEBHOOK_AUTH`,
`CLOVER_REQUIRE_STATE`, `TOKEN_ENCRYPTION_KEY`, `MENU_SYNC_TTL_SECONDS`, `IP_HASH_SALT`,
`RESEND_API_KEY`, `EMAIL_FROM`, `JOB_APPLICATIONS_ENABLED`,
`JOB_APPLICATION_RETENTION_DAYS`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
injected by Supabase.

## Known gaps in this procedure

- **The server side has never been run.** `deploy/deploy.sh` has been syntax-checked, and
  its refusals (wrong project, secret key, sample content, missing settings) have been
  exercised on Windows; its build, switch and rollback steps have not run on Linux. The
  Nginx configuration has never been loaded by an Nginx. The VPS itself has not been seen:
  its operating system, Nginx and Node versions, and what else it hosts are unknown. That
  is why the checklist starts with read-only commands whose output is to be sent back.
- `npm ci` on the server installs the development tools as well (they are what builds the
  site), including a Deno download that only the tests use. If the VPS is short of memory
  or disk, the alternative is to build elsewhere and copy only the built files; the script
  would need a small change for that.
- The Edge Functions have been type-checked by Deno and each one has been started under
  Deno and sent requests (`npm run check:deno`), but with no database behind them: they
  have never run against a real Supabase project. Expect the first deploy to the **test**
  project to turn up small things in `supabase/functions/_shared/runtime.ts`, the Supabase
  client wiring, which only a real project exercises.
- The response headers are sent by Nginx, and Nginx is also the only thing between a
  visitor and the files. The rest of the VPS (other sites, users, SSH, firewall, updates)
  is outside this repository and is its owner's responsibility.
- Adding a second restaurant needs a second site build (each build is one restaurant's
  content) pointed at the same Supabase project. The backend is multi-tenant; the static
  site is one tenant per deployment.
