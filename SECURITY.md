# Security

What is protected, how, what the 2026-10-05 review found, and what is not covered. Every
control below exists in the code; the test that exercises it is named where there is one.

**Scope of the evidence.** Almost all of this was verified on one development machine:
against a real Postgres engine (PGlite), with the Edge Functions executed under Deno, and in
a real browser under the production security headers. Nothing has talked to Clover.

**One part has been verified on a real Supabase project.** On 2026-10-05 the migrations were
applied to the TEST/STAGING project (`cgxhifkeoesvsycewwfs`) and the database controls were
checked there with `npm run verify:database`, by query and by acting as each role: row
level security on all 16 tables, no policies, no privilege for `anon` or `authenticated` on
any table, sequence or function, new objects closed by default, `cvs` bucket private, no
storage policies, and the backend's role able to do its work (30 checks). The functions are
not deployed there yet, so the API-level controls have not been checked on real
infrastructure.

**The production project (`xqzpuqjrlrxyitjubkqk`, us-west-1) was verified separately** the
same day, because a pass on one project proves nothing about another: the same five
migrations, `npm run verify:database` 30 of 30, and `npm run verify:public-access`, which
uses only the public key from outside: reading five tables, inserting, deleting, calling
three functions, listing, uploading to and downloading from storage were all refused.

**One thing is open on production:** new projects allow anyone to sign up. Such an account
belongs to no restaurant and the database grants it nothing, so it can see and do nothing,
but only the owner should have an account. Switch off "Allow new users to sign up"
(Authentication > Sign In / Providers) on both projects before deploying anything.
`verify:public-access` fails until it is off.

## 1. Review summary (2026-10-05)

| Area | Verdict | Evidence |
|---|---|---|
| Row level security | Enabled on all 16 tables, no policies, every privilege on tables, sequences and functions revoked from `anon` and `authenticated`, and new objects closed by default | `sql.test.js` "access control at the database"; `npm run verify:database` on the test project 2026-10-05 |
| Tenant isolation | Enforced at the API, in every SQL function, and by privileges | `sql.test.js` "tenant isolation"; `dashboard.test.js` "never serves one restaurant's items to another restaurant's owner" |
| Authentication | Supabase Auth JWT verified on every dashboard request; no custom password code | `dashboard.test.js` "rejects a request with no session", "rejects an invalid session token"; Deno smoke "refuses a forged token" |
| Authorisation | Role checked on the server per route; staff cannot write | `dashboard.test.js` "enforces roles on the server" |
| IDOR | Ids matched against the caller's own restaurant before use; foreign ids get the same 404/422 as missing ones | `dashboard.test.js` "ignores a restaurant id the user does not belong to", "refuses the whole request if any id is not the restaurant's" |
| API and input validation | Strict schemas, unknown keys rejected, sizes capped | `dashboard.test.js` "rejects unknown fields, bad prices and malformed ids"; `units.test.js` "request validation" |
| File upload (photos) | Signed-in writers only, 1 MB, type sniffed from bytes, SVG refused, server-built path | `dashboard.test.js` "item photos" |
| CV upload | 5 MB, PDF/DOC/DOCX by content and extension, scripts and macros refused, private bucket, sanitised name | `public.test.js` "rejects an executable renamed to .pdf, a wrong extension, and a macro document" |
| XSS | No `innerHTML` anywhere (now a lint error); build-time escaping; CSP without `unsafe-inline` | `eslint.config.js`; `browser/public.spec.js` "sends the policy, and the pages work under it" |
| SQL injection | Bound parameters only; search wildcards escaped | `sql.test.js` "treating % and _ literally" |
| Secret handling | Secrets only in function environment; tokens encrypted; logs redacted | `dashboard.test.js` "never exposes token material", "stores tokens encrypted"; Deno smoke "no secret in the function's log output" |
| CORS | Allow-list; other origins get no CORS header | `dashboard.test.js` "sends CORS headers only to the allowed origin"; Deno smoke |
| Rate limiting | Every dashboard route, the application form, and (added in this review) the public menu | `public.test.js` "limits how fast one address can ask for the menu" |
| Webhook validation | Shared secret compared in constant time; payload never applied directly | `public.test.js` "rejects a notification without the shared secret" |
| Clover OAuth state | Single-use nonce bound to user and restaurant; `state` required by default | `dashboard.test.js` "completes OAuth only for the attempt this owner started" |
| Sessions and cookies | **No cookies are used at all.** See section 3. | n/a |
| Error message safety | Clients get a code, a sentence, a request id. No stack, no upstream text | `dashboard.test.js` "never leaks a stack trace"; Deno smoke "answers a database outage with the safe message" |
| Personal data | Applications off by default; retention configurable and enforced | `public.test.js` "the operator's switch", "retention" |

