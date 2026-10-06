# Clover integration

How this system connects to Clover, what it calls, and what still has to be proven.

**Status: written against Clover's documentation, not yet run against Clover.** There is no
Clover developer account for this project yet, so no request in this document has been sent
to a Clover server. `CLOVER_CAPABILITY_MATRIX.md` lists each capability and its evidence.
`CLOVER_SANDBOX_TEST_PLAN.md` is the list of checks to run once a sandbox exists; part of it
is automated (`npm run test:clover-sandbox`). **This integration is not production-ready
until that plan has been run and its results recorded.**

## 1. What you need from Clover

| Item | Where it comes from | Where it goes |
|---|---|---|
| Sandbox developer account | sandbox.dev.clover.com | n/a |
| App ID and App Secret | Developer Dashboard > Your Apps > App Settings | `CLOVER_APP_ID`, `CLOVER_APP_SECRET` |
| Requested permissions | App Settings > Requested Permissions | Read inventory, Write inventory. Optional: Read merchant (shows the merchant's name) |
| Site URL / redirect | App Settings | `https://luzenarestaurant.com/dashboard/` in production (the test deployment's address for the sandbox app), identical to `CLOVER_REDIRECT_URI`, trailing slash included |
| Webhook URL | App Settings > Webhooks | `https://<project>.supabase.co/functions/v1/clover-webhook` |
| Webhook auth value | Shown by Clover after the URL is verified | `CLOVER_WEBHOOK_AUTH` |
| Region | Where the merchant's Clover account lives | `CLOVER_ENV` = `sandbox`, `na`, `eu` or `la` |
| Production developer account and app approval | Clover | Required before a live merchant can install the app |

Changing the app's permissions later requires the merchant to uninstall and reinstall it.

## 2. Connecting (OAuth v2, authorization code flow)

```
Owner (signed in)            Dashboard                 dashboard-api                 Clover
      | press Connect           |                            |                          |
      |------------------------>| POST /clover/connect       |                          |
      |                         |--------------------------->| create nonce, store hash |
      |                         |<---------------------------| authorize_url, nonce     |
      |                         | keep nonce in sessionStorage                          |
      |<------------------------| redirect to authorize_url ------------------------->  |
      | approve in Clover                                                               |
      |<------------------------------------------- redirect to /dashboard/?code&merchant_id[&state]
      |                         | POST /clover/complete {code, merchant_id, state, nonce}
      |                         |--------------------------->| checks (below)           |
      |                         |                            | POST /oauth/v2/token --->|
      |                         |                            |<--- tokens --------------|
      |                         |                            | encrypt, store, start sync
      |                         |<---------------------------| connected                |
```

The authorization code passes through the browser, as in every code flow. The token exchange
and the tokens never do.

### Checks before the code is exchanged

1. The caller is signed in and has the `clover.manage` permission for the restaurant.
2. If Clover returned `client_id`, it equals our app id.
3. If Clover returned `state`, it equals the nonce.
4. The nonce matches an unexpired attempt started by **this user** for **this restaurant**,
   and is consumed (single use, 10-minute lifetime). Only its SHA-256 hash is stored.
5. The merchant is not already connected to a different restaurant.

### The `state` question (must be settled in the sandbox)

Clover's v2 guides do not document a `state` parameter. This system sends it anyway.

- If Clover echoes it back: nothing to do. Keep `CLOVER_REQUIRE_STATE=true`.
- If Clover does **not** echo it back: every connection attempt will fail with
  `oauth_state_missing`. Only then set `CLOVER_REQUIRE_STATE=false`. Checks 1, 2, 4 and 5
  still apply. What is lost is the proof that this exact authorization response belongs to
  this exact attempt, so an attacker would additionally need the owner to have an open
  attempt (under 10 minutes old) and to visit the attacker's link in the same browser tab
  session. Record the sandbox result in the capability matrix.

A second case: an owner who opens the app from inside Clover's own dashboard arrives at
`/dashboard/` with a `code` but no attempt. The dashboard does not use that code; it tells
the owner to press Connect Clover.

## 3. Tokens

- Stored in `clover_connections`, encrypted with AES-256-GCM. The key
  (`TOKEN_ENCRYPTION_KEY`) exists only in the Edge Function environment. A database dump
  alone does not reveal a token.
- Expirations are read from each token response, never assumed.
- The access token is refreshed when it has less than 2 minutes left, or when Clover answers
  401.
- **Refresh tokens are single use.** Two function instances refreshing at once would
  invalidate each other. `clover_refresh_claim` is a database lock: one instance refreshes,
  the others wait and pick up the rotated token. A test runs two requests concurrently and
  asserts exactly one refresh call.
- If Clover rejects the refresh token, the connection becomes `needs_reauth`. The dashboard
  shows "Reconnect needed". The public menu keeps serving the last synced data.
- Not implemented: Clover's recovery endpoint (`/oauth/v2/recovery`). If a refresh request
  reaches Clover but its response is lost, the stored refresh token is dead and the owner
  must reconnect.
- **Disconnect** deletes the stored tokens. It does not uninstall the app from the merchant;
  the merchant does that in Clover.

## 4. Calls this system makes

All in `supabase/functions/_shared/clover/inventory.ts`. Paths are under
`/v3/merchants/{mId}`.

| Purpose | Call |
|---|---|
| Full sync | `GET /categories?expand=items`, `GET /modifier_groups?expand=modifiers`, `GET /items?expand=categories,modifierGroups`, each paged with `limit=1000&offset=` |
| Read one item | `GET /items/{id}?expand=categories,modifierGroups` |
| Create / update item | `POST /items`, `POST /items/{id}` with `name`, `price`, `priceType`, `available`, `hidden` |
| Find a possibly-created item | `GET /items?filter=name=<name>&filter=modifiedTime>=<ms>` |
| Assign categories / modifier groups | `POST /category_items`, `POST /item_modifier_groups`, and the same with `?delete=true` |
| Categories | `GET /categories`, `POST /categories`, `POST /categories/{id}` (`name`, `sortOrder`) |
| Modifier groups | `GET /modifier_groups/{id}?expand=modifiers`, `POST /modifier_groups`, `POST /modifier_groups/{id}` |
| Modifiers | `POST /modifier_groups/{id}/modifiers`, `POST /modifier_groups/{id}/modifiers/{mid}` |
| Merchant name (optional) | `GET /` |

Never called: any `DELETE`, orders, payments, customers, employees, stock quantities.

Every request has a 10-second timeout, a `User-Agent`, and a correlation id in the logs.
Retry rules are in `ARCHITECTURE.md` section 3.

## 5. From Clover data to the website

`clover/normalize.ts` treats Clover's JSON as untrusted input:

- Ids must be 13 uppercase letters or digits; names must be non-empty. Anything else is
  skipped and counted (`skipped` in the sync statistics).
- `price` must be a non-negative integer (cents), otherwise the price is shown as absent.
- `priceType` outside `FIXED / VARIABLE / PER_UNIT` is treated as `FIXED`.
- `hidden: true` items never reach the public menu. `available: false` items are shown,
  marked "Unavailable today".
- Items Clover marks `deleted`, and items missing from a full sync, are marked removed.

What a customer sees is decided in one SQL function, `public_menu`: not hidden in Clover,
not hidden or archived by the owner, still present in Clover, and in a category that is not
hidden. Items with no category appear under "More".

## 6. Webhooks

Setup, once:

1. Deploy the functions. In Clover App Settings > Webhooks, enter the function URL and send
   the verification code.
2. Read the code from the function log: event `clover_webhook_verification`, field
   `verification_value`. Paste it into Clover and verify.
3. Copy the `X-Clover-Auth` value Clover then shows into `CLOVER_WEBHOOK_AUTH`.
4. Subscribe to Inventory events.

Handling: the header is compared in constant time. For each merchant in the payload with an
inventory event (`I`, `IC`, `IG`, `IM`), the restaurant is flagged for sync and a sync is
started after the 200 response. The payload's contents are never applied directly: it is
only a signal to re-read from the API.

## 7. Ordering

The ORDER ONLINE buttons link to the merchant's Clover Online Ordering page. The restaurant
enables online ordering in its Clover dashboard and gives you the page's URL, which goes in
`ordering.url` in `content/site.json`. Until then, ORDER ONLINE leads to `/order/`, which
says ordering is opening soon and offers the phone number.

To integrate ordering more deeply later, the menu contract (`public-menu`) and the Clover
client are already separate from the pages, so a cart could be added without reworking them.
Nothing of that kind is built.

## 8. Open questions for the sandbox

Listed at the end of `CLOVER_CAPABILITY_MATRIX.md`. The two that can change behaviour are
whether `state` is echoed, and what `hidden: true` does at the register.
