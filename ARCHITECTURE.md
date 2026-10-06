# Architecture

This describes the system as it is built. Anything not yet built or not yet tested is
labelled as such.

## 1. The three parts

```
 CUSTOMER                                   RESTAURANT OWNER
    |                                              |
    v                                              v
 PUBLIC WEBSITE (static files)              OWNER DASHBOARD (/dashboard/, static app)
    |          both served by Nginx on the Hostinger VPS, from one built folder
    |                                              |
    |  GET public-menu                             |  Supabase Auth session (JWT)
    |  POST job-application                        |  dashboard-api/*
    v                                              v
 +--------------------------- SUPABASE EDGE FUNCTIONS (Deno) ---------------------------+
 |  public-menu   job-application   clover-webhook   dashboard-api                      |
 |  shared code: auth + tenant resolution, validation, Clover client, sync, audit      |
 +--------------------------------------------------------------------------------------+
        |  SQL functions only (service role)        |  HTTPS, OAuth bearer token
        v                                           v
   POSTGRES + STORAGE                          CLOVER REST API  <---->  CLOVER MERCHANT (POS)
                                                    ^
 CUSTOMER --- ORDER ONLINE link ------------------> CLOVER ONLINE ORDERING (cart, checkout, payment)
```

- The **public website** is static HTML built by Vite. Restaurant text, hours, address and
  photos are compiled in from `content/site.json`. The only data loaded at runtime is the menu.
- The **dashboard** is a separate single-page app under `/dashboard/`, with its own styles.
  It talks only to `dashboard-api`.
- The **backend** is four Supabase Edge Functions. They are the only code that holds
  credentials or talks to Clover or the database.
- **Hosting** (decided by the client, 2026-10-05): the built website is served by Nginx on
  the client's existing Hostinger VPS, deployed from GitHub by `deploy/deploy.sh`. The VPS
  serves files and nothing else: it runs no application code, proxies nothing, and holds no
  secret. The browser calls the Supabase functions directly, so the path to Clover is
  browser -> Supabase Edge Function -> Clover, in test and in production alike.
- **Ordering, checkout and payment** stay entirely in Clover. This system never sees an
  order or a card.

## 2. Source of truth: Model C (hybrid)

Three models were weighed against what Clover's API actually supports
(see `CLOVER_CAPABILITY_MATRIX.md`).

| Model | Verdict | Why |
|---|---|---|
| A. Clover is the only source of truth | Rejected | Clover's item schema has no description field and no image field. A dashboard that could not save a description or a photo would not meet the requirement. |
| B. Our database is the source of truth, pushed to Clover | Rejected | Staff also change items at the Clover register and in the Clover dashboard. Two writers with ours "authoritative" means overwriting their changes or building two-way merge. Clover also has no idempotency key for inventory, so a push queue could create duplicates. |
| **C. Hybrid** | **Chosen** | Each piece of data has exactly one owner, decided by where it can actually be stored. |

### Who owns what

| Data | Owner | Where the dashboard writes it |
|---|---|---|
| Item name, price, price type, in stock (`available`), hidden in Clover (`hidden`) | Clover | Clover, then mirrored |
| Categories: name, order, which items belong | Clover | Clover, then mirrored |
| Modifier groups and modifiers: names, prices, min/max, availability, item assignment | Clover | Clover, then mirrored |
| Item description, photo, featured, dietary labels | This system | Database (`web_*` columns) and Storage |
| "Show on the website" for items and categories | This system | Database |
| Archive (items and categories) | This system | Database |
| Order of items inside a category on the website | This system | Database |

**Nothing is published just because it is in Clover.** An item is on the website only when
all of these hold: the owner has shown it (`web_hidden = false`), it is not archived, Clover
does not mark it hidden, and Clover still has it. An item that arrives from Clover, on the
first import or later, starts with `web_hidden = true`: connecting a merchant publishes
nothing, and the owner chooses what customers see (Items > select > Show). An item created
in the dashboard is shown unless its form says otherwise. Hiding and archiving are website
only: neither changes or deletes anything in Clover, and this system never calls a Clover
`DELETE` endpoint.

The schema makes the split structural: in `menu_items` and `menu_categories`, unprefixed
columns are Clover's and are overwritten by sync; `web_*` columns and `archived_at` are ours
and sync never touches them. A test asserts this.

### Consequences of the choice

- **Write-through, not optimistic.** Saving a Clover-owned field calls Clover first. The
  local mirror is updated only from what Clover returns. The dashboard never shows "saved"
  for something Clover did not accept.
- **No draft/publish.** A change written to Clover is live at the register and in online
  ordering at once. A draft layer here would promise something Clover does not do, so none
  exists. Preview is client-side: the editor renders the item with the same function the
  public menu uses, including unsaved edits.
