# Production blockers

What stands between the current state and a live site, who has to act, and what "done"
means for each. Updated 2026-10-05.

**The site is not live.** Both Supabase projects exist, test and production, with their
databases set up and verified closed (B-5); the functions, the website and Clover are not
deployed anywhere. Everything that could be built and verified on one machine without
outside accounts has been; the list below is what is left.

Categories: **BLOCKING** stops launch. **NON-BLOCKING** can follow launch. The second label
says whose move it is: **CLIENT INPUT**, **CLOVER INPUT**, **INFRASTRUCTURE**, **LEGAL**, or
**OPTIONAL**.

## What can launch when

The site has two halves that can go live separately.

| Goal | Needs |
|---|---|
| **Information site**: name, address, hours, About, the list of roles, "ordering opens soon" | B-5, B-6 only |
| + Live menu and owner dashboard | + B-1 |
| + ORDER ONLINE going to Clover | + B-2 |
| + Online job applications | + B-3, B-4, B-7 |

---

## BLOCKING

### B-1. Clover sandbox testing — BLOCKING · CLOVER INPUT + INFRASTRUCTURE

The Clover integration has never talked to Clover. Every call was written from Clover's
documentation and tested against a stand-in.

- **Needed from you:** a Clover sandbox developer account, a test merchant, a sandbox app
  (App ID and App Secret). For production afterwards: Clover's approval of a production
  developer account and of the app.
- **Ready on our side:** `CLOVER_SANDBOX_TEST_PLAN.md` (20 tests), and an automated suite,
  `npm run test:clover-sandbox`, that needs only a merchant id and a token.
- **Done when:** Part A passes, Part B's table is filled in, and the capability matrix shows
  dates in "Sandbox tested".
- **Until then:** do not connect a real merchant. The menu page shows "Menu temporarily
  unavailable" and the dashboard is not usable for editing.
- **Two answers the sandbox must give:** whether Clover returns `state` after authorisation
  (decides `CLOVER_REQUIRE_STATE`), and what the `hidden` flag does at the register.

### B-2. Clover Online Ordering link — BLOCKING for ordering · CLIENT INPUT

- **Needed from you:** the address of the restaurant's Clover Online Ordering page (Clover
  merchant dashboard > Online Ordering). The restaurant has to switch online ordering on
  in Clover first.
- **Ready on our side:** one setting, `CLOVER_ORDERING_URL` in the server's `site.env` (or
  `ordering.url` in `content/site.json`). No code change.
- **Until then:** every ORDER ONLINE button goes to the on-site page saying ordering opens
  soon, with the phone number. Nothing points to an invented address, and the production
  build refuses placeholder links.
- **Not blocking** the information site.

### B-3. Privacy policy — BLOCKING for job applications · LEGAL + CLIENT INPUT

- **Needed from you:** the policy text, or a link to it. It must cover what the application
  form collects (name, email, phone, message, CV), why, who receives it, how long it is kept
  (B-4), and how to ask for deletion. This must come from the restaurant and its adviser; it
  was not drafted here.
- **Ready on our side:** a `/privacy/` page that fills itself from
  `legal.privacy.sections` in `content/site.json`, or `legal.privacyPolicyUrl` for a policy
  hosted elsewhere; a footer link that appears once either exists; a link beside the
  consent checkbox.
- **Enforced:** the site will not build with the application form switched on and no policy.

### B-4. Retention period for job applications — BLOCKING for job applications · LEGAL + CLIENT INPUT

- **Needed from you:** a number of days to keep applications and CVs.
- **Ready on our side:** the secret `JOB_APPLICATION_RETENTION_DAYS`. It has **no default**:
  choosing one would be making this decision for you. Once set, older applications and their
  CV files are deleted automatically.
- **Enforced:** while it is unset the backend refuses every application.

### B-5. Supabase production project — BLOCKING · INFRASTRUCTURE

- **Decided by the client (2026-10-05): two projects.**
  - **TEST / STAGING:** `cgxhifkeoesvsycewwfs`, eu-west-1 (Ireland). **Exists.** Five
    migrations applied; `npm run verify:database` passes 30 of 30. Used for all Clover
    sandbox and integration testing. Never production, never real data.
  - **PRODUCTION:** `xqzpuqjrlrxyitjubkqk`, us-west-1 (N. California). **Exists.** Five
    migrations applied; `npm run verify:database` passes 30 of 30; from outside, with the
    public key, every attempt to read, write, call a function or use storage is refused.
    Nothing else is deployed to it.
