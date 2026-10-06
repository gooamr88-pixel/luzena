# Clover sandbox test plan

**Status: not started.** No part of this plan has been run. The Clover integration has only
ever been exercised against a stand-in built from Clover's documentation
(`tests/helpers/fakeClover.js`). Until this plan passes, the integration is **not** production
ready, and the "Sandbox tested" column of `CLOVER_CAPABILITY_MATRIX.md` stays "No".

The plan has two parts:

- **Part A, automated.** `npm run test:clover-sandbox` sends real requests to the Clover
  sandbox using this project's own client code. It needs only a test merchant and a token.
- **Part B, manual.** The steps that need the deployed application and a browser: connecting
  through OAuth, webhooks, disconnecting. Each has an exact expected result.

The twenty tests requested for this project are numbered 1 to 20 below. Each is covered by
Part A, Part B, or both.

| # | Test | Where |
|---|---|---|
| 1 | Connect Clover | B: M-1 |
| 2 | OAuth authorization | B: M-2, A (token endpoint shape, optional) |
| 3 | Callback | B: M-3 |
| 4 | State validation | B: M-4 |
| 5 | Merchant identification | B: M-5 |
| 6 | Read categories | A |
| 7 | Read items | A |
| 8 | Read modifiers | A |
| 9 | Update item | A, B: M-9 |
| 10 | Update price | A, B: M-9 |
| 11 | Update category | A, B: M-9 |
| 12 | Update availability | A, B: M-9 |
| 13 | Modifier changes | A, B: M-9 |
| 14 | Webhook reception | B: M-14 |
| 15 | Sync status | B: M-15 |
| 16 | Sync failure | A (error classification), B: M-16 |
| 17 | Retry | A (headers), B: M-16 |
| 18 | Conflict detection | A (the premise), B: M-18 |
| 19 | Disconnect | B: M-19 |
| 20 | Reconnect | B: M-20 |

---

## Before you start

1. Create a Clover **sandbox** developer account at `https://sandbox.dev.clover.com/developers`.
2. Create a **test merchant**. Add a few categories, items and one modifier group in its
   dashboard so there is something to read. Do not use data you care about.
3. Create an **app** with: REST client type; permissions *Read inventory* and *Write
   inventory* (optionally *Read merchant*); Site URL = the address of your deployed test
   site followed by `/dashboard/`.
4. Install the app on the test merchant.

Never run any of this against a production merchant.

---

## Part A: automated

### Credentials

| Variable | What | How to get it |
|---|---|---|
| `CLOVER_SANDBOX_MERCHANT_ID` | The test merchant's 13-character id | In the address bar of the sandbox merchant dashboard |
| `CLOVER_SANDBOX_TOKEN` | An API token with Inventory read and write | Sandbox merchant dashboard > Settings > API tokens > Create new token. Clover allows these tokens in the sandbox only. |
| `CLOVER_SANDBOX_APP_ID`, `CLOVER_SANDBOX_REFRESH_TOKEN` | Optional. Enables the token-endpoint test. | The app id from the developer dashboard; a refresh token from a completed OAuth connection. **That test uses the refresh token up**, so do not give it one a running deployment depends on. |

### Run

Put the two values in a file named `.env.clover-sandbox.local` in the project folder
(git-ignored; never paste them into a chat or a commit):

```
CLOVER_SANDBOX_MERCHANT_ID=XXXXXXXXXXXXX
CLOVER_SANDBOX_TOKEN=...
```

then:

```powershell
npm run test:clover-sandbox
```

The test configuration reads only `CLOVER_SANDBOX_*` names from that file and prints none of
them. Setting the same names in the shell works too, and wins over the file. Without them
every test is reported as skipped, with a note saying why.

### What it does

It creates one item, two categories and one modifier group, all named
`ZZ-LUZENA-TEST ...`, exercises them, and deletes them at the end. The delete is done by the
test for clean-up only; the application itself never deletes anything in Clover. The last
test checks the clean-up: nothing named `ZZ-LUZENA-TEST` is left, the test item answers "not
found", and the count of the merchant's own items is unchanged. It also removes anything
with that prefix that an interrupted earlier run left behind.

### What each test settles