- **No hard delete.** The dashboard never calls Clover's delete endpoints. "Archive" is
  website-only and reversible. An item deleted in Clover itself is marked "removed in
  Clover" in the mirror at the next sync; its row and website data are kept.
- **The website survives a Clover outage.** The public menu is served from the mirror.

## 3. Synchronisation

There is one sync operation: read the merchant's full inventory and apply it to the mirror
in a single SQL transaction (`menu_apply_sync`). It runs when:

| Trigger | When |
|---|---|
| `connect` | Right after Clover is connected |
| `manual` | The owner presses "Sync now" |
| `webhook` | Clover reports an inventory change |
| `stale` | A public menu read finds the mirror older than `MENU_SYNC_TTL_SECONDS` (default 300) |

No queue and no scheduler are required. `stale` is the safety net if a webhook is missed.

- **One at a time.** `sync_claim` takes a per-restaurant lock in the database that expires by
  itself after 120 seconds if a run dies.
- **Stale-while-revalidate.** `public-menu` answers from the mirror immediately and runs the
  sync after the response is sent.
- **Three paged Clover calls per sync** (categories, modifier groups, items), 1000 rows per
  page, issued one after another. A 5-minute cycle is far below Clover's rate limits.
- After a dashboard write, only the affected item, category list or modifier group is
  re-read from Clover (a partial apply), not the whole inventory.

### Status the dashboard shows

Connection-level: `Not connected`, `Connected`, `Syncing`, `Last sync failed`,
`Reconnect needed`. Operation-level, in every write response: `synced`, `saved`
(website-only data), `partial`, or an error carrying `clover_changed`
(`false` / `true` / `"unknown"`), `local_changed` and `retryable`.

There is no per-item "pending" state, because nothing is ever queued: a write either reached
Clover during the request or it did not.

### Conflicts

Scenario: the owner opens an item at $32; someone changes it to $36 at the register; the
owner saves $33.

The editor sends the values it loaded (`expected`). Before writing, the backend reads the
item from Clover and compares field by field, only for the fields being changed. If Clover's
value differs from `expected`, nothing is written and the API returns `409 conflict` with
both values. The owner chooses "Use Clover's values" or "Keep my values and save". A change
to an unrelated field (stock, for example) is not a conflict.

Clover is the owner of those fields, so its value is never overwritten without the owner
seeing it first.

### Failures and retries

| Call type | Retried automatically on | Never retried on |
|---|---|---|
| Read | 429, 5xx, timeout, network (3 attempts, backoff, honours `retry-after`) | 4xx |
| Update / association (sets a value; repeating is harmless) | same as read | 4xx |
| Create | 429 only | 5xx, timeout, network |

When a write ends without a clear answer, the backend reads the object back from Clover and
decides from what is actually there. If even that read fails, the response says
`clover_changed: "unknown"`.

**Idempotent creates.** Clover has no idempotency key for inventory. The dashboard generates
one key per editor session and sends it as `Idempotency-Key`. `idempotency_keys` stores the
outcome. A finished request is replayed from storage. After an unknown outcome, the retry
first searches Clover for an item of that name created since the first attempt and adopts it
instead of creating a second one.

**Partial saves.** One save can involve up to three Clover steps (details, categories,
modifier groups). They run in order and stop at the first that fails. If some succeeded, the
response is `partial`, lists what was not saved, and the editor stays dirty for exactly
those fields.

## 4. Multi-tenancy and access control

- Every tenant-owned row has `restaurant_id`. Composite primary keys start with it.
- A user's restaurants come from `restaurant_users` (roles `owner`, `manager`, `staff`).
  Only `owner` is assigned today; the permission map already covers the other two.
- Per request, `dashboard-api` verifies the JWT with Supabase Auth, loads the user's
  memberships, and picks the restaurant. The `x-restaurant-id` header can only choose among
  restaurants the user already belongs to. No id in a body or URL is trusted for tenancy.
- Clover ids in requests are checked against the restaurant's own mirror (`menu_known_ids`)
  before any Clover call.
- The database is closed by default: RLS on every table with **no policies**, table
  privileges revoked from `anon` and `authenticated`, and every SQL function executable only
  by `service_role`. The browser never queries the database.

## 5. API contracts

Base: `https://<project>.supabase.co/functions/v1`. JSON unless stated. Errors are always

```json
{ "error": { "code": "...", "message": "...", "request_id": "...",
             "fields": { }, "clover_changed": false, "local_changed": false, "retryable": true } }
```

with only the relevant keys present.

### Public