- **Open on production, before anything is deployed to it: switch off sign-ups.** Supabase
  projects start with "Allow new users to sign up" on. An account made that way gets
  nothing (it belongs to no restaurant and the database grants it nothing), but only the
  owner should ever have an account. Supabase > Authentication > Sign In / Providers. Do the
  same on the test project.
- **Reset both database passwords before launch**, to a different, long, random one for
  each project. Nothing in the running system uses the database password.
- **Needed on both projects before functions can be deployed:** the Supabase CLI signed in
  to the account that owns them (`supabase login`). A database password alone cannot deploy
  functions or set secrets.
- **Then, per project:** functions deployed, secrets set, Auth settings, the owner's user
  created and linked.
- **How to reset a password:** Supabase > Project Settings > Database. It breaks nothing:
  the functions use the service-role key, not the database password.
- **Supplied 2026-10-06:** the owner signs in to the dashboard as `fadi.auchi@gmail.com`,
  the same address that receives job applications.
- **TEST backend deployed and checked (2026-10-06).** The four functions, the secrets, the
  owner and the restaurant are on the TEST project; `npm run verify:functions` passes 15 of
  15 and `npm run verify:public-access` 15 of 15. The functions worked against a real
  project on first contact.
- **Open on TEST, needed from you: apply the Auth settings.** In a terminal in this
  folder, run `supabase config push --project-ref cgxhifkeoesvsycewwfs`, read the
  difference it prints, and answer `y` (`DEPLOYMENT_CHECKLIST.md` section 2 says what to
  expect and why this one is not run for you). Until then email sign-in is off on TEST,
  so the signed-in checks cannot run, and PRODUCTION waits for them.
- **Found on TEST, fixed:** `supabase/config.toml` would have switched the email provider
  off, which locks every user out, the owner included. Corrected before it could reach
  PRODUCTION.
- **Ready on our side:** `DEPLOYMENT_CHECKLIST.md` section 2; `supabase/provision-restaurant.sql`;
  a secrets file per environment with its own freshly generated keys
  (`supabase/functions/.env.test`, `.env.production`, both git-ignored);
  `npm run verify:functions`, which checks the deployed functions from outside.
