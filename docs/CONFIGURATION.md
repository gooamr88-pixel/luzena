# Configuration

Every setting this system reads, where it lives, and what it is in each environment.

There are three places a setting can live. The rule for choosing is simple:

| Place | What goes there | Who can see it |
|---|---|---|
| `content/site.json` (in the repository) | Facts about the restaurant that visitors see: name, address, hours, text, links | Everyone. It becomes the public website. |
| Build variables: `shared/site.env` on the server (build time) | The two public Supabase values, and the ordering link | Everyone: anything starting `VITE_` is compiled into public JavaScript |
| Supabase Edge Function secrets | Every credential, and the switches that govern personal data | Only the backend |

**A secret never goes in the first two.** If a value would be a problem on a billboard, it is
a Supabase secret.

## 1. Environments

| | Development | Test | Production |
|---|---|---|---|
| Purpose | Building and reviewing on your own machine | Proving the system against real Supabase and the Clover **sandbox** | The live restaurant |
| Site content | Real content + sample photos, menu and privacy text (`npm run dev`) | Real content | Real content |
| Site address | `http://localhost:5173` | `http://localhost:4173` (`npm run build:staging`, then `npm run preview:staging`). No public test address exists. | `https://luzenarestaurant.com` |
| Where the site runs | This machine | This machine | Nginx on the client's Hostinger VPS, deployed from GitHub by `deploy/deploy.sh` |
| Supabase project | None needed (dashboard runs in demo mode) | `cgxhifkeoesvsycewwfs` (Ireland). Database set up and verified; nothing else yet. | `xqzpuqjrlrxyitjubkqk` (us-west-1, N. California). Database set up and verified; nothing else yet. |
| Clover | None | `CLOVER_ENV=sandbox`, sandbox app, test merchant | `CLOVER_ENV=na`, approved production app, the restaurant's merchant |
| Email | None | Resend test key, or your own inbox as recipient | Resend with the verified domain |
| Job applications | Form visible (sample privacy text), posts nowhere | Switched on, with a test retention period | Off until the privacy policy and retention period are confirmed |
| Search engines | Blocked | Not reachable (it is served on this machine only) | Allowed |

Never point a test environment at the production Supabase project, and never give a test
environment production Clover credentials. Use two Supabase projects.

## 2. Website content: `content/site.json`

Not secret. Edited in the repository; a change is published by redeploying.

| Key | Meaning | Current state |
|---|---|---|
| `siteUrl` | The canonical address. Drives canonical links, Open Graph, sitemap, robots, structured data. | `https://luzenarestaurant.com` |
| `restaurantSlug` | Which restaurant's menu the site loads. Must equal the `slug` in the `restaurants` table. | `luzena` |
| `name`, `fullName`, `description`, `cuisine` | Identity and search description | Set |
| `locations[]` | Address, phone, email, Maps link, `hours`, `services` (breakfast) | Set from the client's details |
| `locations[].geo` | `{ "lat": ..., "lng": ... }` for local search | **Not set.** The Maps link did not carry coordinates. Do not guess them. |
| `ordering.url` | The restaurant's Clover Online Ordering page | `https://luzna-cafe-el-cajon.cloveronline.com/menu/all` (given by the client 2026-10-07). See section 4. |
| `careers.applications.enabled` | Whether the site publishes the application form | **`true`** since 2026-10-06. See section 5. |
| `legal.privacyPolicyUrl` or `legal.privacy.sections` | The privacy policy: a link, or text for the built-in `/privacy/` page | **Not set** |
| `hero.image`, `about.image`, `gallery[]`, `locations[].image`, `defaultDishPhotos[]` | Photos | **Placeholders** (`placeholder-*.jpg`), until real photos arrive. See section 6. |
| `ogImage`, `careers.image` | Photos | **Not set.** See section 6. |
| `locations[].mapsEmbedUrl` | The Google map on the home and Locations pages | Set: a Google Maps embed address built from the restaurant's name and street address. It must start with `https://www.google.com/maps`, the only frame the security policy allows. Set it to `null` to remove the map. |
| `social.*` | Social links | Instagram set |

`npm run check:content` lists everything unset and says what the site does without it.

## 3. Build variables

They are read when the site is built, and each environment keeps them in its own place:

| Environment | File | Read by |
|---|---|---|
| Production | `/var/www/luzenarestaurant.com/shared/site.env` on the VPS (template: `deploy/site.env.example`) | `deploy/deploy.sh` |
| Test | `.env.staging.local` in this folder, git-ignored (template: `.env.example`) | `npm run build:staging` |
| Development | none | `npm run dev` sets what it needs |

The server's file also carries `DEPLOY_ENVIRONMENT=production`. The deploy script refuses to
build unless `VITE_SUPABASE_URL` is that environment's Supabase project, and refuses a
secret key in `VITE_SUPABASE_ANON_KEY`.

Do not create `.env`, `.env.local` or `.env.production*` in this folder: `npm run build`
and the browser tests would read them without saying so.