| Method and path | Purpose |
|---|---|
| `GET /public-menu?restaurant=<slug>` | The menu customers may see. 200 with `{version, currency, synced_at, categories[]}`; 503 "Menu temporarily unavailable" before the first sync or on failure; 429 above 120 requests a minute from one address. Cacheable for 60 s. |
| `POST /job-application` | `multipart/form-data`: `restaurant`, `submission_id`, `full_name`, `email`, `phone`, `position`, `employment_type`, `availability` (one or more), `start_when`, `experience_level`, `work_authorized`, `consent`, optional `experience`, `message` and `cv`, plus the bot-trap fields. 200, 422 with `fields`, 429, 503. Answers 503 `applications_closed` unless both `JOB_APPLICATIONS_ENABLED=true` and `JOB_APPLICATION_RETENTION_DAYS` are set. |
| `POST /clover-webhook` | Clover's notifications. Authenticated by `X-Clover-Auth`. |

### Job applications: two switches and a retention period

Online applications are off until three things are true, and each is checked where it
cannot be skipped:

| Setting | Where | Checked by |
|---|---|---|
| `careers.applications.enabled: true` | `content/site.json` | The build: the form and its script are only put on the page when this is on, and the build stops if it is on without a privacy policy. |
| `JOB_APPLICATIONS_ENABLED=true` | Supabase secret | The endpoint: 503 otherwise, even if a form is posted to it by hand. |
| `JOB_APPLICATION_RETENTION_DAYS` | Supabase secret, **no default** | The endpoint: 503 while it is unset, and an error in the log saying why. |

Applications older than the retention period are deleted by `purgeExpiredApplications`
(`_shared/public/retention.ts`): CV files first, then the rows, so a failed file deletion
never leaves a file without its record. It runs after an application is accepted and when an
owner opens the dashboard overview. There is no scheduler; `DEPLOYMENT_CHECKLIST.md` says how
to add one if the privacy policy needs a guaranteed day.

### Job applications: the path one takes

```
Applicant -> form on /careers/ -> POST /job-application -> database (+ CV in the private bucket)
                                          |  answers the applicant here: "received"
                                          v  then, after the answer
                                    email to the restaurant's recruitment inbox,
                                    with a link to /dashboard/#/applications/<id>

Owner -> dashboard (signed in) -> /dashboard-api/applications... -> database, private bucket
```

- **The database is the record.** `job_application_submit` stores the application and its
  first history entry in one call. The applicant is answered as soon as that succeeds. A
  failed email changes nothing for the applicant: the application is marked
  `email_status = failed` and the dashboard says so on it.
- **One application per send.** The form makes a `submission_id` once per page load. The
  same id arriving again, from a second press or a retry, is answered as received and
  stores nothing. A unique index on `(restaurant_id, submission_id)` decides a race.
- **The recruitment address** is `restaurants.recruitment_email`. The handler reads it when
  it sends the email. It is in no content file, page or script.
- **The dashboard** lists applications (name, position, stage, date; no contact details),
  shows one in full with its history, changes its stage with an optional note, and
  downloads the CV. Owners and managers only (`applications.read`, `applications.manage`).
- **The CV has no address.** `GET /applications/{id}/cv` reads it from the private bucket
  with the service role and streams it in the authenticated response, as a download.
- **History.** `job_application_events` gets a row when an application arrives, when its
  notification is sent or fails, when its stage changes (with who, and their note), when a
  note is added, and when its CV is downloaded. Rows go when the application is deleted.

### The ORDER ONLINE link