- **Known gap:** the functions have been executed under Deno with the database unreachable
  (`npm run check:deno`), never against this project. Expect to find and fix small things
  on the first function deploy. (The first real database run already found one: two
  sequences left open by Supabase's defaults, closed by the fifth migration.)

### B-6. The website on the Hostinger VPS, and the domain — BLOCKING · INFRASTRUCTURE

- **Decided by the client (2026-10-05):** the website is hosted on the client's existing
  Hostinger VPS, served by Nginx and deployed from GitHub by a script on the server. The
  backend stays on Supabase. **Vercel is not used.** The client runs the commands on the
  VPS; nothing is done on it from here.
- **Needed from you, in this order:**
  1. DONE 2026-10-06: the GitHub repository is `gooamr88-pixel/luzena`. It is **public**,
     by your decision, so the server can read it without any key.
  2. DONE 2026-10-06: the VPS has been looked at twice, read-only. It is Ubuntu 24.04.4
     with Nginx 1.24.0, Node 20.20.2, npm 11.18.0, git 2.43.0 and certbot 2.9.0 (with its
     Nginx plugin), with ample disk and memory. No existing site claims
     `luzenarestaurant.com` or clashes with the new site file. Nothing was changed.
  2a. **Decided by you (2026-10-06): the old-spelling domain redirects.** The VPS already
     serves `luznarestaurant.com` (without the "e"): a "Grilli - Coming Soon" page from the
     earlier Next.js build. Once `luzenarestaurant.com` is live and checked, that address
     redirects to it (`DEPLOYMENT_CHECKLIST.md` section 7.1; the file is
     `deploy/nginx/luznarestaurant.com.redirect.conf`, and it reuses that domain's existing
     certificate). Nothing is changed there before launch.
  3. After TEST has passed and PRODUCTION Supabase is ready: the rest of sections 5 to 7
     (a user and a folder for the site, a clone of the repository, `site.env` with the
     production publishable key, DNS, the certificate, the Nginx file, the first
     deployment).
  4. DNS for `luzenarestaurant.com`: `A` records for the bare domain and `www` to the VPS
     (`187.77.1.72`). On 2026-10-06 the domain still shows Hostinger's parking page
     (`2.57.91.91`), and `www` is a `CNAME` to the bare domain, which can stay.
- **Ready on our side:** `deploy/deploy.sh` (build, checks, atomic switch, rollback),
  `deploy/nginx/luzenarestaurant.com.conf` (generated; HTTPS, redirects, security headers,
  caching), `deploy/site.env.example`, and `npm run verify:site` for after each deployment.
- **Known gap:** none of the server files has run on a real server. The deploy script's
  refusals were exercised locally; its build and switch steps, and the Nginx file, were
  not. Expect to fix small things on first contact, as with the functions on TEST.

### B-7. Resend verified domain — BLOCKING for job applications · INFRASTRUCTURE

- **Needed:** a Resend account, `luzenarestaurant.com` verified there (three DNS records),
  an API key.
- **Until then:** applications cannot be emailed, and the backend answers "could not send"
  rather than pretending.

---

## NON-BLOCKING

### N-1. Real photos — NON-BLOCKING · CLIENT INPUT (postponed on purpose)

Not a blocker. The site is designed to work without them: text-only hero, logo panel on
About, a share image generated from the logo, Gallery hidden. To add them later: files into
`content/media/`, names into `content/site.json`, redeploy. The stock photos used during
development are in `content/sample-media/`, are read only by sample builds, and on the
server exist only inside the repository checkout, which Nginx never serves.

### N-2. Approval of the written text — NON-BLOCKING · CLIENT INPUT

The home headline, the About page and the 18 role descriptions were written for this build.
The About text is based only on the restaurant's Instagram description. The role
descriptions are standard for each job. Please read and correct them.

### N-3. Map coordinates — NON-BLOCKING · OPTIONAL

`locations[0].geo` is empty. The Maps link supplied did not include coordinates and they were
not guessed. Adding the latitude and longitude from the Google listing helps local search.

### N-4. Full-time or part-time for each role — NON-BLOCKING · CLIENT INPUT

`type` is empty on all 18 positions, so no badge is shown.

### N-5. Is the restaurant open yet? — NON-BLOCKING · CLIENT INPUT

The careers text says "we are building our opening team". If the restaurant is already
open, that sentence should change.

### N-6. Accessibility: manual pass — NON-BLOCKING · OPTIONAL

Automated WCAG 2.2 AA scans pass on every public page and dashboard screen, and keyboard
use is tested. Not done: a pass with a screen reader (NVDA or VoiceOver) by a person.

### N-7. Performance on the live site — NON-BLOCKING · INFRASTRUCTURE

Measured locally (see `TESTING.md`). Field numbers need the deployed site and real photos.

### N-8. Narrow the security policy — NON-BLOCKING · INFRASTRUCTURE

`deploy/headers.json` allows connections to `https://*.supabase.co`. After B-5, replace it
with the production project's exact host and regenerate the Nginx file
(`npm run build:nginx`).

### N-9. A guaranteed schedule for deleting old applications — NON-BLOCKING · OPTIONAL

Deletion runs when an application arrives and when an owner opens the dashboard. If the
privacy policy promises deletion by an exact day regardless of activity, add a daily
schedule (described in `DEPLOYMENT_CHECKLIST.md`).

### N-11. SQL functions without a fixed `search_path` — NON-BLOCKING · INFRASTRUCTURE

Supabase's security advisor, run on the TEST database on 2026-10-06, warns that the 44 SQL
functions do not pin their `search_path`. The risk here is low: none of them is
`security definer`, each can be executed by the backend's role only, and they name their
tables with the schema. It is still worth closing: a new migration that sets the search
path on each function, run through `npm test` and applied to TEST before PRODUCTION. Not
done yet, so that the first deployment changes as little as possible.

The same run gave two Auth warnings that are dashboard settings, for you to decide: the
leaked-password check is off (it is a paid-plan feature), and few multi-factor options are
enabled.

### N-10. Second social link, price range — NON-BLOCKING · OPTIONAL

Only Instagram is set. `priceRange` is empty.

---

## Resolved in this round

| Was | Now |
|---|---|
| Address, phone, hours missing | Supplied and integrated: 315 El Cajon Blvd, El Cajon, CA 92020; +1 619-499-5779; Sun–Thu 8 AM–12 AM, Fri–Sat 8 AM–2 AM; breakfast daily 8 AM–12 PM |
| Domain spelling unconfirmed | `luzenarestaurant.com` everywhere; a test fails if the old spelling returns |
| Recruitment address unconfirmed | `fadi.auchi@gmail.com`, set in the provisioning script |
| Edge Functions never run under Deno | Type-checked and executed under Deno (`npm run check:deno`) |
| No linter | ESLint, with rules that forbid `innerHTML`, `eval` and `localStorage` |
| Interface never exercised in a browser | Real-browser tests for the public site and the dashboard |
| No retention mechanism | Configurable retention with automatic deletion; off until a number is chosen |
