# Security

What is protected, how, what the 2026-10-05 review found, and what is not covered. Every
control below exists in the code; the test that exercises it is named where there is one.

**Scope of the evidence.** Almost all of this was verified on one development machine:
against a real Postgres engine (PGlite), with the Edge Functions executed under Deno, and in
a real browser under the production security headers. Nothing has talked to Clover.

**One part has been verified on a real Supabase project.** On 2026-10-05 the migrations were
applied to the TEST/STAGING project (`cgxhifkeoesvsycewwfs`) and the database controls were
checked there with `npm run verify:database`, by query and by acting as each role: row
level security on all 21 tables, no policies, no privilege for `anon` or `authenticated` on
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
| Row level security | Enabled on all 21 tables, no policies, every privilege on tables, sequences and functions revoked from `anon` and `authenticated`, and new objects closed by default | `sql.test.js` "access control at the database"; `npm run verify:database` on the test project 2026-10-05 |
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
- Sign-up is disabled (`supabase/config.toml`). The operator creates owners. Since
  2026-10-13 an owner can invite managers and staff: the backend then asks Supabase Auth to
  make the account, with no password, and the person chooses one through Supabase Auth's
  own link. Still nobody can make themselves an account (section 4a).
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

### 4a. Team access (added 2026-10-13)