One value: `CLOVER_ORDERING_URL` (a build-time variable in the server's `site.env`), which overrides
`ordering.url` in `content/site.json`. When it is empty every ORDER ONLINE button goes to
the on-site `/order/` page, which says ordering opens soon and gives the phone number. A
production build refuses a value that is not `https://` or that looks like a placeholder
(`example.com`, `localhost`, "sample"), and warns when the host is not `clover.com`.

### Dashboard (`/dashboard-api`, `Authorization: Bearer <Supabase JWT>`)

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /me` | menu.read | User, restaurant, role, permissions |
| `GET /overview` | menu.read | Counts, connection, recent items, sync errors, recent activity |
| `GET /items` | menu.read | `search, category, availability, visibility, status, featured, sort, dir, limit, offset` |
| `GET /items/{id}` | menu.read | One item |
| `POST /items` | menu.write | Create. Needs `Idempotency-Key`. Body `{clover:{name, price_cents, ...}, website:{...}}` |
| `PATCH /items/{id}` | menu.write | `{clover:{...}, expected:{...}, website:{...}}` |
| `POST /items/bulk` | menu.write | `{ids[], action}`; actions `show, hide, archive, restore, feature, unfeature, available, unavailable` |
| `POST /items/{id}/image`, `DELETE /items/{id}/image` | menu.write | Photo upload (multipart `file`) and removal |
| `GET /categories`, `POST /categories` | menu.read / menu.write | List; create (needs `Idempotency-Key`) |
| `PATCH /categories/{id}` | menu.write | Rename (`clover`, `expected`) and website flags |
| `POST /categories/reorder` | menu.write | `{ids[]}`, every current category in the new order |
| `POST /categories/{id}/items/reorder` | menu.write | Website order of items in a category. API only: no screen uses it yet. |
| `GET /modifier-groups`, `POST /modifier-groups`, `PATCH /modifier-groups/{id}` | menu.read / menu.write | Groups |
| `POST /modifier-groups/{id}/modifiers`, `PATCH /modifier-groups/{id}/modifiers/{mid}` | menu.write | Modifiers |
| `GET /clover` | menu.read | Connection status. Never contains token material. |
| `POST /clover/connect`, `/clover/complete`, `/clover/disconnect` | clover.manage | OAuth start, finish, disconnect |
| `POST /clover/sync` | menu.write | Manual sync |
| `GET /applications` | applications.read | Job applications, newest first. `search, status, position, from, to` (instants; `to` is exclusive), `limit, offset`. Returns `total`, the page, `counts` by stage and the `positions` applied for. |
| `GET /applications/summary` | applications.read | `{new, total}`: the number beside "Applications" in the sidebar |
| `GET /applications/{uuid}` | applications.read | One application in full, with its history |
| `PATCH /applications/{uuid}` | applications.manage | `{status, note?}`. Stages: `new, reviewing, shortlisted, interview, hired, rejected`. |
| `GET /applications/{uuid}/cv` | applications.read | The CV's bytes, as a download. Recorded in the history and the audit log. |
| `DELETE /applications/{uuid}` | applications.manage | Deletes the application, its CV and its history for good: for an applicant who asks. The file first, so a failure leaves the application in place. |
| `GET /activity?before=<id>` | activity.read | Audit log, 30 per page |

Per-user rate limits apply to every route (see `dashboard/router.ts`).

## 6. Data model

Defined in `supabase/migrations/`. Seventeen tables:

| Table | Holds |
|---|---|
| `restaurants`, `restaurant_users` | Tenants and memberships |
| `clover_connections` | One Clover merchant per restaurant, encrypted tokens, sync state and locks |
| `oauth_states` | One-time nonces for connecting Clover |
| `menu_categories`, `menu_items`, `menu_item_categories` | Mirror plus website data |
| `menu_modifier_groups`, `menu_modifiers`, `menu_item_modifier_groups` | Mirror |
| `sync_runs` | History of sync attempts |
| `audit_logs` | Who did what, with outcome |
| `idempotency_keys` | Outcomes of create requests |
| `job_applications` | Applications (private): the applicant's answers, the CV's place in the private bucket, the stage, whether the notification went out |
| `job_application_events` | What happened to each application, in order (private) |
| `rate_limits`, `integration_logs` | Operational |

Deliberately not created: tables for restaurant info, locations, gallery, job positions.
Those live in `content/site.json` and are not editable from the dashboard in this version.

Indexes follow the dashboard's actual queries, each scoped by `restaurant_id`: items by
`lower(name)`, by `updated_at desc`, by `price_cents`; a partial index on featured items;
links by `(category, position)` and by item; audit and sync history by recency.

## 7. Folder structure

```
content/            site.json (production), site.sample.json, sample-menu.json, media/, sample-media/
build/              content loading and validation, image pipeline, SEO, the Vite plugin
src/partials/       head, header, footer (Handlebars)
src/styles/         main.css (public site), dashboard.css
src/js/             public site scripts; lib/ is shared with the dashboard
src/dashboard/      dashboard app: main, api, ui, demo, views/
*.html, */index.html  one entry per page
supabase/migrations/  schema, SQL functions, storage buckets, application retention
supabase/functions/   four entrypoints + _shared/ (all logic)
tests/              Vitest: SQL, dashboard API, public endpoints, units, frontend logic
tests/browser/      the built site driven in a real Chromium, with accessibility scans
tests/sandbox/      checks against a real Clover sandbox (skipped without credentials)
scripts/            content check, Deno smoke run, performance measurement, screenshots,
                    the verify:* checks of real projects and sites, the Nginx config generator
deploy/             the production server: headers.json (the one list of response headers),
                    nginx/ (generated site config), deploy.sh (runs on the VPS), site.env.example
docs/               design system, configuration reference
```

Inside `supabase/functions/_shared`, only `runtime.ts` touches Deno and the Supabase client.
Everything else is plain TypeScript with injected dependencies, which is why the same code
runs under Node in the tests.

## 8. Not built, by decision

- Editing restaurant info, locations, gallery or job positions from the dashboard.
- Draft/publish and scheduling.
- Permanent deletion of items, categories or modifiers.
- Bulk price changes.
- A screen for reordering items inside a category (the API exists).
- Tax, stock quantities, subcategories, orders.
- Self-service sign-up and user management screens. The operator provisions owners.
