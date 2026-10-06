# Clover capability matrix

What Clover's official documentation says this project can and cannot do, and how much of it
has been proven.

**Read this first.** Every row was checked against docs.clover.com on 2026-10-04 and
2026-10-05. **Nothing has been run against a Clover sandbox or a production merchant**: no
Clover developer account or credentials exist for this project yet. The "Sandbox tested" and
"Production tested" columns are therefore "No" on every row, and they must stay "No" until
someone runs the test and records the date here.

Status values:

| Status | Meaning |
|---|---|
| VERIFIED | Documented by Clover on an official page, and this project's code follows that page. Not the same as tested. |
| NOT VERIFIED | Used or relevant, but the official pages read did not confirm the detail. Treat as an assumption. |
| NOT AVAILABLE | Clover's documentation says the capability does not exist in this API. |
| REQUIRES CLIENT CONFIGURATION | Exists, but the restaurant must set it up or supply a value. |
| REQUIRES CLOVER APPROVAL | Exists, but Clover must approve an account or app first. |
| UNKNOWN | Not documented on the pages read, and not relied on by the code. |

All paths are under `/v3/merchants/{mId}`. Source pages are under `https://docs.clover.com/dev/`.

## 1. Platform and authentication

| Capability | Status | Official documentation | Required permission | Sandbox tested | Production tested | Notes |
|---|---|---|---|---|---|---|
| OAuth v2 authorization code flow (high trust) | VERIFIED | `docs/high-trust-app-auth-flow` | n/a | No | No | Authorize `GET {web}/oauth/v2/authorize?client_id&redirect_uri`; redirect carries `merchant_id`, `client_id`, `code`. |
| Token exchange | VERIFIED | `docs/high-trust-app-auth-flow` | n/a | No | No | `POST {api}/oauth/v2/token` with `client_id`, `client_secret`, `code`. Returns `access_token`, `refresh_token`, and both expirations as Unix timestamps. |
| Token request body is JSON | NOT VERIFIED | Shown in the guide's examples | n/a | No | No | The code sends JSON. Confirm in the sandbox. |
| Refresh | VERIFIED | `docs/refresh-access-tokens` | n/a | No | No | `POST {api}/oauth/v2/refresh` with `client_id`, `refresh_token`. No client secret. |
| Refresh tokens are single use and rotate | VERIFIED | `docs/refresh-access-tokens` | n/a | No | No | "becomes invalid immediately after a new pair is generated". The code serialises refresh with a database lock. |
| Token lifetimes | NOT AVAILABLE as fixed numbers | `docs/refresh-access-tokens` | n/a | No | No | Clover says not to hard-code them. The code reads the expiration from each response. |
| Recovery endpoint `/oauth/v2/recovery` | NOT VERIFIED | Mentioned in `docs/refresh-access-tokens` | n/a | No | No | Not implemented. A lost refresh ends in "Reconnect needed". |
| `state` parameter echoed back | NOT VERIFIED | Not documented in the v2 guides | n/a | No | No | Sent anyway. If absent on return, the connection is refused unless `CLOVER_REQUIRE_STATE=false`. See CLOVER_INTEGRATION.md. |
| PKCE | VERIFIED, not used | `docs/oauth-flow-for-low-trust-apps-pkce` | n/a | No | No | Required only for apps that cannot keep a secret. This backend can. |
| Regional hosts | VERIFIED | `docs/high-trust-app-auth-flow`, `docs/making-rest-api-calls` | n/a | No | No | Sandbox, North America, Europe, Latin America. See `clover/config.ts`. |
| Region of this merchant | REQUIRES CLIENT CONFIGURATION | n/a | n/a | No | No | Set `CLOVER_ENV`. |
| Rate limits | VERIFIED | `docs/api-usage-rate-limits` | n/a | No | No | 16 req/s and 5 concurrent per token; 50 req/s and 10 concurrent per app; HTTP 429; `retry-after` on concurrent limits. |
| Max 3 `expand` fields per call | VERIFIED | `docs/expanding-fields` | n/a | No | No | The code uses at most 2. |
| Page size | VERIFIED | `reference/inventorygetitems` | n/a | No | No | `limit` default 100, maximum 1000; `offset`. |
| List responses wrap rows in `elements` | NOT VERIFIED | Seen in examples only | n/a | No | No | The normaliser also accepts a bare array. |
| Webhooks | VERIFIED | `docs/webhooks` | Matches the event type | No | No | Verification code step, `X-Clover-Auth` header, keys `I`, `IC`, `IG`, `IM`. Must answer 200. |
| Webhook retry behaviour | UNKNOWN | Not on the page | n/a | No | No | Not relied on: a missed webhook is covered by the staleness sync. |
| Dashboard-generated API tokens in production | NOT AVAILABLE | `docs/generate-a-test-api-token` | n/a | n/a | n/a | "Do not use the test merchant API tokens in the production environment." OAuth is required. |
| Production access | REQUIRES CLOVER APPROVAL | `docs/clover-app-approval-process` | n/a | n/a | No | A separate production developer account per region, approved by Clover, then app approval. |
| Private app for one merchant | UNKNOWN | Not on the pages read | n/a | No | No | Ask Clover whether this app needs App Market publication or can stay private. |
| Changing permissions after install | VERIFIED | `docs/permissions` | n/a | No | No | The merchant must uninstall and reinstall the app. |