Until this date one account existed per restaurant. Owners can now invite managers and
staff, change their role and remove them. How it works is in `ARCHITECTURE.md` ("Team and
access"); what protects it is here. **All of it is proven on a real Postgres engine
(PGlite) with a stand-in for Supabase Auth. None of it has run against a real Supabase
project**: see "Not verified" at the end of this section.

| Risk | What stops it | Test (`tests/team.test.js` unless said) |
|---|---|---|
| A restaurant user gains platform-wide access | There is no such role. The role column accepts three values (a check constraint), every route is bound to the caller's own restaurant, and naming another is refused. | "has no platform-wide role" |
| Someone is made an owner from the dashboard | `owner` is on nobody's list of roles to give (`GRANTABLE_ROLES`); the invitation table cannot store it; no SQL function writes it or touches an owner's row. | "only accepts the roles an owner may give", "can never make an owner, change an owner, or change one's own role" |
| A manager or staff member promotes themselves, or anyone | Every team route needs `team.manage`, which only an owner has. A role is never read from the request. | "is refused to managers and staff", the 22-route table in "gives a manager the day-to-day work" |
| An owner locks themselves out, or removes another owner | Nobody changes or removes their own access; an owner's row is never written. The existing owner's access cannot be lost through this API. | "is never something a person does to themselves or to an owner"; the migration test |
| An invitation is used by the wrong person | There is no token. It is found only for the account signed in with exactly that address, and only once Supabase Auth has confirmed the address. Knowing its id is no use to anyone else. | "is only for the account whose own, confirmed address it was sent to" |
| An invitation is used after it should be dead | Expired, cancelled and already-used invitations are refused by the one function that makes memberships; a removed member cannot replay the invitation they once accepted. | "cannot be accepted once it has expired", "...once the owner has cancelled it", "cannot be undone by replaying" |
| One restaurant reaches into another's team | Every function takes the caller's restaurant; another restaurant's member or invitation id is "not found", exactly like a made-up one. | "one restaurant and another" (both tests) |
| A secret leaks | There is none of this system's to leak: no token, no password. Supabase Auth's own set-password link goes into the email and nowhere else: not a response, a log line, the audit log or the database. | "sends the set-password link in the email and puts it nowhere else" |
| A password passes through this system | It cannot: the port that makes accounts (`AccountDirectory.ensure`) takes an address and nothing else. People choose their password with Supabase Auth, as the owner did. | "records the offer, makes an account with no password" |
| Sign-up is opened as a shortcut | It is not touched. Accounts are made only by the backend with the service role, only for an address an owner invited. | (no code path; `supabase/config.toml` unchanged) |
| The form is used to send email to strangers | Owner only; 20 invitations an hour per person; 5 emails a day to one address; 25 open invitations per restaurant. | "cannot be used to pester an address or to pile up invitations" |
| Access outlives its removal | The membership is read on every request, so the next request with the old session is refused: every route, CV downloads and exports included. | "ends every kind of access at once, for the session the person already holds" |
| The database is reached around the API | `team_invitations` has row level security, no policy and no privilege for `anon` or `authenticated`; the 17 new functions are the service role's alone, and none runs with its owner's rights. | "keeps the new table and every new function closed"; `sql.test.js` "access control at the database" |
| The activity log tells managers who was invited | Entries about the team reach a caller without `team.manage` with the person's details removed. The overview's "recent activity" is no longer given to staff at all (they could not open the log, but were handed its latest eight entries: found in this work, fixed). | "what the activity log shows of the team" (both tests) |

**What removal cannot do.** These are limits of the design, not bugs:

- **The Supabase session stays valid** until its token expires (an hour) or the person signs
  out. It opens nothing: the database grants `authenticated` nothing, storage has no policy,
  and this API refuses an account with no membership. Ending the session itself would need
  the operator to delete or ban the account in Supabase.
- **A page left open keeps showing what it had loaded.** Nothing is pushed to it. It is
  cleared the first time it asks the server for anything, and it can load nothing new.
- **A file already downloaded is the person's.** A CV or an export taken while they had
  access cannot be recalled. There are no links to expire: CVs never have an address.
- **The account is not deleted.** Removing a member removes their access, not their
  Supabase Auth account. The operator can delete it in Supabase (Authentication > Users).

**Decisions that differ from what was first proposed**, each deliberate:

| Proposed | Built | Why |
|---|---|---|
| A Platform Admin role | None | Nothing in the product needs one; the operator already works in Supabase. A role that crosses restaurants is the one thing here that could breach tenant isolation by design. |
| Owner can assign owners: "denied by default" | Denied, with no switch | An owner is the operator's to provision. |
| Manager's Clover sync: "only if explicitly authorized" | Allowed, by its own permission `clover.sync` | A manager already writes prices to Clover; refusing them a re-read of it would protect nothing. It is now a permission of its own rather than a side effect of `menu.write`. |
| Manager's export: "denied unless explicitly authorized" | Denied | There are no per-person grants; adding them would be a second permission system. One line in `ROLE_PERMISSIONS` changes it if the owner wants it. |
| Invitation tokens | None | The sign-in is the proof. A token would be one more secret to protect, for no gain. |
| RLS and Storage policies | No policy added | The design is closed by default: no policy, no privilege, and `verify:database` fails a project that has either. A policy would open a path that does not exist today. |

**Verified on the real TEST project on 2026-10-13** (deployed functions, real Postgres,
real Supabase Auth and Storage; a restaurant and accounts made for the run at
`example.test` and deleted after it; 65 of 65 checks, `TESTING.md`):
`auth.admin.createUser({ email, email_confirm: true })` makes an account with a confirmed
address that nobody can sign in to (Supabase gives it a random password of its own that it
tells nobody: the column is not empty, but no password works); the person signs in once a
password is chosen; before accepting, that account opens nothing; another account can
neither see nor accept the invitation by its id; a manager and staff get exactly their
permissions (18 requests); a role change and a removal take effect on the session the
person already holds; a removed person cannot replay the invitation; expired and cancelled
invitations are refused; the account, the restaurant, its owner and its records survive a
removal; public sign-up stays closed. The migration applied, and the database checks of
`verify:database` pass there (24 tables, 102 functions, none open to the public roles).

**Still not verified:**

- That the invitation email, with its one-click set-password link
  (`auth.admin.generateLink({ type: "recovery" })`), arrives and opens the dashboard's "set
  a new password" screen. No email provider works yet (`BLOCKERS.md` B-10), so on TEST the
  invitation was saved and reported, truthfully, as "email not sent"; the password was set
  by the test itself through the admin API in place of the person following the link.
- That Supabase Auth delivers its own password email to an address outside the Supabase
  organisation. Its built-in sender only does so for the organisation's own members: **a
  custom SMTP sender must be set for Auth** (`BLOCKERS.md` B-8), or an invited person who
  misses the one-click link in their invitation will never receive another.

### 4b. Exporting job applications (added 2026-10-13)

| Risk | What stops it | Test (`tests/export.test.js` unless said) |
|---|---|---|
| Someone who may not export gets a file | `applications.export` is the owner's alone and is checked on the request itself, with the membership, before anything is read. Managers read applications and are still refused. | "is the owner alone", "ends with the access" |
| Another restaurant's applications are exported | The restaurant is the caller's own. Ids are looked for inside it; filters cannot reach outside it. | "one restaurant and another" (both tests) |
| The request chooses more than it should | Each kind takes exactly its own fields; anything else is a 422, including `columns`, `fields`, `limit` and a restaurant id. | "each kind of export takes exactly what it needs" |
| The file carries more than the list | The export is the main facts only (the client's decision): the SQL function reads no contact detail, no free text, no storage path. | "is every application... and nothing more"; `export-files.test.js` "leaves out everything but the main facts" |
| A formula in an applicant's name runs in Excel | In the workbook every such value is a text cell, never a formula. In CSV, a value that would start a formula (`= + - @`, also after spaces, control or invisible characters, and in their full-width forms) is given a leading apostrophe; every field is quoted. | `export-files.test.js` "stores what an applicant typed as text", "disarms a value that a spreadsheet would run as a formula" |
| The file name is used to write somewhere | It is built from fixed words, the restaurant's slug reduced to `a-z 0-9 -`, and the date. Nothing an applicant wrote, no path. | `export-files.test.js` "names the file from fixed words" |
| Exports go unrecorded | The audit entry is written before the rows are returned; if it cannot be, nothing is returned. It holds the count, kind, format and which filters were used: never a name, and not the text of a search. | "writes each export to the audit log", "hands over nothing if the export cannot be recorded" |
| The whole table is pulled repeatedly | 30 exports an hour; 5,000 applications a file. | "is limited in how often", "refuses an export too large" |
| The count and the file disagree | One SQL statement counts and reads. | "counts and reads in one moment" |

**Not covered:** the file is made in the owner's browser and saved to their computer. What
happens to it after that (where it is kept, who it is sent to) is outside this system. An
export of personal data should be treated like the applications themselves: the privacy
policy's retention period applies to copies too.

### 4c. Writing to applicants (added 2026-10-13)

The dashboard can now send email in the restaurant's name. That is a new way to do harm
(send to strangers, pretend to be someone, put a link in front of an applicant), so the
request is given as little to decide as possible.

| Risk | What stops it | Test (`tests/messages.test.js` unless said) |
|---|---|---|
| The form is used to email someone who never applied | There is no recipient in the request. The address is the application's own, read by the database when the message is recorded. `to`, `cc`, `bcc`, `email` and the like are unknown fields: 422. | "does not let a request choose the recipient, the sender or where answers go" |
| Someone writes as another sender, or redirects the replies | The sender is the backend's `EMAIL_FROM`; reply-to is the restaurant's `recruitment_email` from the database. Neither is in the request. | the same test; "is emailed to the applicant under the restaurant's name" |
| A header is added through the subject | The subject is reduced to one line before it is stored or sent. The provider is called over its JSON API, which has no header syntax to break out of. | "keeps a subject to one line" |
| Markup, a link or a script is put in front of the applicant | Everything typed is escaped in the HTML part. The one link in the email is the restaurant's website, built by the server from its own allowed origins. | "is text: nothing typed becomes markup, a link or a script" |
| Staff, another restaurant, or nobody at all sends | `applications.message` is the owner's and manager's; the application is looked for inside the caller's restaurant, so another's is "not found"; no session is a 401. | "refuses anyone who is not an owner or a manager", "answers as if another restaurant's application did not exist" |
| A message is sent twice | An `Idempotency-Key` per message; a replay returns the first answer. Only a message that failed can be sent again. | "is not sent again when the same request arrives twice", "cannot be tried again once it has gone" |
| The dashboard claims a delivery that did not happen | `delivered` is written only from the provider's own report for that message id. No route lets a request set it. Accepted-by-the-provider is shown as "Sent". | "is 'sent', and no more than that, until the provider itself reports", "is never set by a request"; `tests/email.test.js` "says 'delivered' only when the provider reports a delivery" |
| It is used to send in bulk | 60 messages an hour per person; one applicant per message; 5,000 characters. | "is limited to sixty messages an hour" |
| What was written leaks into logs | The audit log holds the kind and the outcome. Server logs hold the message's id and the provider's status code. Neither holds the address, the subject or the words. | "is recorded in the activity log without the applicant, the subject or the words", "is kept, says plainly that nothing reached the applicant" |
| Messages outlive the application | They are deleted with it (a foreign key that cascades), by hand or at the end of the retention period. | "go when the application is deleted, and when it passes the retention period" |
| A status change is used to email an applicant something else, or to flood them | The status email's words are the server's, for the status and nothing else; the request carries only `notify_applicant: true` (subject, body, recipient: 422). It is sent only when the status really changes, needs `applications.message`, and draws on the same 60-an-hour budget, checked before the status is touched. The internal note never goes into it. | "telling the applicant about a new status" (8 tests) |
| The provider's key leaks | It is a function secret, sent in one header to the provider and nowhere else; a refusal from the provider is reported as its status code only. | `tests/email.test.js` "does not count a refusal as sent, and does not repeat the provider's answer or the key" |

**Limits, stated plainly:**

- A person with `applications.message` can write anything to an applicant. This system
  records who wrote what; it does not review it.
- `delivered` means the recipient's mail server accepted the message. Whether it reached
  the inbox, the spam folder or a person is not something any provider can report.
- The delivery status is asked for when someone opens the application. A message nobody
  looks at again stays "Sent" in the dashboard (and is counted as not confirmed in the
  monthly report), although it may well have arrived.

### 4d. The scheduled function and the monthly report (added 2026-10-13)

| Risk | What stops it | Test (`tests/monthly-report.test.js`) |
|---|---|---|
| Anyone on the internet triggers the daily work, or a flood of reports | `scheduled-tasks` does nothing without `CRON_SECRET` (32 characters or more, compared in constant time), answers 503 to everyone until one is set, and takes no input. A month already sent cannot be sent again by any number of calls. | "does nothing for a caller without the secret", "refuses every call until a secret of a proper length has been set", "does not send a month twice" |
| The secret leaks through the schedule | The job reads it from Supabase Vault each time it runs. It is in no migration, no job definition, no log line and no response. The SQL that stores it is run by hand from a copy that is not committed. | "runs the day's work... answers with counts alone" (the secret is in no log and no answer) |
| A report goes to the wrong restaurant, or carries another's figures | Every count takes the restaurant's id; the address is that restaurant's own row. | "gives each restaurant its own figures on its own clock, and nothing of another's" |
| A report carries personal data | It is counts and the names of positions. No applicant's name, address, phone, message or CV. The stored copy of the figures is the same. | "names no applicant and carries no address, message or secret" |
| A report states something that was not measured | Each figure is one SQL count over the month. What the system does not record (visitors, orders, releases) is a line that says so and why. | "names what this system does not measure as not available"; "counts exactly the restaurant's own month" |
| A report is silently never sent | A failure is a row (`failed`, the reason, the attempt count), an entry in the activity log, and an error in the function's log; it is tried again daily. A missing address or provider is reported in the function's answer as `not_configured`. | "records a month the email provider refused", "waits, without recording a failure" |

`verify_jwt` is off for this function, as for the public ones: the gateway's JWT check
would only prove that the caller knows the project's public key, which everyone does. The
secret is the check.

**pg_net, and what the public roles can reach of it.** The schedule needs the `pg_net`
extension, which lets SQL make HTTP requests. When it is created, Supabase itself grants
its functions to `anon` and `authenticated`, and the role that runs our SQL cannot revoke
a grant Supabase made (checked on TEST: the revoke is silently without effect). They cannot
use it: those roles reach the database only through the Data API, which serves the
`public` schema alone. On TEST, calls to `net.http_get`, `vault.create_secret` and
`cron.unschedule` through the API, with the public key and with a signed-in session, and a
read of `vault.decrypted_secrets`, were all refused, and the job was still scheduled
afterwards. **Never add `net`, `cron` or `vault` to the API's exposed schemas** (Supabase:
Settings > API > Exposed schemas): that would open them.

**Verified on TEST, 2026-10-13:** the schedule created from `schedule-daily-tasks.sql`; the
secret and the address in Vault and in neither the job definition nor `cron.job`; pg_cron
run every minute for two minutes: both runs `succeeded`, pg_net reached the function, which
answered 200 with counts only both times; the schedule then put back to daily.

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
- **Never given an address.** There is no public URL and no signed URL. A signed-in owner or
  manager asks the dashboard API for the file; the API checks the application belongs to
  their restaurant, reads the file with the service role and streams it back in that same
  authenticated response, always as a download (`Content-Disposition: attachment`,
  `no-store`, `nosniff`). The storage path is never sent to a browser. Each download is
  written to the application's history and to the audit log, with who took it.
- Not attached to the notification email, which only says whether one was uploaded.
- Deleted with the application when the retention period passes.

**Item photos** (`dashboard-api`): signed-in users with `menu.write` only; 1 MB; type sniffed
from bytes (JPEG, PNG, WebP; SVG refused); path built from tenant id, item id and a content
hash. The dashboard re-encodes photos in the browser first, which also strips EXIF location
data, but the server does not rely on that.

**Website photos** (`dashboard-api`, hero, "our story" and gallery): signed-in users with
`site.manage` only (owner and manager); the same checks as item photos, on each of the two
sizes sent; path built from tenant id, slot and a content hash, never from the file's name;
at most 24 gallery photos. The files are public, as the photos on a public website are. The
public endpoint that lists them (`public-site`) is read-only, rate limited, answers only the
site's own origin with CORS, and gives addresses, descriptions and sizes: no row id, no
storage path, nothing about who uploaded a photo or when. The description an owner types is
put on the page as an attribute and as text, never as markup. Proven by
`tests/site-photos.test.js` and the "website photos" browser tests.

**Two-step sign-in** is Supabase Auth's own (an authenticator app). Nothing about a factor,
its secret, its id or a code, is stored by this system, sent to its backend, written to its
logs or kept in the browser; the setup key is shown once, by Supabase, on the Security page.
The backend refuses every route (403 `mfa_required`) to a session of an account that has it
on and has given only the password. Proven by `tests/two-step.test.js` and the "two-step
sign-in" browser tests, **against stand-ins for Supabase Auth: it has not been tried against
the real service**, which needs a deployment and an owner to enrol. What must be done by
hand is in `docs/CONFIGURATION.md` section 10.

**Menu labels and the allergy notice** are safety-relevant wording that only the
restaurant may write. No code path assigns a label to a dish or composes a notice. Names,
descriptions and the notice are stored as plain text and put on the page as text, never as
markup; an icon is a key checked against a fixed set, never a file or a path. Each
restaurant's labels and notice are reachable only through functions bound to that
restaurant, and a foreign key stops another restaurant's label being put on a dish. Proven
by `tests/labels.test.js`.

**Category photos** (`dashboard-api`): as item photos, with the `site.manage` permission.
The category is looked up as this restaurant's before anything is stored, so no file is
kept for another restaurant's category or for one that does not exist. Proven by
`tests/category-photos.test.js`.

**Size limits are enforced on what arrives, not on what is declared.** Every body this
backend reads (JSON, the application form, photo uploads, Clover's notifications) goes
through `readBytes` in `_shared/http.ts`. The `Content-Length` header is the sender's claim
and is only used to refuse an honest oversized request early; reading stops the moment the
count of bytes received passes the cap, so a sender who declares nothing, or less than it
sends, cannot make a function hold more than the cap in memory. Before 2026-10-07 the form
and photo endpoints checked the header and then read the whole body. Proven by "reading a
request body under a cap" in `units.test.js` and by the 7 MB streamed form in
`public.test.js`.

**Not covered:** no antivirus scan. The active-content check does not see inside compressed
PDF streams. Whoever downloads a CV from the dashboard should treat it like any file from a
stranger.

## 7. Rate limits

| Surface | Limit |
|---|---|
| Public menu | 120 per minute per address |
| Job applications | 20 per hour per connection (one address is often many people: a mobile carrier, the restaurant's own wifi) and 3 per day per email address (both counted as salted hashes), plus a honeypot field, a minimum fill time and an origin check. The form's own id for each visit makes a repeated send one application. |
| CV downloads | 60 per 5 minutes per user |
| Exports of applications | 30 per hour per user; 5,000 applications per file |
| Invitations (sending and sending again) | 20 per hour per user; 5 emails a day to one address; 25 open per restaurant |
| Accepting an invitation | 20 per 15 minutes per account |
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
this repository does not control. Tested from outside on 2026-10-06: TLS 1.0 and 1.1 are
refused, TLS 1.2 is accepted (1.3 could not be tried from the test machine), and the
certificate names the bare domain and `www`. `http://` and `www` redirect to
`https://luzenarestaurant.com`, and so does the old spelling of the domain. Not reviewed here, because it is outside this repository
and has not been seen: the VPS itself (its other sites, users, SSH access, firewall,
updates). Its owner is responsible for those.

### A merchant's own Clover API token

A restaurant can connect with a token its owner creates in Clover, instead of OAuth. That
token gives whoever holds it the access it was created with, until it is deleted in Clover,
so it is handled as the most sensitive value in the system:

- It is typed by the owner into a password field in the dashboard and sent once, over TLS,
  with the owner's session, to the backend. This is the only time it is in a browser, and
  the page clears the field whatever the answer. It is never in the page's address, in
  browser storage, or in any response.
- Owner role only. Ten attempts per person per fifteen minutes, counted before Clover is
  asked anything. Unknown fields and malformed values are refused first.
- It is checked against Clover before it is kept, and refused if Clover does not accept it
  for that merchant.
- At rest it is AES-256-GCM ciphertext, like the OAuth tokens. It is not in any log line or
  in the audit log: tests search every log entry and audit row for it.
- The owner can end the access at any time from either side: Disconnect in the dashboard
  deletes the stored copy; deleting the token in Clover makes it useless, and the dashboard
  then asks for a new one.
- Advice for the owner: create a token for this website only, with the Inventory and
  Merchant read permissions and nothing more, and never send it by email or chat.

## 9. Errors and logs

Clients get a code, a plain sentence and a request id. Stack traces, Clover's response text
and database errors are logged server-side only. Logs are structured JSON with a correlation
id per Clover operation. Not logged: tokens, secrets, passwords, authorization codes,
applicant details beyond an application id.

## 10. Personal data

Job applications hold a name, email, phone, the position, the applicant's answers
(full-time or part-time, availability, start, experience, whether they are authorized to
work in the United States), their own words about their experience and themselves, and
optionally a CV.

- **Off by default.** Nothing is collected until the operator switches it on in two places
  and sets a retention period (`docs/CONFIGURATION.md` section 5).
- **Who can read them.** A signed-in owner or manager of that restaurant, through the
  dashboard API, and nobody else: not staff accounts, not another restaurant's owner (to
  whom the application does not exist), not the public. Downloading a CV is a permission
  of its own (`applications.cv`, owner and manager), checked on every download; taking the
  list away as a file is the owner's alone (`applications.export`, section 4b). The two tables have row level
  security with no policies and no privilege for `anon` or `authenticated`.
  `tests/applications.test.js` "who may read an application" checks each of these.
- **What the browser is given.** The list carries names, positions and stages only. Contact
  details and free text are read one application at a time. The dashboard keeps nothing in
  browser storage.
- **History.** Every application records when it arrived, whether the notification went
  out, each change of stage with who made it and their note, and each CV download. The
  audit log records that a stage changed or a CV was taken, with the application's id and
  no name: the activity page shows what was done without showing whose application it was.
- **Retention.** `JOB_APPLICATION_RETENTION_DAYS` has no default. Once set, applications
  older than that are deleted with their CV files: files first, then rows, so a failed file
  deletion leaves the row to be retried rather than an orphaned CV.
- **Consent.** The form asks for agreement to store the details and be contacted, and links
  to the privacy policy.
- **Deletion on request.** The policy tells applicants they can ask for their application
  to be deleted. An owner or manager does it from the application's page in the dashboard:
  the CV, the application and its history go, and the audit log keeps only that an
  application was deleted and by whom.
- **The policy** at `/privacy/` was drafted by the engineer at the client's request on
  2026-10-06 and says what this system does. It has not had legal review.
- **Where they go.** Into the database first. Then one email to the restaurant's
  recruitment address saying that an application has arrived: a summary (name, position,
  contact details, the answers that are choices) and a link to the application in the
  dashboard, which asks for a sign-in. The CV and the applicant's own words are not in the
  email. If the email cannot be sent the application is kept all the same and marked, so
  the dashboard shows that the notification did not go out.
- **The recruitment address** is the `recruitment_email` column of the restaurant's row.
  It is read by the server when the email is sent and is in no page, script or data file of
  the website (`tests/browser/public.spec.js` scans every built file for it). It was shown
  in the footer and on the Contact and Locations pages until 2026-10-06, when it was
  removed from `content/site.json`.

Decided by the client on 2026-10-06: applications are kept for 90 days. Still needed from
the client (`BLOCKERS.md` B-3): the owner's approval of the drafted policy.

No analytics or third-party scripts are loaded by this code, and it sets no cookies. The
Google map on the home and Locations pages is Google's own page in a frame: it loads when a
visitor scrolls near it, and what Google stores then is Google's. Following the Maps or
Instagram links leaves the site.

## 11. Reporting a problem

Report suspected vulnerabilities privately to the site operator. Do not open a public issue.