| Variable | Public? | Development | Test | Production |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` | Yes | unset | test project URL | production project URL |
| `VITE_SUPABASE_ANON_KEY` | Yes, by design | unset | test project anon key | production project anon key |
| `CLOVER_ORDERING_URL` | Yes (it is a link) | unset | unset, or a sandbox ordering page | the restaurant's ordering page, once known |
| `VITE_DASHBOARD_DEMO` | n/a | `1` (set by `npm run dev`) | **never** | **never**: the production build refuses it |
| `CONTENT_PROFILE` | n/a | `sample` (set by `npm run dev`) | **never** | **never** |

The anon key is safe to publish only because every table has row level security with no
policies and every database function is restricted to the service role. With that key alone
a visitor can read and write nothing. The dashboard uses it solely to sign owners in.

## 4. The ORDER ONLINE link

The path a customer takes is **website -> Order Online page -> Clover**. Every ORDER ONLINE
button on the site leads to the site's own `/order/` page. That page says how ordering works
and its ORDER NOW buttons lead to Clover, where the menu is chosen from, the order is placed
and the payment is taken. The site has no cart and takes no payment.

One value decides where ORDER NOW goes: `ordering.url`.

It can be set in either of two places. The build variable wins:

1. `CLOVER_ORDERING_URL` in the server's `shared/site.env`. Change it and run the deploy
   script again; no commit needed.
2. `ordering.url` in `content/site.json`.

While it is unset, the `/order/` page says ordering opens soon and offers the phone number
instead. Nothing links to an invented address.

Clover's ordering page cannot be shown inside this site: it forbids being framed by other
sites (`frame-ancestors 'self' https://*.clover.com`), so it is linked, in the same tab.

Guards in the production build:

- must start with `https://`
- placeholder hosts are refused (`example.com`, `localhost`, `.test`, anything containing
  "sample" or "placeholder"), so the sample link can never be published
- a host that is not on `clover.com` or `cloveronline.com` builds, but with a warning to
  double-check it

## 5. Job applications: two switches and one number

Applications collect personal data, so nothing accepts them until three things are true.

| Setting | Where | Default | Meaning |
|---|---|---|---|
| `careers.applications.enabled` | `content/site.json` | `false` | Publishes the form. The build refuses `true` while there is no privacy policy. |
| `JOB_APPLICATIONS_ENABLED` | Supabase secret | off (anything but `true`) | Lets the backend accept applications. |
| `JOB_APPLICATION_RETENTION_DAYS` | Supabase secret | **none** | How many days an application and its CV are kept before both are deleted. |

`JOB_APPLICATION_RETENTION_DAYS` has no default **deliberately**. How long to keep
applicants' data is a decision for the restaurant and whoever advises it on privacy law, not
for the developer. Until it is set, the backend refuses every application, even with
`JOB_APPLICATIONS_ENABLED=true`, and deletes nothing.

Once set, applications older than that many days are deleted together with their CV files.
The clean-up runs after each accepted application and whenever an owner opens the dashboard
overview. The number must match what the privacy policy tells applicants.

Where applications go: into the database, where the owner reads them in the dashboard under
**Applications**. An email then tells the restaurant one has arrived, with a link to it.

Who that email goes to: the `recruitment_email` column of the restaurant's row in the
`restaurants` table (set by `supabase/provision-restaurant.sql`). It is in the database, not
in an environment variable, because the backend serves more than one restaurant, and it is
never sent to the browser. It is not in `content/site.json` either: `locations[].email` is
`null`, so no email address appears anywhere on the website. To change the recipient, change
that column; nothing is rebuilt.

The email needs `RESEND_API_KEY` and `EMAIL_FROM` (section 7). Without them applications are
still received and shown in the dashboard; each is marked as not notified.

**State on 2026-10-06:** all of the steps below except the email are done. The policy in
`legal.privacy.sections` was drafted by the engineer at the client's request and awaits the
owner's approval; the retention period is 90 days, the client's choice; the form is on.

To open applications, in this order:

1. Apply the migrations (`20261006000700_job_application_workflow.sql` adds the answers, the
   stages and the history) and deploy the `job-application` and `dashboard-api` functions.
2. Publish the privacy policy (`legal.privacyPolicyUrl`, or text in `legal.privacy.sections`).
   It should say what the form collects: contact details, availability, experience, whether
   the applicant is authorized to work in the United States, and an optional CV.
3. Set `JOB_APPLICATION_RETENTION_DAYS` to the confirmed number.
4. Set `JOB_APPLICATIONS_ENABLED=true`.
5. Set `careers.applications.enabled` to `true` and redeploy the site.
6. Send one test application. Confirm it appears in the dashboard under Applications, that
   the email arrives, and that its link opens the application after signing in.

## 6. Photos

The restaurant's own photos have not arrived. Since 2026-10-06, by instruction, the live site
shows **placeholder photos** in their place rather than the photo-less layouts:

| Slot | Shows now | Without any photo (if the placeholder is removed and not replaced) |
|---|---|---|
| Home hero | `placeholder-hero.jpg` | The same dark hero with a warm glow and the logo's leaf |
| Home "our story", About | `placeholder-story.jpg` | Home: the "what to expect" points on a forest green panel. About: the logo, in white, on a forest green panel. |
| Gallery page, home photo strip | `placeholder-gallery-1` to `-5` | Page hidden from navigation and search; strip left out |
| Home category tiles | The category's own photo from the dashboard (**Photos > Menu categories**), else the photo of one of its dishes, else one of `defaultDishPhotos` | Green tiles |
| Home popular dishes | The dish's own photo from the dashboard, else one of `defaultDishPhotos` | Text-only cards |
| Location | The Google map. `placeholder-location.jpg` is set but only shows if the map is removed. | The opening hours, day by day |
| Link previews | An image generated from the logo (`og-default.png`) | The same |
| Careers | Left out | Left out |

The placeholders are stock photos from the design template: **not this restaurant, and their
licence for publication was never checked.** `content/media/README.md` lists them and says
how to replace each one.

There are two ways to replace a photo:

1. **In the dashboard, with no deployment** (hero, "our story", gallery, and each menu
   category's tile): the owner opens
   **Photos**, chooses a photo and writes its description. The website shows it within about
   a minute. "Use the starting photo" goes back to the built one. A gallery of the owner's
   replaces the built gallery whole (up to 24 photos; the first eight are the row on the home
   page). This is the normal way once the restaurant has photos.
2. **In the repository** (any photo, including the location photo, the link preview image
   and the default dish photos, which the dashboard does not cover): put the real file in
   `content/media/`, name it in `site.json`, write its alt text, delete the placeholder,
   redeploy. No template changes. Doing this for the hero, story and gallery too is worth it
   once the real photos are settled: the built photo is what a visitor gets if the backend
   cannot be reached, and it is served in more sizes and formats than an uploaded one.

The sample profile (`npm run dev`) still reads its own copies from `content/sample-media/`.
On the server the repository is never the web root: Nginx serves only the built release, and
`npm run verify:site` fails if a repository file can be fetched from the site.

Menu item photos are different: the owner uploads those in the dashboard, and they are
stored in Supabase Storage.

## 7. Backend secrets (Supabase Edge Functions)

Template: `supabase/functions/.env.example`. One file per environment, both git-ignored:
`supabase/functions/.env.test` and `supabase/functions/.env.production`. Set with
`supabase secrets set --env-file supabase/functions/.env.<environment> --project-ref <ref>`,
naming the project every time.

| Secret | Development | Test | Production |
|---|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | n/a | injected by Supabase | injected by Supabase |
| `ALLOWED_ORIGINS` | n/a | `http://localhost:4173,http://localhost:5173` (the test site on this machine) | `https://luzenarestaurant.com,https://www.luzenarestaurant.com` |
| `CLOVER_ENV` | n/a | `sandbox` | `na` |
| `CLOVER_APP_ID` | n/a | sandbox app | production app |
| `CLOVER_APP_SECRET` | n/a | sandbox app secret | production app secret |
| `CLOVER_REDIRECT_URI` | n/a | `http://localhost:4173/dashboard/` | `https://luzenarestaurant.com/dashboard/` |
| `CLOVER_WEBHOOK_AUTH` | n/a | shown by Clover after verifying the webhook URL | same, for the production app |
| `CLOVER_REQUIRE_STATE` | n/a | `true` (change only on evidence, see CLOVER_INTEGRATION.md) | whatever the sandbox proved |
| `TOKEN_ENCRYPTION_KEY` | n/a | freshly generated | freshly generated, **different from test** |
| `MENU_SYNC_TTL_SECONDS` | n/a | `300` | `300` |
| `IP_HASH_SALT` | n/a | random | random, different from test |
| `RESEND_API_KEY` | n/a | test key | production key |
| `EMAIL_FROM` | n/a | an address on a verified domain | `Luzena Careers <careers@luzenarestaurant.com>` |
| `JOB_APPLICATIONS_ENABLED` | n/a | `true` | `true` since 2026-10-06 |
| `JOB_APPLICATION_RETENTION_DAYS` | n/a | `90` | `90`: the client's decision (2026-10-06), and the number the privacy policy states |

Names used elsewhere for the same things: Clover's "Client ID" is `CLOVER_APP_ID`, its
"Client Secret" is `CLOVER_APP_SECRET`, the Clover environment is `CLOVER_ENV`, and the
address applications go to (`JOB_APPLICATION_EMAIL` in some checklists) is the
`recruitment_email` column described in section 5.

The Clover **merchant** is not configured anywhere. It is whichever merchant the owner
approves when pressing Connect Clover; the backend stores its id with the connection and
refuses a merchant already connected to another restaurant.

## 8. Clover sandbox test credentials

Used only by `npm run test:clover-sandbox`, on a developer's machine, never deployed:
`CLOVER_SANDBOX_MERCHANT_ID`, `CLOVER_SANDBOX_TOKEN`, and optionally `CLOVER_SANDBOX_APP_ID`
with `CLOVER_SANDBOX_REFRESH_TOKEN`. See `CLOVER_SANDBOX_TEST_PLAN.md`.

## 9. What must never be committed

`.env`, `.env.local`, `.env.*` (anything but the `.example` files), and
`supabase/functions/.env`. `.gitignore` already excludes them. Before the first commit, run
`git status` and confirm none of them is listed.