## 2. Reading the menu

| Capability | Status | Official documentation | Required permission | Sandbox tested | Production tested | Notes |
|---|---|---|---|---|---|---|
| List items | VERIFIED | `reference/inventorygetitems` | Read inventory | No | No | `GET /items`. Expand values: `tags`, `categories`, `taxRates`, `modifierGroups`, `itemStock`, `options`, `ageRestricted`. |
| Item fields: name, price (cents), priceType, hidden, available, modifiedTime | VERIFIED | `reference/inventorycreateitem`, `reference/inventoryupdateitem` | Read inventory | No | No | `priceType`: `FIXED`, `VARIABLE`, `PER_UNIT`. |
| List categories with ordered items | VERIFIED | `reference/categorygetcategories` | Read inventory | No | No | `GET /categories?expand=items`; `items` is documented as an ordered list. |
| Category fields: name, sortOrder, deleted | VERIFIED | `reference/categorygetcategories` | Read inventory | No | No | |
| List modifier groups with modifiers | VERIFIED | `reference/modifiergetmodifiergroups` | Read inventory | No | No | `GET /modifier_groups?expand=modifiers`. |
| Modifier group fields: name, minRequired, maxAllowed, showByDefault, sortOrder | VERIFIED | same | Read inventory | No | No | |
| Modifier fields: name, price, available | VERIFIED | `reference/modifierupdatemodifier` | Read inventory | No | No | |
| Filter items by `name` and `modifiedTime` | VERIFIED | `reference/inventorygetitems` | Read inventory | No | No | Both are in the documented filter list. Exact-match syntax for `name=` is NOT VERIFIED. |
| Item **description** | NOT AVAILABLE | `docs/inventory-faqs` | n/a | n/a | n/a | "part of the Clover Online Ordering system and are not included in the standard Inventory API response". No description field in the item schema. |
| Item **image** | NOT AVAILABLE | `reference/inventoryupdateitem`, `reference/inventorycreateitem` | n/a | n/a | n/a | No image field in the item schema. |
| Online-ordering fields via `expand=menuItem` | UNKNOWN | Not on official pages | n/a | No | No | Mentioned only in community posts. Not used. |
| Merchant name | VERIFIED | `docs/permissions` | Read merchant | No | No | Optional. The code works without it. |
| Opening hours from Clover | UNKNOWN | Not researched | Read merchant | No | No | Hours come from `content/site.json`. |

## 3. Writing the menu (owner dashboard)

