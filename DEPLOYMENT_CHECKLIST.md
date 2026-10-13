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
five Supabase Edge Functions, deployed from this machine with the Supabase CLI. Vercel is
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
> | **TEST / STAGING** | `cgxhifkeoesvsycewwfs` | eu-west-1 (Ireland) | Five migrations applied; `npm run verify:database` passes 30 of 30. **2026-10-06:** the four functions deployed, secrets set, the owner created and the restaurant provisioned; `npm run verify:functions` passes 15 of 15 and `npm run verify:public-access` 15 of 15. **Open: the Auth settings** (the corrected `config.toml` has to be applied; until then email sign-in is off there) and, after that, the signed-in checks. Used for all Clover **sandbox** and integration testing. Never holds real data. |
> | **PRODUCTION** | `xqzpuqjrlrxyitjubkqk` | us-west-1 (N. California) | Five migrations applied; `npm run verify:database` passes 30 of 30. **2026-10-06, on the client's instruction to proceed:** sign-ups are off and `npm run verify:public-access` passes 15 of 15 (before and after); the four functions deployed; secrets set (allowed origins, sync interval, encryption key, salt: **no Clover value and no job-application value**); the owner created and the restaurant provisioned; `npm run verify:functions` passes 15 of 15. **Open:** minimum password length 12 and the site address in Auth (dashboard, by the client); the website itself (sections 5 to 7). |
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
- [ ] `supabase db push` applies six migrations:
      `..100_schema`, `..200_functions`, `..300_storage`, `..400_application_retention`,
      `..500_sequence_privileges`, `..600_imported_items_start_hidden`.
      **Both projects have all six since 2026-10-06.** The sixth must be on a project
      before a Clover merchant is connected to it: without it, connecting publishes the
      merchant's whole inventory on the website at once.
      With the CLI signed in, no database password is needed:
      `supabase db push --dry-run --linked --project-ref <ref>` shows what would be applied
      (read it), and the same without `--dry-run` applies it. TEST first.
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

- [ ] **Auth settings.** They are written in `supabase/config.toml` (sign-ups off, the
      email provider ON, minimum password length 12, and each project's own site address
      under `[remotes.*]`) and applied with:

  ```
  supabase config push --project-ref <ref>
  ```

  **Read this before running it.** It prints the difference between the project and the
  file, then asks "Do you want to push auth config to remote? [Y/n]". **Yes is the
  default, and it is also what happens when nothing answers the prompt: there is no dry
  run.** It replaces the project's whole Auth configuration, using the CLI's defaults for
  anything the file leaves out. Run it yourself in a terminal, read the difference, and
  answer `n` if any line is not one you expect. Never run it with `--yes`, and never run
  it to "see what it would do".

  The same settings by hand, in the dashboard: Authentication > Sign In / Providers:
  "Allow new users to sign up" **off**, the Email provider **on**, minimum password length
  12; Authentication > URL configuration: Site URL `<site>/dashboard/`, and the same
  address in the redirect allow-list.
- [ ] Check it from outside: `npm run verify:public-access` ends with "The public key can
      do nothing here", **and** a sign-in attempt with a wrong password answers "Invalid
      login credentials", not "Email logins are disabled". The second is the trap: the
      email provider's switch is called `enable_signup` in `config.toml`, and with it off
      nobody can sign in at all, the owner included.
- [ ] Authentication > Email: a custom SMTP sender (Resend works) so password-reset emails
      are delivered reliably. Supabase's built-in sender is rate limited, and delivers only
      to members of the Supabase organisation: **required before anyone is invited from
      the dashboard's Team page** (section 11a), because an invited person sets their
      password through such an email.