### Found and fixed in this review

| Finding | Fix |
|---|---|
| The public menu endpoint had no rate limit: anyone could make it read the database in a loop. | 120 requests per minute per address, answered with the same generic message and `Retry-After`. Addresses are stored only as salted hashes. |
| Job applications had no retention: rows and CVs would have been kept for ever. | `JOB_APPLICATION_RETENTION_DAYS` with automatic deletion of rows and files; no default, and no applications accepted until it is set. |
| Applications could be collected before a privacy policy existed. | Two independent switches, both off by default: the site does not publish the form, and the backend refuses submissions. The site will not build with the form on and no policy. |
| Nothing stopped a placeholder link (the sample ordering address) being published. | The production build refuses placeholder hosts for the ordering link, the site address, the Maps link, social links and the privacy link. |
| `innerHTML`, `eval` and `localStorage` were avoided by convention only. | Lint errors (`npm run lint`). |
| The Edge Functions' entry files and Supabase wiring had never been executed. | `npm run check:deno` type-checks and runs them under Deno. |
| Development stock photos sat in the repository with only a build rule keeping them out of production. | A test asserts the real content references no sample asset, and a browser test fails if any photograph is in the production build. On the server the repository checkout is never the web root: Nginx serves only the built release, the deploy script refuses a build carrying the sample banner, and `npm run verify:site` fails if a repository file can be fetched from the site. |
| **Found on the real project, not by the tests:** Supabase gives `anon` and `authenticated` rights on every new sequence. The migrations revoked tables and functions but not sequences, so two id sequences (audit and integration logs) were readable and advanceable by the public roles. They hold no data and are not reachable through the REST API, but the rule is that the public roles hold nothing. | Migration `..500_sequence_privileges.sql` revokes them and makes future tables and sequences start closed. The test database now starts with Supabase's real default privileges, so the tests would catch this class of gap; before, they ran on a database that was never open in the first place. |

### Reviewed and left as they are

| Item | Why |
|---|---|
| The dashboard's Supabase session is in `localStorage`. | This is how the Supabase client works on a static site; there is no server to hold a cookie. Mitigations in section 3. |
| `connect-src` and `img-src` allow `https://*.supabase.co`. | The project host does not exist yet. Narrow it after deployment (`BLOCKERS.md` N-8). |
| The webhook's verification branch answers 200 to anyone and writes one log line. | It is how Clover's one-time setup works. It changes no data. An attacker can add log lines, nothing else. |
| No antivirus scan of CVs. | No scanning service is part of the stack. The content checks are a filter, not a guarantee. See section 6. |
| The owner's email address is shown on the public site. | The client supplied it as the restaurant's contact email. It will attract spam; a role address on the restaurant's domain would be better. |

## 2. Secrets

| Secret | Lives in | Never in |
|---|---|---|
| Clover app secret | Edge Function secrets | Frontend, database, logs |
| Clover access and refresh tokens | Database, AES-256-GCM encrypted | Frontend, logs, any API response |
| Token encryption key | Edge Function secrets | Database, repository |
| Supabase service-role key | Injected into Edge Functions by Supabase | Frontend, repository |
| Email provider key | Edge Function secrets | Frontend |
| Webhook shared secret | Edge Function secrets | Frontend |

