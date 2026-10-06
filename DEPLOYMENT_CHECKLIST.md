# Deployment checklist

**Nothing has been deployed.** This is the order to do it in, with a check after each step.
It has been written carefully but never executed end to end, so the first pass belongs on a
**test** environment. Tick the boxes as you go and note anything that differed.

The backend goes first to **TEST** (the test Supabase project, the test site on this
machine, later the Clover sandbox) and, only after TEST passes, to **PRODUCTION** (the
production Supabase project, and the website on the Hostinger VPS).

**Where things run (decided by the client, 2026-10-05):**

```
GitHub  ->  Hostinger VPS (Nginx, built website files only)
                 |  the visitor's browser calls the backend directly
                 v
            Supabase PRODUCTION, N. California (Edge Functions, database, storage, Auth)
                 |
                 v
            Clover PRODUCTION (only after the sandbox plan has passed)
```

The VPS serves files. It runs no application code and holds no secret. The backend is the
four Supabase Edge Functions, deployed from this machine with the Supabase CLI. Vercel is
not used.

Background: `docs/CONFIGURATION.md` (every setting), `BLOCKERS.md` (what is still needed),
`DEPLOYMENT.md` (longer explanations), `CLOVER_SANDBOX_TEST_PLAN.md`.

---

## 0. Before anything

- [x] `npm install`
- [x] `npm run verify` passes on your machine (lint, types, content, unit and API tests,
      Deno checks, browser tests). It takes a while; do not skip it.
      (2026-10-05: 182 unit/SQL/API, 17 Deno, 194 browser, all passing. Run it again after
      any change.)
- [x] `git status` shows no `.env`, `.env.local` or `supabase/functions/.env*` file other
      than the two `.example` templates. (Checked before the first commit, 2026-10-05.)
- [x] The repository has its first commit (2026-10-05).
- [x] It is pushed to GitHub, `gooamr88-pixel/luzena` (public). The VPS pulls from there.
- [x] `npm run check:content` shows no REQUIRED items.

## 1. Accounts

- [x] Supabase: one project for TEST, one for PRODUCTION, in a US West region (the
      restaurant is in California).
- [x] GitHub: `https://github.com/gooamr88-pixel/luzena`. **Public**, by the client's
      decision (2026-10-06). Everything committed is readable by anyone: never commit a
      secret, and see `PROJECT_MEMORY.md` section 30.
- [ ] The Hostinger VPS: a login that can use `sudo`. Nginx is already on it.
- [ ] Resend: one account.
- [ ] Clover: sandbox developer account (TEST); production developer account, approved by
      Clover (PRODUCTION).
- [ ] Access to the DNS of `luzenarestaurant.com`.

## 2. Supabase

