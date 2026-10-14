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
    |  GET public-menu, GET public-site            |  Supabase Auth session (JWT)
    |  POST job-application                        |  dashboard-api/*
    v                                              v
 +--------------------------- SUPABASE EDGE FUNCTIONS (Deno) ---------------------------+
 |  public-menu   public-site   job-application   clover-webhook   dashboard-api        |
 |  shared code: auth + tenant resolution, validation, Clover client, sync, audit      |
 +--------------------------------------------------------------------------------------+
        |  SQL functions only (service role)        |  HTTPS, OAuth bearer token
        v                                           v
   POSTGRES + STORAGE                          CLOVER REST API  <---->  CLOVER MERCHANT (POS)
                                                    ^
 CUSTOMER --- ORDER ONLINE link ------------------> CLOVER ONLINE ORDERING (cart, checkout, payment)
```

- The **public website** is static HTML built by Vite. Restaurant text, hours, address and
  photos are compiled in from `content/site.json`. Two things are loaded at runtime: the menu,
  and which photos the owner has chosen in the dashboard in place of the built ones (see
  "Website photos" in section 5).
- The **dashboard** is a separate single-page app under `/dashboard/`, with its own styles.
  It talks only to `dashboard-api`.
- The **backend** is six Supabase Edge Functions: the five in the picture, and
  `scheduled-tasks`, which nobody's browser calls (the database calls it once a day; see
  "The daily schedule and the monthly report" in section 5). They are the only code that
  holds credentials or talks to Clover, the email provider or the database.
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
  The first owner is linked by the operator (`supabase/provision-restaurant.sql`); after
  that an owner invites owners, managers and staff from the dashboard (see "Team and
  access" in section 5).
  There is no platform-wide role inside this API: the operator works in Supabase itself.
- Per request, `dashboard-api` verifies the JWT with Supabase Auth, loads the user's
  memberships, and picks the restaurant. The `x-restaurant-id` header can only choose among
  restaurants the user already belongs to. No id in a body or URL is trusted for tenancy.
- The membership is read on **every** request. Changing a member's role or removing them
  takes effect at their next request, with the session they already hold.
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
| `GET /public-site?restaurant=<slug>` | The photos the owner has chosen for the website. 200 with `{version, photos: {hero, story, gallery[]}}`, each photo `{src, srcset, width, height, alt}`; `hero` and `story` are `null` and `gallery` is empty where nothing has been chosen. Every failure answers "Not available." (404, 429 above 120 a minute, 503). Cacheable for 60 s. Does not depend on Clover. |

### Website photos: built in, replaceable from the dashboard

Three sets of photos on the public site can be changed by the owner with no deployment: the
home page's **hero** photo, the **"our story"** photo (home and About), and the **gallery**
(the Gallery page, and its first eight photos as the row on the home page).

```
Build:     content/site.json -> photos compiled into the HTML (AVIF/WebP/JPEG, several widths)
Owner:     dashboard "Photos" -> /dashboard-api/site/photos... -> site_photos + public bucket
Visitor:   page opens with the built photos -> GET /public-site -> chosen photos swapped in
```

- **The built photos are the default and the fallback.** A page is complete without the
  request: if nothing has been chosen, the answer is late (4 s limit) or it fails, the built
  photos stay. Removing a chosen photo in the dashboard goes back to the built one.
- **The swap** is `src/js/site-media.js`. It replaces the `<picture>` marked
  `data-site-photo="hero|story"` and rebuilds the lists marked `data-site-gallery` from a
  `<template>` in the page. A gallery of the owner's replaces the built gallery whole.
- **No visible change of photo, anywhere.** Every photo the owner can change (hero, story,
  the home page's row, the gallery) is held back (`opacity: 0`, its space kept) until the
  script has put the right photo in **and that photo has loaded**; then it fades in. A
  visitor never sees a built photo turn into the owner's. (Until 2026-10-09 only the hero was
  held back, and only until the answer, not the photo, had arrived: the old photo showed
  first.) The last answer is remembered in the visitor's browser (`localStorage`, public
  addresses only), so a second visit puts the owner's photos in at once and asks the server
  afterwards; an answer that differs (a photo changed or removed since) replaces them,
  faded. Limits: the stylesheet shows the built photos by itself after two seconds if the
  script never runs; once it runs, each photo is shown after 5 s at most, whatever happens.
  The hero's words and colours are there from the first paint.
- **Storage.** Files go to the public `menu-images` bucket under `<restaurant>/site/<slot>/`,
  named by a hash of their content. They are public by nature. The dashboard resizes each
  photo in the browser to two sizes (full and phone) and re-encodes it, which also drops EXIF
  data; the server still checks size (1 MB each) and reads the real type from the bytes.
- **One file, perhaps several rows.** A file is named by a hash of its content, so the same
  photo added to the gallery twice is one file with two rows. A file is therefore deleted
  only when no photo on the website shows it any more (`noLongerShown` in `site-photos.ts`),
  never merely because one of its rows went.
- **Table** `site_photos`: one row per photo, `slot` in `hero | story | gallery`, at most one
  row each for `hero` and `story` (a partial unique index), at most 24 in the gallery, with
  `sort_order` and `alt`. A replaced or removed photo's files are deleted from the bucket.
- **Dashboard routes** (permission `site.manage`, held by owner and manager):
  `GET /site/photos`, `POST /site/photos` (multipart: `slot`, `alt`, `width`, `height`,
  `small_width`, `file`, `file_small`), `PATCH /site/photos/<id>` (`{alt}`),
  `DELETE /site/photos/<id>`, `POST /site/photos/reorder` (`{ids}`, every gallery photo once;
  409 if the gallery changed meanwhile). Setting and removing are recorded in the activity log.
- **Category photos** (since 2026-10-08) are the fourth kind, and travel differently: a
  category belongs to the menu, so its photo is a column on the menu mirror
  (`menu_categories.web_image_path`, website-only like a dish's description; synchronisation
  never writes to it) and reaches the page inside `public-menu` as each category's
  `image_url`, not through `public-site`. The home page's tile shows the first of these
  that loads: the category's own photo, the photo of one of its dishes, a starting photo;
  with none, a green tile. Routes: `POST /categories/<id>/image` (multipart `file`) and
  `DELETE /categories/<id>/image`, permission `site.manage`. `GET /categories` also tells
  the dashboard which photo the website borrows (`dish_image_path`) and how many of the
  category's dishes the website shows (`on_website_count`), so the Photos page can draw
  each tile as a visitor sees it. Files: `<restaurant>/categories/<category>/<hash>.<ext>`.
- **Not covered:** the logo, the Open Graph image, the location photo and the default dish
  photos are still build-time only (`content/site.json`). Dish photos have always been
  changeable per item in the dashboard.

### Menu labels and the allergy notice

What a restaurant says about its dishes, and its allergy notice, are its own: kept per
restaurant, changed in the dashboard, and unknown to Clover.

- **Labels are data, not code.** A label is a row in `menu_labels`: a name, an icon key, an
  optional description, whether it is in use, and its place in the order. Which dishes carry
  which is `menu_item_labels`. A new restaurant is given nine to start with (a vocabulary
  only, on no dish). Adding "Kosher" or "Seasonal" later is the owner adding a row.
- **Nothing puts a label on a dish except a person.** No default, no synchronisation, and no
  reading of a dish's name. A dish arrives from Clover with none.
- **Icons** are one small family in `src/js/lib/label-icons.js`, drawn like the site's other
  icons. A label names its icon by key; the backend only accepts keys in the set
  (`LABEL_ICONS` in `_shared/dashboard/labels.ts`), and a test keeps the two lists the same.
  A new icon is its drawing in one file and its key in the other.
- **To the website** labels travel inside `public-menu`: each item has
  `labels: [{name, icon, description}]`, only the ones in use, in the restaurant's order. No
  extra request. The old fixed `dietary` list is still in the answer for a website built
  before this; a page that finds `labels` shows those and not the old list.
- **The allergy notice** is `site_settings.allergy_notice`: a list of `{lang, text}`. It is
  in `public-menu` as `notice` only while it is switched on and not empty.
- **Clover** is not told about any of this and synchronisation does not read or write these
  tables. A dish that Clover drops keeps its labels on its retained row.
- **One restaurant and another:** every row carries `restaurant_id`; a dish's label is tied
  to the same restaurant by a foreign key on `(restaurant_id, label_id)`, so another
  restaurant's label cannot be stored on a dish even by faulty code.

| Method and path | Permission | Notes |
|---|---|---|
| `GET /labels` | menu.read | The labels with how many dishes carry each, and the icon keys on offer. |
| `POST /labels` | menu.write | `{name, icon, description?}`. 409 `duplicate`, 409 `labels_full` at 40. |
| `PATCH /labels/{uuid}` | menu.write | Any of `name, icon, description, active`. |
| `DELETE /labels/{uuid}` | menu.write | Deletes it and takes it off every dish. |
| `POST /labels/reorder` | menu.write | `{ids}`, every label once; 409 if they changed meanwhile. |
| `PATCH /items/{id}` | menu.write | `website.label_ids`: exactly the labels this dish carries (12 at most). |
| `GET`, `PUT /site/notice` | site.manage | `{enabled, entries: [{lang, text}]`. Refuses to be switched on empty. |

### Team and access

Who may open a restaurant's dashboard, and as what. Added 2026-10-13.

**What each role may do** is one table in `_shared/dashboard/session.ts`
(`ROLE_PERMISSIONS`), checked by the router on every request. The Team page shows the same
table (`src/dashboard/roles.js`); a test fails if the two differ.

| In the dashboard | Permission | Owner | Manager | Staff |
|---|---|---|---|---|
| See the menu | `menu.read` | yes | yes | yes |
| Change items, categories, modifiers, labels | `menu.write` | yes | yes | no |
| Change the website's photos and the allergy notice | `site.manage` | yes | yes | no |
| Sync the menu from Clover | `clover.sync` | yes | yes | no |
| Connect or disconnect Clover | `clover.manage` | yes | no | no |
| Read job applications | `applications.read` | yes | yes | no |
| Download a CV | `applications.cv` | yes | yes | no |
| Change an application's stage, add notes, delete it | `applications.manage` | yes | yes | no |
| Export applications to a file | `applications.export` | yes | no | no |
| See the activity log | `activity.read` | yes | yes | no |
| Invite people, change roles, remove access | `team.manage` | yes | no | no |

An owner may give any of the three roles (`GRANTABLE_ROLES`; owner since 2026-10-14, at the
client's request; migration 20261014001600). Managers and staff give none. Whatever is
asked, the database keeps three rules, under the restaurant's row lock: the person acting
must be an owner at that moment; nobody changes or removes their own access; a restaurant
always keeps at least one owner. The dashboard asks a second time before anyone is made an
owner, by invitation or by a change of role.

Everyone can see their own role: beside their address in the top bar (a link to "Your role"
on the Security page, which lists what the role allows and what it does not, from the
server's own permission list for the session), and an owner sees how many people hold each
role on the Team page. When a role changes while the person is signed in, their next action
reloads the dashboard for the new role and says so.

```
Owner -> Team > Invite someone -> POST /team/invitations
            |  the backend: 1. asks the database whether this may be offered (dry run)
            |               2. asks Supabase Auth to make the account, WITHOUT a password
            |               3. writes the invitation   4. emails the person (Resend)
            v
Invited person -> link in the email -> /dashboard/#/welcome?email=... -> "Send me the link"
            |  Supabase Auth emails its own link; they choose a password and sign in
            v
        signed in, no restaurant yet -> GET /account/invitations -> "Accept invitation"
            |  POST /account/invitations/{id}/accept
            v
        a row in restaurant_users: now a member
```

- **An invitation grants nothing.** It is a row in `team_invitations`: an address, a role
  (`manager` or `staff` only), who offered it, when it runs out (7 days). Its state is
  worked out from the row each time it is read: `pending`, `expired`, `revoked`, `accepted`.
- **There is no invitation token and no password in this system.** What proves who is
  accepting is the sign-in, which Supabase Auth checks, and the address Supabase Auth has
  confirmed. An invitation is found only for exactly that address. So nothing in an
  invitation can be leaked, guessed or replayed, and no route works without a session.
- **Accepting is the one moment a membership is made** (`team_invitation_accept`): open,
  not expired, not cancelled, addressed to the caller. Someone who is already a member
  keeps the role they have. An account that already belongs to another restaurant is
  refused, because the dashboard opens one restaurant per account.
- **The email** (`_shared/dashboard/team-email.ts`) says who invited them, as what, and how
  to get in. For an account this system made and nobody has signed in to, it carries a
  single-use link from Supabase Auth for choosing a password; that link is short-lived, so
  the email also spells out the way that always works ("Forgot your password?"). The link is
  put in the email and nowhere else. An account that is in use is never sent one.
- **If the email cannot be sent** the invitation is kept and marked (`email_status =
  failed`), and the Team page says so on it, as an application's page does.
- **Taking access away** deletes the member's row in `restaurant_users` and nothing else:
  the restaurant, its records, the person's Supabase Auth account and the audit log stay.
- **Limits:** 20 invitations an hour per person, 5 emails a day to one address, 25 open
  invitations per restaurant. An invitation that closed more than 90 days ago is deleted
  when the next one is made, so the address of someone who never joined is not kept.

| Method and path | Permission | Notes |
|---|---|---|
| `GET /team` | team.manage | Members, the invitations not yet accepted, and the roles the caller may give. |
| `POST /team/invitations` | team.manage | `{email, role}`. 403 `role_not_allowed`, 409 `already_member`, `already_invited`, `too_many_invitations`, 502 `account_unavailable`. |
| `POST /team/invitations/{uuid}/resend` | team.manage | Sends it again and gives it a fresh week. 404 once accepted or cancelled. |
| `DELETE /team/invitations/{uuid}` | team.manage | Cancels it. It can no longer be accepted, sent again or cancelled. |
| `PATCH /team/members/{uuid}` | team.manage | `{role}` (owner, manager, staff). 403 `self_change`, `role_not_allowed`; 409 `last_owner`; 404 for anyone who is not this restaurant's member. |
| `DELETE /team/members/{uuid}` | team.manage | Removes the membership. Same refusals. |
| `GET /account/invitations` | a session; no restaurant needed | The invitations waiting for the caller's own confirmed address. |
| `POST /account/invitations/{uuid}/accept` | a session; no restaurant needed | 404 unless it is addressed to the caller; 410 `invitation_expired`, `invitation_revoked`; 409 `invitation_used`, `account_in_use`. |

The last two are the only routes that do not need a restaurant, because making the
membership is what they are for. They need a session exactly as every other route does,
second step included.

**What the dashboard does when access changes.** A refusal from the server (403
`forbidden` or `no_restaurant`) makes the page ask who the account is now; if that differs
from what it was drawn from, the page starts again from the new answer. A page nobody
touches is not told: what it already shows stays on screen until the next action.

### Exporting job applications

An owner can take the applications list away as a file. Added 2026-10-13.

```
Owner -> Applications > Export -> POST /applications/export/preview   "12 will be exported"
                               -> POST /applications/export           the rows, as JSON
        the browser lays them out:  src/dashboard/export/workbook.js  -> .xlsx
                                    src/dashboard/export/applications.js -> .csv
```

- **An export is the list in a file: the main facts and no more** (the client's decision,
  2026-10-13): applicant, position, full-time or part-time, experience, date applied, CV or
  not, stage. Contact details and the applicant's own words are not in it, and
  `dash_applications_export` does not read them for it.
- **Three kinds, each unambiguous.** `all`: every application. `filtered`: those matching
  the list's filters, on every page. `selected`: those named by id (the ticked rows, or the
  rows of the page on screen). The dialog offers only the kinds that mean something at that
  moment, says what each covers, and shows the server's count before anything is made.
- **The server decides which applications.** The restaurant is the caller's own; an id is
  looked for only inside it, so another restaurant's id finds nothing. The list and the
  export read their matches from one SQL function (`_applications_matching`), so a filter
  cannot mean two things. One statement counts and reads, so the file is of one moment.
- **Owner only** (`applications.export`), 30 an hour, at most 5,000 applications a file
  (422 `export_too_large` above that, with the count). Each export is written to the audit
  log **before** the rows are returned, and if that cannot be written nothing is returned.
  The entry says how many, which kind and format, never whose.
- **The files are made in the browser**, by a module loaded only when an export is asked
  for. The workbook is written with `write-excel-file`; the Excel table (the filter buttons)
  is added through that library's extension point (`export/excel-table.js`). Everything an
  applicant typed is stored as text, never as a formula. In CSV, a value that a spreadsheet
  would run as a formula is given a leading apostrophe.

| Method and path | Permission | Notes |
|---|---|---|
| `POST /applications/export/preview` | applications.export | `{scope, filters?, ids?}` -> `{count, requested, limit, exportable}`. Hands over nobody's details. |
| `POST /applications/export` | applications.export | The same body plus `format` (`xlsx`, `csv`). -> `{count, generated_at, restaurant, applications[]}`. |

### Writing to an applicant

An owner or a manager answers an applicant from the application's page. Added 2026-10-13.

```
Application page -> "Start from" (5 beginnings) -> subject + message -> confirm -> POST /applications/{id}/messages
   dash_application_message_create   a row, status "sending", recipient = the application's own address
   EmailSender.send                  Brevo (or Resend) HTTP API, sender = EMAIL_FROM, reply-to = recruitment_email
   dash_application_message_result   "sent" + the provider's message id, or "failed" + why; an event in the history
GET /applications/{id}               asks the provider about "sent" messages -> delivered | bounced | blocked
```

- **The request chooses the words and nothing else.** The recipient is read from the
  application by the database; the sender is the backend's `EMAIL_FROM`; an applicant's
  reply goes to the restaurant's `recruitment_email`. The body is `{kind, subject, body}`
  and any other field is refused (422). `src/dashboard/views/applications.js` has no box
  for an address.
- **What is typed is text.** In the HTML part every character is escaped
  (`dashboard/messages.ts`, `applicantEmail`); the subject is one line. The only link in
  the email is the restaurant's own website.
- **Recorded before it is sent.** A message exists as a row (who wrote it, when, to which
  address, the words) before the provider is called, and is updated with the outcome. The
  application's history gets `message_sent` or `message_failed`; the audit log gets
  `APPLICATION_MESSAGE_SENT` with the kind and the outcome only.
- **Four words for what became of it, and they mean different things.** `sent`: the
  provider accepted it. `delivered`: the provider reports that the recipient's mail server
  took it. `bounced` / `blocked`: the provider reports that it did not arrive. `failed`:
  it never left. The dashboard shows "Delivered" for the second only. The provider is asked
  when the application is opened, at most once a minute per message, for a week.
- **Once.** The page sends an `Idempotency-Key` per message, so a second press or a retry
  after a lost answer is the same message. A message that failed can be sent again
  ("Try again": same words, same recipient); one that went cannot.
- **Limits.** `applications.message` (owner, manager). 60 an hour per person. Subject up to
  150 characters, message up to 5,000. Messages are deleted with their application, so the
  retention period covers them.
- **Telling the applicant about a new status** (the client's request, 2026-10-13). When the
  status is changed on the application's page, a box "Email {name} about the new status"
  is shown, ticked, with the exact email under "See the email". Saving with it ticked sends
  `notify_applicant: true`; the server sends its own text for that status
  (`dashboard/status-emails.ts`: Reviewing, Shortlisted, Interview, Hired, Rejected; New has
  none) through the same path as a written message (kind `status_update`, same record,
  same delivery tracking, same hourly budget). Only when the status really changes, so a
  second press sends nothing. The note is never part of it. The change is saved first: an
  email that cannot be sent does not undo it, and is kept as "Not sent" to try again.

| Method and path | Permission | Notes |
|---|---|---|
| `POST /applications/{id}/messages` | applications.message | `{kind, subject, body}`, `Idempotency-Key`. -> `{result: sent\|failed, message, messages[], notice}`. |
| `POST /applications/{id}/messages/{message}/retry` | applications.message | Only a message whose status is `failed`; 409 otherwise. |
| `GET /applications/{id}` | applications.read | Now also `messages[]`, oldest first, after asking the provider about the unsettled ones, and (with applications.message) `status_emails`, the email each status would send. |
| `PATCH /applications/{id}` | applications.manage | `{status, note?, notify_applicant?}`. With `notify_applicant` also applications.message and the message budget, checked before anything changes. -> `{result, email: null \| {result: sent\|failed, to_email}, application, message}`. |

### The daily schedule and the monthly report

A sixth function, `scheduled-tasks`, is called once a day by the database itself
(`pg_cron` through `pg_net`; `supabase/schedule-daily-tasks.sql`). Added 2026-10-13.

```
pg_cron 13:15 UTC -> net.http_post(scheduled-tasks, x-cron-secret from Vault)
   purgeExpiredApplications, housekeeping, purgeOrphanedCategoryPhotos     (as before, now daily)
   sendMonthlyReports: for each restaurant
       reportPeriod(now, restaurants.timezone)   the month before, midnight to midnight THERE
       monthly_report_claim                      one row per restaurant and month; false = not owed
       monthly_report_data                       counts for exactly that month
       EmailSender.send -> monthly_report_finish  sent + provider id, or failed + why
```

- **Who may call it.** Only a caller presenting `CRON_SECRET` (at least 32 characters,
  compared in constant time). Until the secret is set the function answers 503 to
  everyone. It takes no input and answers with counts only.
- **A month is sent once.** `monthly_reports` has one row per restaurant and month.
  `monthly_report_claim` takes it; a month that is `sent` can never be taken again, and one
  being sent by another call is left alone for fifteen minutes. So the scheduler calling
  daily, twice at once, or again after a failure, sends one report. A month that could not
  be sent is tried again at the next call. (If the provider accepted a report and the
  database could not then be told, that month would be sent a second time the next day:
  at-least-once was chosen over possibly-never.)
- **Whose month.** Each restaurant has an IANA time zone (`restaurants.timezone`, default
  `America/Los_Angeles`). The month's first and last instants are worked out on that clock
  in TypeScript (`scheduled/monthly-report.ts`, `reportPeriod`), across daylight-saving
  changes, and handed to SQL as instants.
- **What it reports.** Only what this system records: applications (received, by position,
  by stage, with a CV, waiting), messages to applicants and how many the provider confirmed
  delivered, Clover connection and synchronisations, the menu as it stands, changes made in
  the dashboard, errors logged, the team. **What it does not record is named as not
  available, with the reason**: visitors (the site has no analytics and sets no cookies),
  orders and sales (they are Clover's and never pass through here), releases. No figure is
  estimated. No applicant is named.
- **Where it goes.** `restaurants.report_email`, or `recruitment_email` while that is
  empty. A restaurant with neither, or a backend with no email provider, is counted as
  `not_configured` and nothing is recorded against the month: it goes in full at the first
  call after the configuration is there.
- **Seeing what happened.** `monthly_reports` (status, address, provider id, error,
  attempts, the figures); the activity log (`MONTHLY_REPORT_SENT` / `_FAILED`);
  `cron.job_run_details` and `net._http_response` for the call itself.

### Two-step sign-in

Supabase Auth's own multi-factor sign-in (an authenticator app, TOTP). This system adds no
authentication of its own and keeps no secret: the dashboard calls Supabase's client to
enrol, and Supabase checks every code.

- **Dashboard:** *Security* turns it on (scan a QR code, prove it with a code) and off. At
  sign-in an account that has it on is asked for the code after the password, and nothing
  of the dashboard is drawn until it is given.
- **Backend:** on every request `authenticate` reads two facts Supabase states about the
  session, whether the account has a verified factor and the session's level (`aal1` or
  `aal2`, see `_shared/auth-level.ts`), and answers 403 `mfa_required` to a session that has
  the password but not the code. So a stolen password alone opens nothing.
- It is each account's own choice; an account that has not turned it on signs in as before.

### Clover: when a token is rejected

One "unauthorized" answer from Clover is not treated as the end of a connection.

1. The request is tried once more: with a refreshed token for an OAuth connection, with the
   same token after 1.5 s for a merchant API token (which cannot be refreshed). Clover did
   not process a request it answered 401, so the repeat cannot duplicate a write.
2. A second 401 is one failed attempt. It is counted on the connection
   (`auth_failures`, `auth_failing_since`), the sync or the save fails with
   `clover_unauthorized`, and the stored token is left alone.
3. For two minutes after a rejection, visitors to the website do not set off another attempt.
4. The connection is marked `needs_reauth` only when there have been 3 such attempts in a row
   over at least 10 minutes. From then nothing is sent to Clover until the owner enters a new
   token. Clover refusing to *refresh* an OAuth token is still final at once: that is Clover
   saying the authorisation is gone.
5. The first request Clover accepts clears the count.

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
never leaves a file without its record.

There is no scheduler, so it runs on the back of ordinary requests. `upkeep` in the same
file is called after the answer to every `public-menu` and `public-site` request, and does
its work about once an hour, whichever request comes first: each running copy of the backend
asks the database at most hourly, and the database lets one of them through. So expired
applications go within about an hour of anyone at all opening the website, not only when an
application arrives or an owner opens the dashboard (those two still trigger it directly).
The same hourly pass calls `housekeeping()`, which clears rows that are only of use for a
while: rate-limit counters over two days old, idempotency keys over a week, sync history
over 30 days, integration logs over 90 days, abandoned connection attempts. The audit log is
kept. It also deletes the photo of a category that Clover has not had for 30 days, when
nothing else shows the same file (`purgeOrphanedCategoryPhotos`): the file first, then the
row's reference, so a pass that is interrupted is finished by the next. A day with no visitor at all runs nothing; `DEPLOYMENT_CHECKLIST.md` says how to add a
schedule if the privacy policy needs a guaranteed day.

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
| `POST /categories/{id}/items/reorder` | menu.write | Website order of items in a category (`ids`, in order; items not named keep their order after them). Used by the dashboard's Item order page (`#/categories/{id}/items`, reached by "Arrange items" on the Categories page). Clover is not called; synchronisation keeps the order and puts an item new to the category at the end. An unknown or another restaurant's category answers 422, the same as everywhere else. |
| `GET /modifier-groups`, `POST /modifier-groups`, `PATCH /modifier-groups/{id}` | menu.read / menu.write | Groups |
| `POST /modifier-groups/{id}/modifiers`, `PATCH /modifier-groups/{id}/modifiers/{mid}` | menu.write | Modifiers |
| `GET /clover` | menu.read | Connection status. Never contains token material. |
| `POST /clover/connect`, `/clover/complete`, `/clover/disconnect` | clover.manage | OAuth start, finish, disconnect |
| `POST /clover/sync` | clover.sync | Manual sync |
| `GET /applications` | applications.read | Job applications, newest first. `search, status, position, from, to` (instants; `to` is exclusive), `limit, offset`. Returns `total`, the page, `counts` by stage and the `positions` applied for. |
| `GET /applications/summary` | applications.read | `{new, total}`: the number beside "Applications" in the sidebar |
| `GET /applications/{uuid}` | applications.read | One application in full, with its history |
| `PATCH /applications/{uuid}` | applications.manage | `{status, note?}`. Stages: `new, reviewing, shortlisted, interview, hired, rejected`. |
| `GET /applications/{uuid}/cv` | applications.cv | The CV's bytes, as a download. Recorded in the history and the audit log. |
| `DELETE /applications/{uuid}` | applications.manage | Deletes the application, its CV and its history for good: for an applicant who asks. The file first, so a failure leaves the application in place. |
| `GET /activity?before=<id>` | activity.read | Audit log, 30 per page. Entries about the team name the person only to a caller with `team.manage`. |

The team and export routes are in their own sections above. `GET /overview` carries the
latest entries of the activity log only for a caller who may open the log.

Per-user rate limits apply to every route (see `dashboard/router.ts`).

## 6. Data model

Defined in `supabase/migrations/`. Twenty-two tables:

| Table | Holds |
|---|---|
| `restaurants`, `restaurant_users` | Tenants and memberships. A membership also carries, for display only, the member's address, who invited them and when they last opened the dashboard. |
| `team_invitations` | An owner's offer of a role to an address: `owner`, `manager` or `staff`, who offered it, when it runs out, whether it was accepted or cancelled. Grants nothing by itself. |
| `clover_connections` | One Clover merchant per restaurant, encrypted tokens, sync state and locks |
| `oauth_states` | One-time nonces for connecting Clover |
| `menu_categories`, `menu_items`, `menu_item_categories` | Mirror plus website data |
| `menu_modifier_groups`, `menu_modifiers`, `menu_item_modifier_groups` | Mirror |
| `sync_runs` | History of sync attempts |
| `audit_logs` | Who did what, with outcome |
| `idempotency_keys` | Outcomes of create requests |
| `job_applications` | Applications (private): the applicant's answers, the CV's place in the private bucket, the stage, whether the notification went out |
| `job_application_events` | What happened to each application, in order (private) |
| `site_photos` | The website photos the owner has chosen: hero, "our story", gallery (see section 5) |
| `menu_labels`, `menu_item_labels` | The restaurant's own labels (name, icon, description, in use, order) and which dishes carry which |
| `site_settings` | One row per restaurant: the allergy notice (on or off, its text per language) |
| `rate_limits`, `integration_logs` | Operational |

Deliberately not created: tables for restaurant info, locations, job positions. Those live in
`content/site.json` and are not editable from the dashboard in this version.

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
- Self-service sign-up. Nobody can make themselves an account: an owner is provisioned by
  the operator, and everyone else is invited by an owner.
- A platform-wide administrator inside the dashboard, and adding or removing owners from it.
- Per-person permissions. What someone may do is their role, and the roles are fixed.
- One account in two restaurants. The backend can hold it; the dashboard opens one.