- The frontend receives two values, both public by design: the Supabase URL and the anon
  key. With RLS on and no policies, the anon key can read and write nothing.
- `.gitignore` excludes every `.env` file except the `.example` templates.
- Logs pass through `redact()`, which blanks any field whose name looks like a credential.

Rotating `TOKEN_ENCRYPTION_KEY` makes stored tokens unreadable. Every restaurant must then
reconnect Clover. There is no re-encryption tool.

Where each setting belongs, per environment: `docs/CONFIGURATION.md`.

## 3. Authentication and sessions

- Supabase Auth, email and password. No custom password handling exists in this code.
- Sign-up is disabled (`supabase/config.toml`). The operator creates owners.
- Access tokens last one hour; refresh tokens rotate (`config.toml`).
- **No cookies.** The dashboard API authenticates with a bearer token in a header. There is
  therefore no cookie to mark `Secure`, `HttpOnly` or `SameSite`, and no cookie-based CSRF.
- The Supabase client keeps the session in `localStorage`. The risk is injected script
  reading it. Mitigations: a Content-Security-Policy with no inline script and no
  third-party script origin (verified in a real browser), no `innerHTML` (lint-enforced),
  no third-party scripts at all, a one-hour access token. Clover tokens are never in the
  browser.
- An expired session: the API answers 401, the dashboard refreshes the token once and
  repeats the request, and if that fails it signs the owner out to the sign-in form.
- Sign-in and password reset give the same answer whether or not an email has an account.

## 4. Authorisation and tenant isolation

Enforced on the server in three independent layers:

1. **API.** `authenticate()` verifies the JWT, then loads the user's restaurants from the
   database. `requirePermission()` checks the role. Neither trusts anything in the request
   body or URL.
2. **SQL functions.** Every function takes `p_restaurant` and filters by it. A write to
   another tenant's item returns null.
3. **Database privileges.** RLS on every table with no policies; table privileges revoked
   from `anon` and `authenticated`; functions executable only by `service_role`.

Never trusted from the client: the restaurant id, the role, ownership of an item, and Clover
identifiers. The `x-restaurant-id` header only chooses among restaurants the user already
belongs to. Clover ids are matched against the restaurant's own mirror (`menu_known_ids`)
before any Clover call. Unknown fields in a request body are rejected, so
`{"role": "admin"}` or `{"restaurant_id": ...}` is a 422.

## 5. Input validation, injection, XSS, CSRF

- Every request body passes a schema (`validate.ts`): types, lengths, ranges, patterns, no
  control characters, no unknown keys. Prices are integers in cents.