| Test | Settles |
|---|---|
| [6] reads categories | List responses are wrapped in `elements` (UA-5). `expand=items` returns the category's items. |
| [7] reads items | Field names and types. `limit` and `offset` page as documented. |
| [8] reads modifier groups | `expand=modifiers` shape. |
| [7] whole inventory through the normaliser | Nothing in real Clover data is silently dropped by `normalize.ts`. |
| [9] create item | The create response carries what the mirror needs, including `modifiedTime` in milliseconds. |
| [9] find by exact name | `filter=name=` is an exact match (UA-9). This is what stops a retry creating a duplicate. |
| [9] rename, [10] price, [12] availability, [12] hidden | Each write lands and reads back; a partial update does not reset other fields. |
| [11] categories | Create, rename, `sortOrder`; assigning and moving an item with `category_items`. |
| [13] modifiers | Create group with limits, create and edit a modifier; the `item_modifier_groups` body really uses the key `modifierGroup` (UA-8). |
| [16] bad token, missing object, invalid write | The client classifies each failure correctly and does not retry what must not be retried. |
| [17] rate-limit headers | Records which rate-limit headers Clover actually sends. Informational. |
| [18] outside change is visible | A write that did not come from the dashboard shows on the next read, which is what conflict detection depends on. |
| [2] refresh endpoint (optional) | The token endpoint accepts a JSON body (UA-4); expirations are in seconds; the refresh token rotates. |

### Recording the result

For every test that passes, set "Sandbox tested" to `Yes (date)` on the matching rows of
`CLOVER_CAPABILITY_MATRIX.md`, and mark the matching `UA-` entry in `PROJECT_MEMORY.md` as
resolved. For every test that fails, **do not adjust the test to pass**: the failure means
Clover behaves differently from its documentation or from our reading of it. Record what
Clover actually did, then change the code in `supabase/functions/_shared/clover/`, change
`tests/helpers/fakeClover.js` to match reality, and re-run `npm test`.

---

## Part B: manual, against the deployed test environment

Deploy the functions to the **test** Supabase project with `CLOVER_ENV=sandbox` and the
sandbox app's id and secret, and run the test site against it: `npm run build:staging` then
`npm run preview:staging`, which serves it at `http://localhost:4173` (see
`DEPLOYMENT_CHECKLIST.md` section 3). The sandbox app's Site URL and `CLOVER_REDIRECT_URI`
are then both `http://localhost:4173/dashboard/`. If Clover's sandbox refuses a localhost
address, the test site needs a public https address of its own; none exists yet.
Sign in to the dashboard as the owner. Keep the function logs open
(Supabase dashboard > Edge Functions > dashboard-api > Logs).

Fill in the Result column as you go.