> **The two projects (decided by the client, 2026-10-05):**
>
> | | Project | Region | State |
> |---|---|---|---|
> | **TEST / STAGING** | `cgxhifkeoesvsycewwfs` | eu-west-1 (Ireland) | Five migrations applied; `npm run verify:database` passes 30 of 30. Nothing else yet. Used for all Clover **sandbox** and integration testing. Never holds real data. |
> | **PRODUCTION** | `xqzpuqjrlrxyitjubkqk` | us-west-1 (N. California) | Five migrations applied; `npm run verify:database` passes 30 of 30; `npm run verify:public-access` passes 14 of 15. **Open: sign-ups are still switched on** (Supabase's default). Nothing else deployed. |
>
> **Order for any project, without exception:** (1) `supabase db push`,
> (2) `npm run verify:database` passes, (3) `npm run verify:public-access` passes,
> (4) only then anything else in this section. A pass on one project does not carry over.
>
> **Do not run `supabase link` in this folder.** It makes one project the silent default for
> every later command, and there are two. Name the project on each command instead
> (`--project-ref <ref>` or `--db-url ...`). **Do not run `supabase init`** either: the
> `supabase/` folder already exists and `init` offers to overwrite its configuration.

For each project (`<ref>` is the project reference; every command below names it):

- [ ] `supabase login` has been run once on this machine, by the account that owns the
      projects. Without it, functions cannot be deployed and secrets cannot be set.
- [ ] `supabase db push` applies five migrations:
      `..100_schema`, `..200_functions`, `..300_storage`, `..400_application_retention`,
      `..500_sequence_privileges`.
      (Without `supabase login`, the same works with the database password:
      `supabase db push --db-url "postgresql://postgres.<ref>:<password>@<pooler host>:5432/postgres"`.)
- [ ] **Verify the database is closed.** Run the automated check, which covers everything
      below and also tries each forbidden action as each role:

  ```powershell
  $env:DATABASE_URL = "postgresql://postgres.<ref>:<password>@<pooler host>:5432/postgres"
  npm run verify:database        # must end with "All database checks passed."
  ```

  **Stop here if it does not pass.** Deploy nothing to that project until it does.

  Then the view from outside, with the public key that ships in the website:

  ```powershell
  $env:SUPABASE_URL = "https://<ref>.supabase.co"
  $env:SUPABASE_PUBLIC_KEY = "<publishable key>"
  npm run verify:public-access   # must end with "The public key can do nothing here."
  ```

  It fails until sign-ups are switched off (two items below).

  The database checks by hand, in the SQL editor:

  ```sql
  -- Expect zero rows: every table has row level security.
  select relname from pg_class
  where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;

  -- Expect zero rows: the public roles hold nothing on any table or sequence.
  select c.relname, r.rolname
  from pg_class c cross join (values ('anon'), ('authenticated')) r(rolname)
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'S', 'v')
    and has_table_privilege(r.rolname, c.oid, 'select');

  -- Expect zero rows: no policy grants the public roles anything.
  select tablename, policyname from pg_policies where schemaname = 'public';

  -- Expect zero rows: the public roles may execute no function.
  select p.proname from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and (has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute'));

  -- Expect two buckets: cvs (public = false) and menu-images (public = true).
  select id, public, file_size_limit from storage.buckets order by id;
  ```

- [ ] From a terminal, with the project's **anon** key, confirm it can do nothing:

  ```bash
  curl -s "https://<ref>.supabase.co/rest/v1/menu_items?select=*" -H "apikey: <anon key>"
  curl -s -X POST "https://<ref>.supabase.co/rest/v1/rpc/clover_connection_secret" \
       -H "apikey: <anon key>" -H "content-type: application/json" -d '{"p_restaurant":"00000000-0000-0000-0000-000000000000"}'
  ```

  Both must answer with a permission error, never with data.

- [ ] Authentication > Providers > Email: sign-ups **disabled**; minimum password length 12.
- [ ] Authentication > URL configuration: Site URL `https://<site>/dashboard/`; the same
      address in the redirect allow-list.
- [ ] Authentication > Email: a custom SMTP sender (Resend works) so password-reset emails
      are delivered reliably. Supabase's built-in sender is rate limited.
- [ ] Deploy the functions (`--use-api` bundles on Supabase's side; this machine has no
      Docker):
      `supabase functions deploy dashboard-api public-menu job-application clover-webhook --project-ref <ref> --use-api`
- [ ] Set the secrets from this environment's own file. There is one file per environment,
      both git-ignored and both already created with a fresh `TOKEN_ENCRYPTION_KEY` and
      `IP_HASH_SALT` each (2026-10-05):
      `supabase/functions/.env.test` for TEST, `supabase/functions/.env.production` for
      PRODUCTION. Add what is still missing (`docs/CONFIGURATION.md` section 7), then
      `supabase secrets set --env-file supabase/functions/.env.<environment> --project-ref <ref>`.
      Read the file name and the ref twice before pressing Enter: they must be the same
      environment.
      Leave `JOB_APPLICATIONS_ENABLED` and `JOB_APPLICATION_RETENTION_DAYS` out of
      PRODUCTION until `BLOCKERS.md` B-3 and B-4 are closed, and every `CLOVER_*` value out
      of PRODUCTION until the sandbox plan has passed.
- [ ] Authentication > Users > Add user: the owner's email, `fadi.auchi@gmail.com`
      (supplied by the client 2026-10-06; the same address receives job applications).
- [ ] Check the four values in `supabase/provision-restaurant.sql` (slug `luzena`, name,
      recruitment address and owner, both `fadi.auchi@gmail.com`), and run it:
      `supabase db query --project-ref <ref> -f supabase/provision-restaurant.sql`.

**Check.** The automated one first; it covers the three below and more, and is the first
check in which the functions have a real database behind them:

```powershell
$env:SUPABASE_URL = "https://<ref>.supabase.co"
$env:ALLOWED_ORIGIN = "<one origin from that project's ALLOWED_ORIGINS>"
npm run verify:functions       # must end with "All function checks passed."
```

With `SUPABASE_PUBLIC_KEY`, `OWNER_EMAIL` and `OWNER_PASSWORD` also set, it signs in as the
owner and reads every dashboard screen. Use a throwaway owner for this on TEST.

By hand:

- [ ] `curl -i "https://<ref>.supabase.co/functions/v1/public-menu?restaurant=luzena"`
      answers **503** "Menu temporarily unavailable" (right, before Clover is connected).
      404 means the slug does not match. A 500 or a stack trace is a bug: stop.
- [ ] `curl -i "https://<ref>.supabase.co/functions/v1/dashboard-api/me"` answers **401**.
- [ ] `curl -i -X POST "https://<ref>.supabase.co/functions/v1/job-application"` answers **403**.

## 3. The test site (this machine, against the TEST project)

There is no public test address. The test site is a production-content build served on this
machine, which the TEST project already allows (`http://localhost:4173`).

- [ ] Create `.env.staging.local` in this folder (git-ignored) with the TEST project's two
      **public** values:

  ```
  VITE_SUPABASE_URL=https://cgxhifkeoesvsycewwfs.supabase.co
  VITE_SUPABASE_ANON_KEY=<the TEST project's publishable key>
  ```

- [ ] `npm run build:staging`, then `npm run preview:staging` (leave it running).
- [ ] Supabase TEST > Authentication > URL configuration: Site URL and redirect allow-list
      `http://localhost:4173/dashboard/`.

**Check:**

- [ ] `http://localhost:4173/dashboard/`: sign in as the test owner. The Overview loads and
      shows "Clover is not connected". Every screen opens without an error.
- [ ] `http://localhost:4173/menu/` says the menu is temporarily unavailable (right, before
      Clover is connected) and the browser console shows no blocked request.

## 4. Resend

- [ ] Add the domain `luzenarestaurant.com`; create the DNS records Resend shows (SPF, DKIM,
      and the return-path record); wait for "Verified".
- [ ] Create an API key with sending access only. Put it in `RESEND_API_KEY`.
- [ ] `EMAIL_FROM=Luzena Careers <careers@luzenarestaurant.com>`.

**Check:** send one message from the Resend dashboard to `fadi.auchi@gmail.com`; it arrives
and is not in spam.

## 5. The server: Hostinger VPS, one-time setup

**Only after TEST has passed and the PRODUCTION Supabase steps in section 2 are done.**

Every command in sections 5 to 7 is run **on the VPS, by the client**, over SSH. They were
written from documentation and have **never been run on this server**: nothing about it
has been seen. Do 5.1 first and send the output back before going further, so that anything
that differs on this server is found before something is changed. Nothing here touches the
other sites on the VPS: it adds one user, one folder and one Nginx site file.

### 5.1 Look first (changes nothing)

```bash
nginx -v; node -v; npm -v; git --version; certbot --version
ls /etc/nginx/sites-enabled/ /etc/nginx/conf.d/
grep -rhn "server_name" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null
df -h /var/www; free -m; cat /etc/os-release | head -n 2
```

**Seen on 2026-10-06** (the client ran the above on the VPS, `187.77.1.72`): Ubuntu
24.04.4, Nginx 1.24.0, Node 20.20.2, npm 11.18.0, git 2.43.0, certbot 2.9.0; ample disk and
memory. Other sites are enabled on it, among them `luznarestaurant.com` (the old spelling:
a "Grilli - Coming Soon" Next.js page, live). The `grep` printed nothing because `-r` does
not follow the links in `sites-enabled`; the second look below uses `-R`.

- [x] Node is **20.19 or newer** (20.20.2).
- [x] `git` and `certbot` are there. Enough free memory and disk.
- [ ] No existing site already answers for `luzenarestaurant.com`, and none listens in a
      way that clashes. **Second look (changes nothing), output to be sent back:**

  ```bash
  grep -RhnE "^\s*(server_name|listen|root|proxy_pass)\b" /etc/nginx/sites-enabled/
  cat /etc/nginx/sites-enabled/luznarestaurant.com /etc/nginx/sites-enabled/reject-all
  ls -la /etc/nginx/sites-enabled/ /var/www/
  ls /etc/letsencrypt/live/; certbot plugins 2>/dev/null | grep -iE "^\* "
  ```

Send the output back privately, not into this repository: it shows the server's other
sites.

### 5.2 A user and a folder for this site only

```bash
sudo adduser --disabled-password --gecos "" luzena
sudo mkdir -p /var/www/luzenarestaurant.com/{releases,shared,acme}
sudo chown -R luzena:luzena /var/www/luzenarestaurant.com
```

### 5.3 Get the code from GitHub

The repository is public, so the server needs no key and no GitHub login to read it, and
has no way to write to it.

```bash
sudo -u luzena git clone https://github.com/gooamr88-pixel/luzena.git /var/www/luzenarestaurant.com/repo
```

(If the repository is ever made private: create an SSH key for the `luzena` user, add its
public half on GitHub as a **deploy key without write access**, and change the clone
address to `git@github.com:gooamr88-pixel/luzena.git`.)

### 5.4 The build variables

```bash
cd /var/www/luzenarestaurant.com
sudo -u luzena cp repo/deploy/site.env.example shared/site.env
sudo -u luzena nano shared/site.env
```

- [ ] `DEPLOY_ENVIRONMENT=production`.
- [ ] `VITE_SUPABASE_URL=https://xqzpuqjrlrxyitjubkqk.supabase.co` (already in the template).
- [ ] `VITE_SUPABASE_ANON_KEY=` the PRODUCTION project's **publishable** key
      (`sb_publishable_...`). Never the secret key: this value is published.
- [ ] `CLOVER_ORDERING_URL=` left empty until the restaurant supplies the link.
- [ ] Nothing else in the file. No `CONTENT_PROFILE`, no `VITE_DASHBOARD_DEMO`, no secret.

## 6. Domain, DNS and certificate

- [ ] DNS for `luzenarestaurant.com`: change the `A` record of the bare domain (`@`) to the
      VPS, `187.77.1.72`. On 2026-10-06 it still points at Hostinger's parking page
      (`2.57.91.91`). `www` is a `CNAME` to the bare domain and can stay as it is. Remove
      any other `A` or `AAAA` record for those two names. An `AAAA` record to the VPS's
      IPv6 address (`2a02:4780:2d:4302::1`) is optional; if you add one, add it for both.
- [ ] Wait until both names answer with the VPS's address:
      `dig +short luzenarestaurant.com www.luzenarestaurant.com`
- [ ] The certificate, for both names (it needs the DNS above to be in place):

  ```bash
  sudo certbot certonly --nginx -d luzenarestaurant.com -d www.luzenarestaurant.com
  ```

- [ ] The site's Nginx configuration. It is generated in the repository
      (`deploy/nginx/`); do not edit it on the server.

  ```bash
  sudo cp /var/www/luzenarestaurant.com/repo/deploy/nginx/luzenarestaurant.com.conf /etc/nginx/sites-available/
  sudo ln -s /etc/nginx/sites-available/luzenarestaurant.com.conf /etc/nginx/sites-enabled/
  sudo nginx -t
  ```

- [ ] `nginx -t` says "syntax is ok" and "test is successful". **If it does not, do not
      reload**: remove the link in `sites-enabled` again and send the message back.
- [ ] `sudo systemctl reload nginx`
- [ ] `sudo certbot renew --dry-run` succeeds.

## 7. Deploying the website

On the VPS:

```bash
sudo -u luzena bash /var/www/luzenarestaurant.com/repo/deploy/deploy.sh
```

It pulls `main` from GitHub, builds it, checks the result and makes it live in one step. It
refuses to publish a build that carries the sample banner, that blocks search engines, or
that points at any Supabase project other than PRODUCTION. If it stops, the live site is
unchanged and the last line says why.

- [ ] The script ends with "... is live."
- [ ] Supabase PRODUCTION secret `ALLOWED_ORIGINS` is
      `https://luzenarestaurant.com,https://www.luzenarestaurant.com` (it is, in
      `supabase/functions/.env.production`).
- [ ] Supabase PRODUCTION Auth Site URL and redirect allow-list:
      `https://luzenarestaurant.com/dashboard/`.

**Check, from this machine.** It covers HTTPS, the redirects, every response header,
robots, the sitemap, each public page, the dashboard, and that the site names the
PRODUCTION project and no other:

```powershell
$env:SITE_URL = "https://luzenarestaurant.com"
$env:WWW_URL = "https://www.luzenarestaurant.com"
$env:EXPECT_SUPABASE_URL = "https://xqzpuqjrlrxyitjubkqk.supabase.co"
npm run verify:site            # must end with "All site checks passed."
```

- [ ] `npm run verify:site` passes.
- [ ] By eye: no "Sample" banner anywhere; `/menu/` says the menu is temporarily
      unavailable; ORDER ONLINE opens the on-site "ordering opens soon" page; `/careers/`
      lists the roles with no form.

**Every later deployment:** push to GitHub, run the same one command on the VPS, run
`npm run verify:site`. If `deploy/headers.json` changed, also copy the regenerated Nginx
file again, `sudo nginx -t`, reload.

## 8. Owner sign-in

- [ ] Open `https://luzenarestaurant.com/dashboard/`, choose "Forgot your password?", enter
      the owner's email, follow the emailed link, set a password of 12 or more characters.
- [ ] Sign in. The Overview loads and shows "Clover is not connected".

## 9. Clover

TEST: follow `CLOVER_SANDBOX_TEST_PLAN.md` completely. Do not continue to PRODUCTION until
it passes.

PRODUCTION:

- [ ] Clover has approved the production developer account and the app.
- [ ] App settings: permissions *Read inventory*, *Write inventory* (and *Read merchant* if
      wanted); **Site URL** `https://luzenarestaurant.com/dashboard/`.
- [ ] Secrets: `CLOVER_ENV=na`, `CLOVER_APP_ID`, `CLOVER_APP_SECRET`,
      `CLOVER_REDIRECT_URI=https://luzenarestaurant.com/dashboard/` (identical to the Site
      URL, trailing slash included), `CLOVER_REQUIRE_STATE` as the sandbox proved.
- [ ] Webhook URL: `https://<ref>.supabase.co/functions/v1/clover-webhook`. Send the
      verification code, read it from the `clover-webhook` function log (event
      `clover_webhook_verification`), verify, put the `X-Clover-Auth` value in
      `CLOVER_WEBHOOK_AUTH`, subscribe to Inventory events, re-run `supabase secrets set`.
- [ ] In the dashboard: Clover > Connect Clover > approve.

**Check:** Connected; Items lists the real inventory; the public Menu page shows it.

## 10. Ordering link

- [ ] When the restaurant supplies its Clover Online Ordering address, set
      `CLOVER_ORDERING_URL` in `/var/www/luzenarestaurant.com/shared/site.env` on the VPS
      and run the deploy script again.

**Check:** ORDER ONLINE on the home page opens the restaurant's own Clover ordering page,
and `npm run verify:site` passes with `EXPECT_ORDERING_URL` set to that address.

## 11. Job applications (only after B-3 and B-4 in BLOCKERS.md)

- [ ] Privacy policy published: `legal.privacyPolicyUrl` or `legal.privacy.sections` in
      `content/site.json`.
- [ ] `JOB_APPLICATION_RETENTION_DAYS` = the confirmed number. It matches the policy.
- [ ] `JOB_APPLICATIONS_ENABLED=true`; `supabase secrets set`.
- [ ] `careers.applications.enabled: true` in `content/site.json`; commit; redeploy.

**Check:**

- [ ] Send one application with a PDF. The page confirms it; the email arrives at
      `fadi.auchi@gmail.com` with the CV attached and Reply-To set to the applicant.
- [ ] Try a `.exe` renamed to `.pdf`: refused.
- [ ] In Supabase, `job_applications` has the row with `email_status = sent`; the `cvs`
      bucket is **private** (opening the file's public URL fails).

Optional, if deletion must happen on a fixed schedule: enable `pg_cron` and `pg_net`, store
a long random token as a database setting and as a function secret, add a small Edge
Function that checks the token and calls the retention clean-up, and schedule a daily call
to it. This is not built; today the clean-up runs when an application arrives and when an
owner opens the dashboard.

## 12. After go-live

- [ ] Walk every public page on a phone and on a laptop.
- [ ] Tap the phone number, the directions link and Instagram on a real phone.
- [ ] Edit one menu item's description in the dashboard; it appears on the site.
- [ ] Change one price in Clover; within five minutes it appears on the site.
- [ ] Run Lighthouse on `/` and `/menu/`.
- [ ] Google Search Console: add the property, submit `/sitemap.xml`.
- [ ] Google Business Profile: set the website to `https://luzenarestaurant.com`.
- [ ] Test the home page in Google's Rich Results Test (Restaurant data).
- [ ] In `deploy/headers.json`, replace `https://*.supabase.co` with the production
      project's exact host (twice), `npm run build:nginx`, commit, push, deploy, copy the
      Nginx file again, `sudo nginx -t`, reload, `npm run verify:site`.
- [ ] Check that the certificate renews by itself: `sudo systemctl list-timers | grep certbot`.
- [ ] Put a reminder in the calendar to check `sync_runs` for failures in a week.

## Rolling back

| What | How |
|---|---|
| Site | On the VPS: `sudo -u luzena bash /var/www/luzenarestaurant.com/repo/deploy/deploy.sh --rollback` puts the previous release back at once (`--list` shows what is kept: the last five). To publish a specific older commit: the same script with that commit as its argument. |
| Nginx configuration | Copy the previous version of `deploy/nginx/luzenarestaurant.com.conf` back, `sudo nginx -t`, reload. To take the site off the server entirely: remove its link in `/etc/nginx/sites-enabled/`, `sudo nginx -t`, reload. |
| Functions | Check out the previous commit, `supabase functions deploy ...` |
| Database | Migrations only add objects. To undo one, write a new migration that reverses it. Back up before any migration that changes existing rows. |
| Clover connection | Dashboard > Clover > Disconnect. The site keeps showing the last synced menu. |
| Job applications | Unset `JOB_APPLICATIONS_ENABLED`. The form then answers "not open yet" immediately. |

## Never

- Never put a secret in a `VITE_` variable or in `content/site.json`.
- Never set `CONTENT_PROFILE=sample` or `VITE_DASHBOARD_DEMO` on the server.
- Never put a secret on the VPS. `shared/site.env` holds public values only.
- Never point Nginx's `root` at the repository checkout. It is `.../current`, the built
  release, and nothing else.
- Never edit the Nginx file on the server. Change `deploy/headers.json`, regenerate, copy.
- Never deploy to Vercel or any other host: the site lives on the Hostinger VPS only.
- Never reuse `TOKEN_ENCRYPTION_KEY` between test and production.
- Never point the test site at the production Supabase project.
- Never edit a migration that has been applied; add a new one.