- Clover's responses are validated the same way before they are stored (`normalize.ts`).
- All database access is through SQL functions with bound parameters. No SQL is built from
  strings. Search input has its `%`, `_` and `\` escaped.
- Restaurant text is HTML-escaped by Handlebars at build time. All runtime rendering builds
  DOM nodes with `textContent`. JSON-LD escapes `<`.
- CSRF: bearer-token authentication, an origin allow-list, an `Origin` check on the
  application endpoint, and a single-use nonce on the Clover OAuth return.

## 6. File uploads

**CVs** (`job-application`):

- 5 MB limit, checked on the declared length and again on the bytes read.
- Type decided from the file's own bytes: PDF, legacy DOC, or DOCX. The extension must
  agree. The browser-supplied MIME type is ignored. Executables, scripts, HTML and renamed
  files are rejected.
- PDFs containing `/JavaScript` or `/Launch`, and DOCX files containing a VBA project, are
  rejected.
- Stored in a **private** bucket under a server-generated path
  (`<restaurant>/<uuid>.<ext>`). The original name is sanitised and kept only as a label.
- Deleted with the application when the retention period passes.

**Item photos** (`dashboard-api`): signed-in users with `menu.write` only; 1 MB; type sniffed
from bytes (JPEG, PNG, WebP; SVG refused); path built from tenant id, item id and a content
hash. The dashboard re-encodes photos in the browser first, which also strips EXIF location
data, but the server does not rely on that.

**Not covered:** no antivirus scan. The active-content check does not see inside compressed
PDF streams. The recruiter receives the CV as an email attachment and should treat it like
any file from a stranger.

## 7. Rate limits

| Surface | Limit |
|---|---|
| Public menu | 120 per minute per address |
| Job applications | 5 per hour per address, plus a honeypot field, a minimum fill time and an origin check |
| Dashboard reads | 600 per 5 minutes per user |
| Dashboard writes | 240 per 5 minutes per user |
| Creates | 120 per 5 minutes |
| Bulk actions | 30 per 5 minutes; availability capped at 50 items per request |
| Uploads | 60 per 10 minutes |
| Sync | 12 per 5 minutes |
| Clover connect / complete / disconnect | 10 per 15 minutes |
| Sign-in | Supabase Auth's own limits |

Addresses are never stored: the limiter keys on a salted SHA-256 of the address. Bot-trap
submissions get the same response as a success, so a bot learns nothing.

## 8. Transport and headers

`deploy/headers.json` is the one list of response headers: Content-Security-Policy
(`default-src 'self'`, no inline script or style, `frame-ancestors 'none'`,
`object-src 'none'`), HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Permissions-Policy`. Pages are served `no-cache`, so a visitor never
keeps an old page after a deployment; the dashboard is served `no-store` and `noindex`.

The production Nginx configuration (`deploy/nginx/`) is generated from that list by
`npm run build:nginx`, never written by hand. Nginx drops inherited headers in any
`location` that sets one of its own, which is the usual way a hand-written configuration
ends up serving some paths with no policy; the generator repeats the full set in every
location, and a unit test fails if a location lacks one or if the committed file is stale.

The browser tests serve the site with exactly these headers and fail on any policy
violation, so a change that would break under the policy is caught before deployment.
`npm run verify:site` then compares what the live server actually sends, header by header.

**The web server.** The Hostinger VPS only serves files. It runs no application code,
proxies nothing, and holds no secret: the build variables on it are the public Supabase URL
and publishable key. The certificate is Let's Encrypt, and the site's configuration asks
for TLS 1.2 and 1.3; on a server that shares its ports between sites, the protocols
actually offered are also governed by the server's default site and its TLS library, which
this repository does not control and which have not been tested from outside. `http://`
and `www` redirect to `https://luzenarestaurant.com`, and so does the old spelling of the
domain. Not reviewed here, because it is outside this repository
and has not been seen: the VPS itself (its other sites, users, SSH access, firewall,
updates). Its owner is responsible for those.

## 9. Errors and logs

Clients get a code, a plain sentence and a request id. Stack traces, Clover's response text
and database errors are logged server-side only. Logs are structured JSON with a correlation
id per Clover operation. Not logged: tokens, secrets, passwords, authorization codes,
applicant details beyond an application id.

## 10. Personal data

Job applications hold a name, email, phone, message and optionally a CV.

- **Off by default.** Nothing is collected until the operator switches it on in two places
  and sets a retention period (`docs/CONFIGURATION.md` section 5).
- **Retention.** `JOB_APPLICATION_RETENTION_DAYS` has no default. Once set, applications
  older than that are deleted with their CV files: files first, then rows, so a failed file
  deletion leaves the row to be retried rather than an orphaned CV.
- **Consent.** The form asks for agreement to store the details and be contacted, and links
  to the privacy policy.
- **Where they go.** One email to the restaurant's recruitment address, with the CV
  attached. That address is never sent to the browser.

Still needed from the client (`BLOCKERS.md` B-3, B-4): the privacy policy, and the number of
days.

No analytics or third-party scripts are loaded, so this code sets no cookies and needs no
cookie banner as it stands. Following the Maps or Instagram links leaves the site.

## 11. Reporting a problem

Report suspected vulnerabilities privately to the site operator. Do not open a public issue.