- [ ] Deploy the functions (`--use-api` bundles on Supabase's side; this machine has no
      Docker):
      `supabase functions deploy dashboard-api public-menu public-site job-application clover-webhook --project-ref <ref> --use-api`
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
      `supabase db query --linked --project-ref <ref> -f supabase/provision-restaurant.sql`.
      (`--linked` here only means "a hosted project, through the Supabase API"; with
      `--project-ref` given it uses that project and creates no link.)

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
- [x] No existing site already answers for `luzenarestaurant.com`, and none listens in a
      way that clashes. Checked 2026-10-06 with a second read-only look
      (`grep -RhnE "^\s*(server_name|listen|root|proxy_pass)\b" /etc/nginx/sites-enabled/`,
      the old domain's site file, the folder listings, `certbot plugins`). What it showed
      that matters here:
  - Every site listens on the shared ports 80 and 443 by name, as the new file does. A
    default server refuses any name that no site claims, so the new site answers only
    once its own file is enabled.
  - `/var/www/luzenarestaurant.com` does not exist yet. The old build lives in
    `/var/www/luzna`, a different folder: do not confuse the two.
  - The old domain has its own certificate, `/etc/letsencrypt/live/luznarestaurant.com/`,
    covering the bare name and `www`. The redirect in section 7.1 uses it.
  - certbot has its `nginx` plugin, which the certificate command in section 6 needs.

Output from the server is sent back privately, never committed: it shows the server's
other sites.

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

### 7.1 The old spelling redirects (decided by the client, 2026-10-06)

`luznarestaurant.com`, without the "e", points at the same server and shows the earlier
"coming soon" page. **Only after `npm run verify:site` passes on the real domain**, swap
its site file for the redirect. The names differ by one letter: read each line before
running it.

```bash
sudo cp /var/www/luzenarestaurant.com/repo/deploy/nginx/luznarestaurant.com.redirect.conf /etc/nginx/sites-available/
sudo rm /etc/nginx/sites-enabled/luznarestaurant.com
sudo ln -s /etc/nginx/sites-available/luznarestaurant.com.redirect.conf /etc/nginx/sites-enabled/
sudo nginx -t
```

- [ ] `nginx -t` is successful, then `sudo systemctl reload nginx`. **If it is not, do not
      reload**, and send the message back. To undo: remove the new link in `sites-enabled`
      and link the old file from `sites-available` again. (The undo is described and not
      given as commands on purpose. On 2026-10-06 the commands were pasted together with
      the undo lines that followed them, which left `sites-enabled` holding a link to the
      old file; that file was then deleted, and a link to a missing file stops Nginx from
      starting at all, for every site on the server. It was caught before any reload.)
- [ ] After any change in `sites-enabled`: `ls -la /etc/nginx/sites-enabled/` shows no link
      to a missing file, and `nginx -t` is successful.

- [x] `https://luznarestaurant.com/`, `https://www.luznarestaurant.com/menu/` and
      `http://luznarestaurant.com/coming-soon` each end on `https://luzenarestaurant.com`.
      (Checked from outside, 2026-10-06, after the client installed the redirect.)
- [ ] `sudo certbot renew --dry-run` still succeeds for both domains.

The `rm` removes only the link; the old site file stays in `sites-available`, so the same
two lines put the old page back at any time. The old application itself (in
`/var/www/luzna`, and the process that runs it) is no longer reached by anyone after this.
Stopping and removing it is the client's choice; nothing here does it.

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

- [ ] Migration `20261006000700_job_application_workflow.sql` applied (TEST first, then
      PRODUCTION): `supabase db push`, then `npm run verify:database` (21 tables).
- [ ] Functions redeployed: `job-application` and `dashboard-api` both changed.
- [ ] Privacy policy published: `legal.privacyPolicyUrl` or `legal.privacy.sections` in
      `content/site.json`. It covers what the form now asks: contact details, availability,
      experience, authorization to work in the United States, an optional CV.
- [ ] `JOB_APPLICATION_RETENTION_DAYS` = the confirmed number. It matches the policy.
- [ ] `JOB_APPLICATIONS_ENABLED=true`; `supabase secrets set`.
- [ ] `careers.applications.enabled: true` in `content/site.json`; commit; redeploy.
- [ ] For the notification email: `RESEND_API_KEY` and `EMAIL_FROM` set (B-7). Without them
      applications still arrive in the dashboard, each marked as not notified.

**Check:**

- [ ] Send one application with a PDF. The page confirms it.
- [ ] Sign in to the dashboard: the application is under **Applications**, with a "1" beside
      the link in the sidebar. Open it: every answer is there. Download the CV: it is the
      file that was sent. Change the status with a note: both appear in its history.
- [ ] The email arrives at the recruitment address (the `recruitment_email` of the
      restaurant's row), subject "New Job Application — name — position", Reply-To set to
      the applicant, **no attachment**. Its button opens that application after signing in.
- [ ] Try a `.exe` renamed to `.pdf`: refused.
- [ ] In Supabase, `job_applications` has the row with `email_status = sent`; the `cvs`
      bucket is **private** (opening the file's public URL fails).
- [ ] View the source of the home, Contact, Locations and Careers pages: no email address.

Deletion on a fixed schedule is built since 2026-10-13: the daily schedule of section 11b
runs it every day, whether or not anyone visits.

## 11a. Team access and the export of applications (built 2026-10-13; on TEST, see 11b)

**Done on TEST on 2026-10-13, together with 11b**, by scripts run from this machine with
the client's access token (the migration applied through the Management API and recorded
in the migration ledger as `supabase db push` records it; the functions deployed with the
CLI). What follows is the manual check list; the steps that were run are ticked in 11b.

One migration, the `dashboard-api` function, and the website (the dashboard is part of it).
No new secret and no new environment variable. **TEST first, all of it, then PRODUCTION.**

Before anything, on each project:

- [ ] **Authentication > Email: a custom SMTP sender is set** (section 2). This is no
      longer optional. An invited person chooses their password through a link Supabase
      Auth emails them, and Supabase's built-in sender only delivers to members of the
      Supabase organisation. Without it, someone who is invited and misses the one-click
      link in their invitation gets no email at all, and nothing says so.
- [ ] `RESEND_API_KEY` and `EMAIL_FROM` are set (section 4): the invitation itself is sent
      through Resend. Without them an invitation is saved and marked "email not sent".
- [ ] `ALLOWED_ORIGINS` is right: the link in an invitation is built from it.
- [ ] "Allow new users to sign up" is still **off**. Nothing here needs it on.

The order, on TEST and then on PRODUCTION:

- [ ] `supabase db push --dry-run`: it must name exactly
      `20261013001400_team_access_and_application_export.sql` and nothing else. Then
      `supabase db push`.
- [ ] `npm run verify:database` (needs `DATABASE_URL`): every check passes; **22 tables**;
      "every restaurant still has an owner"; the line `team now:` shows the members and how
      many have no address yet (it is filled in when each next opens the dashboard).
- [ ] `supabase functions deploy dashboard-api --project-ref <ref> --use-api`. Only this
      function changed.
- [ ] `npm run verify:functions`: every check passes, including "refuses the team, an
      export and an invitation without a session".
- [ ] Only now the website: push, then `deploy.sh` on the VPS.

**The backend must go first.** The migration only adds things and replaces
`dash_applications_list` with a version that answers exactly as before, so the dashboard
that is live keeps working against it. The new dashboard against the old backend would
call routes that do not exist.

**Check, signed in as the owner, on TEST before PRODUCTION:**

- [ ] The sidebar has **Team**. The page lists the owner, marked "You", as Owner.
- [ ] Invite an address you control as Manager. The email arrives from the `EMAIL_FROM`
      address, names the restaurant and the role, and has a "Choose your password" button.
- [ ] In a private window, follow that button within the hour: the dashboard asks for a new
      password. Set one, sign in: "You have been invited" is shown. Accept: the dashboard
      opens, with no Team link, no Export button, and Clover showing no Connect/Disconnect.
- [ ] Do it again for another address, but this time ignore the button: open the dashboard,
      choose "Forgot your password?", and confirm **the email from Supabase arrives**. This
      is the check that the SMTP sender works for people outside the organisation.
- [ ] Back as the owner: change the manager to Staff. In the manager's window, press
      anything: the page says access has changed and the Applications link is gone.
- [ ] Remove their access. In their window, press anything: "This account has no access to
      a dashboard".
- [ ] Invite someone, then cancel the invitation; signing in with that address afterwards
      shows no invitation.
- [ ] Applications > **Export**: the dialog says how many will be exported; the file opens
      in Excel **with no "We found a problem with some content" message**, has the summary
      row, filter buttons on the headings, and the headings stay in view while scrolling.
      This is the one check no test here could make: no spreadsheet program was available
      where the code was written.
- [ ] The same export as CSV opens in Excel with accented and Arabic names readable.
- [ ] Activity shows "Team member invited", "Job applications exported" and the rest.

To undo: the website with `deploy.sh --rollback`; the function by deploying the previous
commit. The migration can stay: it adds a table, four columns and functions that the
previous code does not use, and the one function it replaces answers as before. To take
access away from everyone invited, without undoing anything:
`delete from public.restaurant_users where role <> 'owner';`
To take the migration itself back: section 11b, "Rolling back".

## 11b. Messages to applicants, the monthly report, the daily schedule, Brevo (built 2026-10-13; backend live on TEST and PRODUCTION)

One more migration (`20261014001500_applicant_messages_and_monthly_reports.sql`), a sixth
function (`scheduled-tasks`), two new function secrets (`BREVO_API_KEY`, `CRON_SECRET`),
the schedule (`supabase/schedule-daily-tasks.sql`, run by hand), and the website.

**On TEST, 2026-10-13 (done, in this order):**

- [x] Both migrations applied, 1400 then 1500, each in one transaction with its ledger row.
- [x] The rollback files (`supabase/rollback/`) run, 1500 then 1400: TEST's schema was then
      identical to PRODUCTION's (tables, columns, constraints, indexes, functions and their
      bodies, rights; the one difference, `rls_auto_enable`, is an event trigger Supabase
      put on TEST only). Both migrations applied again: TEST identical to before.
- [x] The database checks of `verify:database`, made through the Management API: all pass,
      24 tables.
- [x] `CRON_SECRET` set (48 random characters, TEST's own); the six functions deployed with
      `supabase functions deploy ... --project-ref <test> --use-api`.
- [x] `npm run verify:functions`: all pass (two skipped by design: the public-key check needs
      `SUPABASE_PUBLIC_KEY`; the form is open on TEST).
- [x] The schedule created from `schedule-daily-tasks.sql`; seen to run twice (set to every
      minute for two minutes): pg_cron `succeeded`, the function answered 200 both times;
      put back to daily, 13:15 UTC.
- [x] The end-to-end run: 65 of 65 (`TESTING.md`).
- [x] `BREVO_API_KEY` and `EMAIL_FROM` set (the evening of 2026-10-13, after the client fixed
      the key). TEST's restaurant first pointed at tagged test addresses
      (`luznarestocafe+test-recruitment@gmail.com`, `+test-report@`), so that nothing from
      TEST reaches the owner.
- [x] Real email on TEST (`scratchpad/e2e-email.mjs`, not in Git): a notification, a
      message to the applicant, a status email, an invitation and the monthly report, each
      to a tagged address of `luznarestocafe@gmail.com`, each reported **delivered** by Brevo's
      own events; the dashboard then showed both messages as Delivered; the scheduled job
      called twice sent the report once. 15 of 15.

**On PRODUCTION, 2026-10-13 (done, after TEST had passed whole):**

- [x] A copy of the rows the migrations touch taken first (restaurants, memberships).
- [x] Both migrations applied; the database checks 15 of 15 (24 tables); the 17
      applications and the owner untouched; the owner's address filled in by the migration.
- [x] PRODUCTION's own `CRON_SECRET`; the six functions deployed (`scheduled-tasks` new).
- [x] `npm run verify:functions` with `ALLOWED_ORIGIN=https://luzenarestaurant.com`: all
      pass (two skipped by design).
- [x] The schedule created; one scheduled run seen to succeed (200); back to daily.
- [x] The Data API serves `public` and `graphql_public` only, on both projects.
- [ ] **The website**: the commit is pushed; `deploy.sh` on the VPS is the client's step
      (section 7). Until it runs, the live dashboard is the previous one, which works
      unchanged against the new backend.
- [x] `BREVO_API_KEY` and `EMAIL_FROM` set, after the real-email run on TEST had passed;
      `verify:functions` run again: all pass. From now on PRODUCTION sends: a new
      application's notification to the recruitment address, messages and status emails,
      invitations, and the monthly report. **The first report (September 2026) goes at the
      next daily run, 13:15 UTC on 2026-10-14, to the recruitment address** (`report_email` is
      empty). Check it afterwards in `monthly_reports` and in Brevo's logs.
- [ ] Not run on PRODUCTION, on purpose: the end-to-end runs (they make data and would
      email the owner).

**Once Brevo works (B-10), on TEST first, then PRODUCTION:**

- [ ] `supabase secrets set BREVO_API_KEY=... EMAIL_FROM="Luzena Restaurant & Cafe <address>" --project-ref <ref>`
      (the address verified in Brevo). Nothing else changes: the functions pick the key up.
- [ ] Apply for a job on the website with an address you control. The notification
      reaches the recruitment inbox; the application shows no "not sent" mark.
- [ ] Open it in the dashboard, write to the applicant ("Start from: We have received your
      application"), send. It shows **Sent**. The email arrives, from the restaurant's
      name, with your words, and "Reply" goes to the recruitment inbox. Open the
      application again a minute later: it shows **Delivered**, which is Brevo's own report
      (Brevo: Transactional > Logs shows the same message).
- [ ] Write to an address that does not exist (an application made for it): it shows
      **Not delivered** with Brevo's reason, once Brevo has reported the bounce.
- [ ] Invite an address you control: the invitation arrives with its "Choose your password"
      button (B-8 still applies to the password email Supabase sends by itself).
- [ ] The monthly report: on TEST, `delete from public.monthly_reports;` then call the
      function by hand: `select net.http_post(url := (select decrypted_secret from
      vault.decrypted_secrets where name = 'scheduled_tasks_url'), headers :=
      jsonb_build_object('content-type', 'application/json', 'x-cron-secret', (select
      decrypted_secret from vault.decrypted_secrets where name = 'scheduled_tasks_secret')),
      body := '{}'::jsonb);` The report for last month arrives at the report address; the
      row in `monthly_reports` says `sent`; calling again sends nothing (`skipped`). On
      PRODUCTION, simply wait for the next daily run.
- [ ] If the report should go somewhere other than the recruitment address:
      `update public.restaurants set report_email = '<address>' where slug = 'luzena';`
      If the restaurant's months are not on Pacific time:
      `update public.restaurants set timezone = '<IANA zone>' where slug = 'luzena';`

**Watching it:** `cron.job_run_details` (did the database make the call),
`net._http_response` (what the function answered, kept a few hours), `monthly_reports`
(what was sent), the dashboard's Activity page ("Monthly report emailed"), and the
function's log in Supabase (Edge Functions > scheduled-tasks > Logs).

### Rolling back 11a and 11b

Newest first, and the backend before the database:

1. `select cron.unschedule('luzena-daily-tasks');`
2. Deploy the functions of the commit before this work (`git checkout <commit> --
   supabase/functions`, `supabase functions deploy dashboard-api public-menu public-site
   job-application clover-webhook --project-ref <ref> --use-api`), and the website of that
   commit (`deploy.sh <commit>`). The old dashboard works against the new database; the new
   dashboard does not work against the old.
3. Only if the database must go back too: `supabase/rollback/20261014001500_...down.sql`,
   then `supabase/rollback/20261013001400_...down.sql`, in the SQL editor. Each says at its
   top what it deletes for good (messages, report records, invitations, and the access of
   everyone who joined by invitation; never an owner, an application or a CV). Both were
   run on TEST and proven to restore the earlier schema exactly.

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
| Database | Migrations only add objects. To undo one, write a new migration that reverses it. Back up before any migration that changes existing rows. The two of 2026-10-13 have tested rollback files in `supabase/rollback/` (section 11b). |
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