| Operation | Status | Official documentation | Required permission | Sandbox tested | Production tested | Notes |
|---|---|---|---|---|---|---|
| CREATE item | VERIFIED | `reference/inventorycreateitem` | Write inventory | No | No | `POST /items`. Required: `name`, `price`. |
| UPDATE item (name) | VERIFIED | `reference/inventoryupdateitem` | Write inventory | No | No | `POST /items/{itemId}`. |
| PRICE UPDATE | VERIFIED | `reference/inventoryupdateitem` | Write inventory | No | No | `price`, integer cents. |
| ENABLE / DISABLE (in stock) | VERIFIED | `docs/managing-item-availability` | Write inventory | No | No | `available: true/false`. With `autoManage: true` Clover sets it from stock. |
| Hide / show in Clover | VERIFIED as a field | `reference/inventoryupdateitem` | Write inventory | No | No | `hidden`. Its exact effect on the register is NOT VERIFIED on the pages read. |
| DELETE item | VERIFIED, deliberately not used | `reference/inventorydeleteitem` | Write inventory | No | No | `DELETE /items/{itemId}`. The docs do not say whether it is permanent. The dashboard never calls it. |
| ARCHIVE item | NOT AVAILABLE in Clover | n/a | n/a | n/a | n/a | No archive concept. Implemented as website-only state in our database. |
| PUBLISH / draft | NOT AVAILABLE in Clover | n/a | n/a | n/a | n/a | Writes are live immediately. No draft layer is built. |
| IMAGE UPDATE | NOT AVAILABLE in Clover | see section 2 | n/a | n/a | n/a | Photos are stored in Supabase Storage only. |
| Description update | NOT AVAILABLE in Clover | see section 2 | n/a | n/a | n/a | Stored in our database only. |
| CREATE category | VERIFIED | `docs/managing-categories` | Write inventory | No | No | `POST /categories`. |
| UPDATE category (rename) | VERIFIED | `reference/categoryupdatecategory` | Write inventory | No | No | `POST /categories/{catId}`. `name` is marked required, so it is always sent. |
| Reorder categories | VERIFIED | `reference/categoryupdatecategory` | Write inventory | No | No | `sortOrder`. One update per moved category. |
| DELETE category | VERIFIED, deliberately not used | `docs/manage-subcategories` | Write inventory | No | No | What happens to a parent category's items is not documented. |
| CATEGORY UPDATE of an item (assign / move) | VERIFIED | `docs/using-object-associations` | Write inventory | No | No | `POST /category_items`, and `?delete=true` to remove. |
| Reorder items inside a category | NOT VERIFIED | `reference/categoryupdatecategory` lists a writable ordered `items` array | Write inventory | No | No | Not used: whether writing it reorders or replaces associations is not stated. Item order is website-only. |
| Subcategories | VERIFIED, not used | `docs/manage-subcategories` | Write inventory | No | No | Out of scope. |
| CREATE modifier group | VERIFIED | `docs/managing-modifier-groups-modifiers` | Write inventory | No | No | `POST /modifier_groups`. |
| MODIFIER UPDATE (group name, min, max) | VERIFIED | `reference/modifierupdatemodifiergroup` | Write inventory | No | No | `POST /modifier_groups/{id}`. |
| CREATE modifier | VERIFIED | `docs/managing-modifier-groups-modifiers` | Write inventory | No | No | `POST /modifier_groups/{id}/modifiers`. |
| MODIFIER UPDATE (name, price, available) | VERIFIED | `reference/modifierupdatemodifier` | Write inventory | No | No | A modifier cannot be moved to another group. |
| Assign modifier group to item | VERIFIED | `docs/using-object-associations` | Write inventory | No | No | `POST /item_modifier_groups`. The body key `modifierGroup` follows the generic "object1/object2" pattern and is NOT VERIFIED verbatim. |
| DELETE modifier / group | NOT VERIFIED, not used | Path inferred, not read on an official page | Write inventory | No | No | Disable with `available: false` instead. |
| Tax rates | VERIFIED as existing, not used | `docs/using-object-associations` | Write inventory | No | No | Tax stays managed in Clover. |
| Stock quantity | VERIFIED as separate endpoint, not used | `docs/managing-item-availability` | Write inventory | No | No | `POST /item_stocks/{itemId}`. Out of scope. |
| Idempotency key on inventory writes | NOT AVAILABLE | `reference/inventorycreateitem` | n/a | n/a | n/a | Not offered. Handled by our own `idempotency_keys` table. |
| Bulk item update endpoint | UNKNOWN | Not found on the pages read | n/a | No | No | Bulk availability is done as individual updates, capped at 50. |

## 4. Ordering

| Capability | Status | Official documentation | Required permission | Sandbox tested | Production tested | Notes |
|---|---|---|---|---|---|---|
| Clover Online Ordering page | REQUIRES CLIENT CONFIGURATION | clover.com product pages | n/a | n/a | No | The restaurant enables it in the Clover dashboard (Online Ordering). |
| URL of the ordering page | REQUIRES CLIENT CONFIGURATION | n/a | n/a | n/a | No | Generated by Clover for the merchant. Set it as `CLOVER_ORDERING_URL` in the server's `site.env` (or `ordering.url` in `content/site.json`). Not supplied yet; the site links nowhere external until it is. |
| Reading the ordering URL through the API | UNKNOWN | Not documented on the pages read | n/a | No | No | Not attempted. |
| Creating orders through the API | Out of scope | n/a | n/a | n/a | n/a | The site does not take orders. |

## What to do first in the sandbox

The full procedure, with a results table to fill in, is `CLOVER_SANDBOX_TEST_PLAN.md`: 20
checks, of which the ones that need only a merchant id and a token are automated
(`npm run test:clover-sandbox`). The six below are the ones whose answers change code or
configuration, so they come first.

1. Complete one OAuth connection. Record whether `state` comes back on the redirect.
2. Confirm the token endpoint accepts JSON and returns expirations in seconds.
3. Run a sync. Confirm list responses use `elements` and that `expand=items` on categories returns an ordered list.
4. Create, rename, re-price and re-categorise an item from the dashboard. Confirm the `item_modifier_groups` body shape.
5. Set `hidden: true` on an item and observe the register and the online ordering page.
6. Register the webhook and confirm an inventory change triggers a sync.

Update the "Sandbox tested" column, with the date, as each one passes.