| ID | Do this | Expect | Result |
|---|---|---|---|
| M-1 | Dashboard > Clover. Press **Connect Clover**. | The browser goes to `sandbox.dev.clover.com/oauth/v2/authorize` with `client_id`, `redirect_uri`, `response_type=code` and `state` in the address. The app secret appears nowhere in the address or the page source. | |
| M-2 | Approve the app for the test merchant. | Clover returns to `<site>/dashboard/?merchant_id=...&client_id=...&code=...`. | |
| M-3 | Wait for the dashboard to finish loading. | The Clover page shows **Connected**, the address bar no longer contains `code`, and a "Clover connected" toast appears. The log has no `clover_oauth_rejected` or `clover_oauth_exchange_failed`. | |
| M-4 | Look at the address Clover returned you to in M-2 (browser history). **Is `state=` present?** | **This is the one open question that changes configuration.** If present: keep `CLOVER_REQUIRE_STATE=true`. If absent: M-3 will have failed with "Clover did not return the verification value"; set `CLOVER_REQUIRE_STATE=false`, redeploy the functions, repeat M-1 to M-3, and record it in the capability matrix. | |
| M-4b | Start a connection, then on return edit `state=` in the address before the page loads (or replay yesterday's return address). | Refused: "could not be verified" or "this connection attempt has expired". Nothing is stored. | |
| M-5 | Clover page, Merchant row. | The test merchant's id, and its name if the app has *Read merchant*. In the database, `clover_connections` has one row for the restaurant; `access_token_enc` starts `v1.` and contains no readable token. | |
| M-5b | Create a second restaurant and owner. Try to connect the **same** test merchant. | Refused: "already connected to another restaurant". | |
| M-6 | Items, Categories and Modifiers pages after the first sync. | They match the test merchant's inventory. Items hidden in Clover are listed, labelled "Hidden in Clover". | |
| M-7 | In the dashboard, tick **Hide in Clover** on an item and save. Look at the item in the Clover Register app and on Clover Online Ordering. | **Record what `hidden` does in each place.** The website already stops showing it. This fills the open row in the capability matrix. | |
| M-9 | Edit one item in the dashboard: name, price, category, in stock, modifier group. Save. | "Saved to Clover and updated on the website." The Clover merchant dashboard shows every change. The public menu shows them within a minute. Activity lists "Item updated", Done, SYNCED. | |
| M-9b | Add an item, a category, a modifier group and a modifier from the dashboard. | Each appears in Clover exactly once. | |
| M-9c | Reorder categories and save the order. | Clover's category order changes to match. | |
| M-14 | In the Clover developer dashboard set the webhook URL to `<supabase>/functions/v1/clover-webhook` and press Send Verification Code. Read the code from the `clover-webhook` log (event `clover_webhook_verification`). Verify, copy the `X-Clover-Auth` value into `CLOVER_WEBHOOK_AUTH`, subscribe to Inventory. | Verification succeeds. | |
| M-14b | Change an item's price **in the Clover merchant dashboard**. Do not touch our dashboard. | Within about a minute our Items page (after a refresh) and the public menu show the new price. `sync_runs` has a row with trigger `webhook`. **Do not assume this works: if no webhook arrives, record it.** The price must still appear within 5 minutes through the staleness sync, when the public menu is next loaded. | |
| M-14c | Send the webhook URL a POST with a wrong `X-Clover-Auth`. | 401. Nothing syncs. | |
| M-15 | Clover page. Press **Sync now**. | "Menu synchronised with Clover." Last sync and Last successful sync update. Overview shows Connected. | |
| M-16 | In the Clover merchant dashboard, uninstall the app from the test merchant. Back in our dashboard press **Sync now**, then try to edit an item's price. | The sync fails and the Clover page shows the failure, or "Reconnect needed". The edit is refused with a message that nothing was changed. The public menu still shows the last synced menu. Overview lists the sync error. **Record exactly which message appears**: how Clover answers a revoked token is not documented on the pages read. | |
| M-16b | Reinstall the app on the test merchant and connect again (M-1 to M-3). Press Sync now. | Succeeds; the error clears; website-only data is intact. | |
| M-17 | While M-14b is running, press Sync now several times quickly. | "A synchronisation is already running", never two syncs at once (`sync_runs` shows no overlapping rows). No rate-limit error from Clover. | |
| M-18 | Open an item in the dashboard. In the Clover merchant dashboard change that item's price. Back in our editor, change the price to something else and save. | "This item was changed in Clover while you were editing. Nothing was saved." Both prices are shown. "Use Clover's values" loads Clover's price. Clover still has the price set in Clover. | |
| M-18b | Repeat, but in Clover change only the item's **stock**; in our editor change the **price**. | Saves normally. An unrelated change is not a conflict. | |
| M-19 | Clover page. Press **Disconnect**, confirm. | Not connected. The public menu still shows the last menu. Editing an item says Clover is not connected. `clover_connections` has no row for the restaurant. | |
| M-20 | Press **Connect Clover** again and approve. | Connected. The menu re-syncs. Descriptions, photos, featured flags and hidden-on-website settings made before the disconnect are all still there. | |

### Also record

- How long an access token lasts (the difference between the Connected time and
  `access_token_expires_at`). The code does not assume a number, but it is worth knowing.
- Whether a refresh happened without anyone noticing: leave the test environment running
  past one access-token lifetime, then edit an item. It must simply work.

---

## After the sandbox passes

Sandbox success is necessary, not sufficient, for production:

1. Clover must approve a **production** developer account and the production app. Clover's
   documentation (read again 2026-10-06, `docs.clover.com/dev/docs/approval`): "You can
   launch an integrated app for a merchant after both the app and the associated developer
   account are approved", and production must use OAuth tokens, not a merchant's dashboard
   token. It gives **no time for the review**. Until both approvals exist, no real
   merchant can be connected, whatever state the code is in. Start this as early as
   possible: it is the one step nobody on this project controls.
2. Whether this app can stay private to one merchant or must be listed is a question for
   Clover (open row in the capability matrix).
3. Repeat M-1 to M-5, M-9, M-14b and M-15 once against the real merchant, in a quiet hour,
   editing one item and changing it back.
