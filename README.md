# Billd API

Backend for Billd, an invoicing tool for freelancers and small dev shops. Handles auth, clients, invoices, PDF generation, email delivery, and Paystack payments.

Built with [Hono](https://hono.dev) running on [Bun](https://bun.sh), with [Drizzle ORM](https://orm.drizzle.team) over Postgres.

## Features

- Email/password auth plus Google OAuth, with short-lived access tokens and rotating refresh tokens stored as httpOnly cookies
- Client and invoice CRUD, scoped per user
- Line-item invoices with auto-generated invoice numbers (`INV-0001`, `INV-0002`, ...)
- Invoice PDF generation via headless Chromium (Puppeteer)
- Transactional email (invoice delivery, password reset) via Resend
- Paystack payment links on send, plus a webhook handler that marks invoices paid
- Soft delete for invoices — a Trash view with restore, and permanent delete
- Password reset flow with one-time, hashed, expiring tokens

## Tech stack

Bun · Hono · TypeScript · Drizzle ORM · PostgreSQL (Neon) · Zod · jose (JWT) · bcryptjs · Puppeteer · Resend · Paystack

## Getting started

**Prerequisites:** [Bun](https://bun.sh) installed locally, and a Postgres database (this project is built against [Neon](https://neon.tech)).

```bash
git clone <repo-url>
cd developer-invoicing-api
bun install
cp .env.example .env   # then fill in the values, see below
bun run db:migrate
bun run dev
```

The API starts on `http://localhost:3001` by default.

## Environment variables

| Variable                 | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `DATABASE_URL`           | Postgres connection string                                           |
| `JWT_ACCESS_SECRET`      | Secret for signing access tokens (32+ chars)                         |
| `JWT_REFRESH_SECRET`     | Secret for signing refresh tokens (32+ chars)                        |
| `JWT_ACCESS_EXPIRES_IN`  | Access token lifetime, e.g. `15m`                                    |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token lifetime, e.g. `7d`                                    |
| `PAYSTACK_SECRET_KEY`    | Paystack secret key (also used to verify webhook signatures)         |
| `PAYSTACK_PUBLIC_KEY`    | Paystack public key                                                  |
| `EMAIL_FROM`             | From address for outgoing email                                      |
| `RESEND_API_KEY`         | Resend API key                                                       |
| `CLOUDINARY_CLOUD_NAME`  | Cloudinary cloud name (logo/avatar uploads)                          |
| `CLOUDINARY_API_KEY`     | Cloudinary API key                                                   |
| `CLOUDINARY_API_SECRET`  | Cloudinary API secret                                                |
| `GOOGLE_CLIENT_ID`       | Google OAuth client ID                                               |
| `GOOGLE_CLIENT_SECRET`   | Google OAuth client secret                                           |
| `PORT`                   | Port the API listens on (default `3001`)                             |
| `API_URL`                | Public URL of this API (used to build the Google OAuth redirect URI) |
| `FRONTEND_URL`           | URL of the frontend app (used for CORS and redirect targets)         |
| `NODE_ENV`               | `development` or `production`                                        |

Generate strong JWT secrets with `openssl rand -hex 64`.

## Scripts

| Command               | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `bun run dev`         | Start the API with hot reload                           |
| `bun run start`       | Run pending migrations, then start the API (production) |
| `bun run typecheck`   | Type-check without emitting output                      |
| `bun run db:generate` | Generate a new Drizzle migration from schema changes    |
| `bun run db:migrate`  | Apply pending migrations                                |
| `bun run db:studio`   | Open Drizzle Studio to browse the database              |

## Project structure

```
src/
  db/            Drizzle schema and DB client
  lib/           email, jwt, and PDF-generation helpers
  middleware/    auth middleware
  routes/        one file per resource (auth, clients, invoices, webhooks, health)
  index.ts       app entry point — middleware, routing, error handling
drizzle/         SQL migrations
```

## API overview

Client and invoice routes require an active, verified session (access token cookie).
Profile, verification, and logout/recovery flows use the authentication rules described below.
Paystack webhooks require a valid signature.

**Health**

- `GET /health` — liveness check
- `GET /health/db` — checks the database connection

**Auth** (`/auth`)

- `POST /register`, `POST /login`, `POST /refresh`, `POST /logout`
- `GET /me`, `PATCH /me`
- `GET /google`, `GET /google/callback` — Google OAuth flow
- `POST /forgot-password`, `POST /reset-password`

**Clients** (`/clients`)

- `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`

**Invoices** (`/invoices`)

- `GET /`, `GET /trash`, `GET /:id`, `GET /:id/pdf`
- `POST /`, `PUT /:id`, `PATCH /:id/status`
- `POST /:id/send`, `POST /:id/resend`
- `DELETE /:id` (soft delete), `POST /:id/restore`, `DELETE /:id/permanent`

**Webhooks** (`/webhooks`)

- `POST /paystack` — handles `charge.success`, `transfer.success`, and `invoice.payment_failed`

## Email verification and queued delivery

Migration `0007_email_verification_and_delivery` adds `email_verified_at`, one
verification token per account, and a persistent email queue. Registration queues
verification and creates the account/session in the same transaction. Verification
is required before accessing clients, invoices, or the frontend dashboard. Sign-in,
profile access, password recovery, verification, and logout remain available.
Existing accounts are not silently marked verified; sign in and request a link.
Fresh successful Google sign-ins confirm provider-verified addresses. Linking
Google to an existing password account requires that account to be verified first.

Deploy the backend and frontend together after applying migration 0007. The
frontend now includes `/verify-email`, a dashboard gate, and email delivery status.
Verification links expire after 24 hours, require sign-in to the matching account,
and are consumed by an explicit POST, not by opening the link. Tokens use URL
fragments and are not included in server access-log URLs. Only token hashes are
stored in the token table. Resending replaces the old link, cancels its queued
email, and has a one-minute cooldown plus the existing shared IP limits.

Authenticated endpoints:

- `POST /auth/verify-email` with `{ "token": "..." }`
- `POST /auth/resend-verification` (202 means queued, not delivered)
- `GET /auth/verification-status` (latest verification email state)
- `GET /invoices/:id/email-deliveries` (owner only, latest 20 jobs)

Before running this version, set `EMAIL_QUEUE_ENCRYPTION_KEY` to a new 64-character
hexadecimal secret, generated with `openssl rand -hex 32`. Keep it outside Git and
keep it stable while jobs are pending. This key encrypts queued recipients and
email contents with AES-256-GCM; the job ID authenticates each payload. Changing
the key without draining the queue makes old jobs unreadable. Terminal jobs erase
the encrypted payload but retain status metadata. Queue history retention and
operational alerts still need a policy.

Set `RESEND_API_KEY` and `EMAIL_FROM`. The existing sandbox sender remains usable
for the Resend account's own email; it cannot deliver to arbitrary recipients.
After buying and verifying a domain, update `EMAIL_FROM`. The sender is captured
when a job is queued, so old jobs retain their original sender. Production startup
requires both the Resend key and queue encryption key. In development the queue
worker starts only when both are configured; it is disabled in tests.

The worker runs inside the API process, processing at most one job every two
seconds per instance. It uses PostgreSQL leases and `SKIP LOCKED` for concurrent
workers, recovers abandoned jobs after two minutes, and stops after six attempts.
Network failures, provider 429/5xx, and concurrent-idempotency conflicts retry
with exponential delay and jitter. Other provider errors fail without retry.
Requests have a ten-second timeout. Each retry uses the same payload and Resend
idempotency key; jobs expire within 23 hours of creation, inside Resend's 24-hour
idempotency window. This is not an exactly-once delivery guarantee.

Expired/superseded token emails are skipped. An email already in flight when its
token is cancelled may still arrive, but its link cannot be used. A provider can
accept an email before a worker loses its database acknowledgement; retries reuse
the key to avoid duplicates. A final unresolved timeout can leave delivery
uncertain. Investigate provider records before manually resending in that case.
A sleeping/stopped Render instance does not process jobs: use an always-running
service/worker before relying on prompt production delivery. No hosting changes
have been made by this build.

Invoice Send now atomically issues the invoice and queues its email, returning
202 with a job ID. The financial `sent` status means issued; the frontend labels
it Issued. Email state is separate: pending, processing, accepted, failed, or
cancelled. Accepted means Resend accepted the request, not that a recipient inbox
received it. Concurrent resends reuse pending work and have a one-minute cooldown
for completed work. A queue insertion failure rolls invoice issuance back.
Password reset also persists its token and queued email together; its public
response remains generic for unknown accounts. Bounce/delivery webhook tracking,
queue backpressure, hosted worker checks, and live inbox tests remain future work.

Provider reference: [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

## PDF rendering safeguards

Invoice PDFs escape user text before creating HTML. Chromium runs with page
JavaScript disabled, a restrictive content security policy, and request
interception that rejects every resource except the exact approved inline logo.
Remote URLs, localhost, private addresses, file URLs, stylesheets, frames, fonts,
and media are never fetched by the invoice page. Remote profile images remain
stored for the frontend but appear as initials in PDFs, as before.

PDF logos accept canonical base64 PNG or baseline/progressive JPEG only: at most
512 KiB decoded, 2048 pixels per side, and four million pixels. PNG animation
metadata, SVG, GIF, WebP, malformed headers, and unsupported sources fall back to
initials. Header checks bound image dimensions; they are not a complete image
validator or malware scan. Chromium still decodes the image.

Each process allows one active render without queueing; competing requests return
503 with `Retry-After: 5`. Each request launches a fresh browser and closes it
before releasing capacity. The 20-second render deadline terminates the browser;
launch and protocol calls have ten-second deadlines. Automatic render retries
are removed. A late launch is closed before capacity is reused. Cleanup can add
up to one second; OS-level process termination and resource limits still matter.
This trades browser startup latency for isolated request state and bounded work.

PDF limits are 100 line items, 100,000 UTF-8 bytes of invoice/profile text,
1,500,000 bytes of rendered HTML, 20,000 pixels in height, and 5 MiB of output.
Oversized invoices return 422 for PDF generation and remain stored unchanged.
The download endpoint allows ten attempts per account per minute using the shared
PostgreSQL limiter, after verification, ownership, and Trash checks. Busy or failed
attempts count toward this quota. Throttles return 429 and `Retry-After` seconds;
render timeouts return 504. Filenames are sanitized and downloads use private
no-store caching and nosniff headers. Output limits do not cap peak browser memory.

Run `bun run test` for validation and renderer lifecycle checks. Set
`PUPPETEER_EXECUTABLE_PATH` to an installed Chromium/Chrome binary and run
`bun run test:pdf` for real browser tests. CI now runs this browser suite and fails
if a browser is unavailable. Local verification used Windows Chrome; Linux Docker
and hosted CI execution remain unverified. No frontend or schema changes are
required by this build.

The existing container still uses Chromium without its sandbox. These application
controls are not an OS security boundary: production should use a patched browser,
restricted container permissions, resource/egress limits, and validated sandbox
support. Capacity is per process, not a global browser pool. General API body
limits, pagination, image normalization, and deployment load tests remain work.

## Deployment notes

Session migration `0005_session_integrity` adds server-side session identifiers,
an account session version, and one outstanding password-reset token per account.
Deploy the migration and backend together: existing JWTs lack the new claims and
users will need to sign in again. Existing password-reset links remain usable
except older links where several were outstanding for one account.

Access and refresh secrets must be distinct and at least 32 UTF-8 bytes each.
Token lifetimes accept positive integer `s`, `m`, `h`, or `d` values up to 365 days.
Startup rejects invalid authentication configuration. Refresh rotation keeps the
original session deadline (7 days by default, 30 days with Remember me), rather
than extending it on every refresh. Cookie and JWT expiry use the same deadlines.

Protected requests check the active session in PostgreSQL. Successful logout
revokes that browser session, including rotated tokens; password reset invalidates
all sessions for that account. Requests already authorized before revocation may
finish. Database failures are server errors, not invalid-login responses. Logout
returns 503 without clearing retry credentials if revocation fails.

Concurrent refresh requests accept one winner and reject reused tokens with 401
without clearing cookies. The frontend should coordinate refresh requests and
handle logout failure before clearing local state. Automatic token-family
revocation on replay is not implemented. New passwords are limited to 72 UTF-8
bytes to avoid bcrypt truncation. Verification and email queue behavior are described above.

Migration `0006_request_security` adds shared PostgreSQL authentication counters.
Apply it before starting this backend. State-changing browser requests must send
an `Origin` exactly matching `FRONTEND_URL`; missing, `null`, and other origins
return 403. Set `FRONTEND_URL` to one HTTP(S) origin without a path, credentials,
query, or fragment. The existing browser fetch calls send this header automatically.
Command-line/API clients must supply it explicitly. This is a browser CSRF defense,
not a substitute for authentication. The exact Paystack webhook path is exempt
and continues to require its existing signature check. OAuth callbacks retain
their state-cookie validation. GET, HEAD, and OPTIONS are exempt from origin checks.

Authentication requests are limited to 16 KiB. Fixed windows count all attempts,
including successful ones. Limits are shared across instances and restarts:

| Endpoint                | Per IP               | Per email       |
| ----------------------- | -------------------- | --------------- |
| Login                   | 30 / 15 minutes      | 10 / 15 minutes |
| Register                | 10 / hour            | —               |
| Forgot password         | 10 / hour            | 3 / hour        |
| Reset password          | 20 / 15 minutes      | —               |
| Refresh                 | 120 / minute         | —               |
| Google start / callback | 30 / 15 minutes each | —               |

Limits return 429 with `Retry-After` seconds and leave session cookies intact.
Counters store SHA-256 keys rather than raw IPs/emails; these are pseudonymous,
not anonymous. Expired rows are removed in bounded batches on authentication
traffic. Storage access failures return 503 before credential or provider work.
Logout, health, and payment webhooks are excluded from authentication limits.

`RATE_LIMIT_PROXY_HOPS` defaults to `0`, using Bun's socket address and ignoring
forwarded headers. A positive value (1–9) selects that many entries from the right
of `X-Forwarded-For`. Configure it only after verifying the ingress appends the
client address and the service cannot be reached around those trusted proxies.
Missing/invalid addresses share an `unknown` bucket. Render's actual proxy chain
has not been verified: leaving zero behind a proxy can group users into one quota;
trusting too many hops can let callers choose their own bucket. Verify this before
deployment. Fixed windows allow boundary bursts; shared networks and targeted
account throttling can temporarily affect legitimate users. Distributed abuse,
IPv6 address rotation, general API/PDF limits, and edge DDoS controls need further work.

GitHub Actions runs `.github/workflows/ci.yml` on pushes to `main` and
`dev-branch`, on pull requests, and when started manually. It installs the locked
dependencies, checks TypeScript, runs financial and migration tests against PostgreSQL 16,
starts the API for smoke checks, and builds the Docker image. Failures and their
logs appear in the repository's Actions tab.

The smoke checks cover liveness, unauthenticated client access, and unsigned
Paystack events. They use dummy credentials and do not connect to a database or
call payment and email services. Payment integration tests separately cover
transactions, duplicate events, amount/currency mismatches, rollback, and signed
webhook requests. Invoice tests cover numbering, exact totals, lifecycle rules,
ownership boundaries, and concurrent requests. Session tests cover refresh, logout,
password reset, concurrency, and migration. PDF security and lifecycle behavior also have real Chromium tests. OAuth and assembled browser workflows still need integration tests.

Run `bun run test` for webhook and authentication validation checks. For integration tests, set
`TEST_DATABASE_URL` to a disposable local database named `billd_test`, then run
`bun run test:integration`. The test user needs permission to create databases.
Each suite creates and removes its own database and uses the real Drizzle
migrator. Migration tests also reproduce an older database with skipped journal
entries. Do not use a live database.

Invoice numbers are unique per user. Persistent counters prevent collisions
during concurrent creation and keep deleted draft numbers from being reused.
Quantities and rates support two decimal places; each line is rounded to a kobo
before totals are summed. The maximum invoice total is NGN 99,999,999.99.

Only unpaid drafts without payment links can be edited or permanently deleted.
Permanent deletion still requires moving the draft to Trash first. Issued
invoices can be archived and restored, but their details and items are protected.
Clients with any invoice history cannot be deleted. Manual status changes allow
`sent -> overdue`, `sent -> paid`, and `overdue -> paid`; overdue marking requires
the due date to have passed. Drafts must use Send, and paid invoices cannot be
reopened. Unsupported changes return 409; active-only operations return 404 for
invoices in Trash. The frontend's edit/delete controls need to reflect these rules.

Payment handling currently supports full NGN payments. A successful event must
match the invoice total. Duplicate references are acknowledged after checking
the existing payment; conflicting amounts, currencies, or additional payment
references return 422 for investigation. Database failures return 500 so
Paystack can retry. There is no automatic refund or reconciliation workflow.

After the first successful run, require `Typecheck and smoke checks` and
`Docker build` in the branch protection rules for `main`. This workflow does not
deploy the API or capture errors from the running service. Deployment gating and
runtime error monitoring must be configured with the hosting service.

The Docker image now includes migrations and runs `bun run start`, which applies
them before starting the API. Migration `0004_invoice_integrity` backfills counters,
repairs fields skipped by older journal timestamps, and installs history
protections. Historical migration files and timestamps are unchanged. Before a
production rollout, verify a backup, stop old invoice writers, apply migrations,
and switch to this backend. Changing uniqueness and deletion rules requires a
coordinated rollout; application rollback alone does not undo the migration.
Only disposable test databases have been migrated during development.

Puppeteer needs a Chromium binary at runtime — set `PUPPETEER_EXECUTABLE_PATH` in production (this project targets Render's free tier, which is why the browser launch args are tuned for low memory).

Runtime logs now use JSON events and server-generated request IDs. Optional
`SENTRY_DSN` enables redacted backend error reporting; migration 0008 records
transactional audit history. See [monitoring setup and audit limits](docs/monitoring.md)
for Render configuration, the manual verification command, and remaining controls.

Encrypted database exports and guarded restores are available as `bun run db:backup`
and `bun run db:restore` (each takes an encrypted file path). The integration suite
includes a real PostgreSQL recovery drill. See [database recovery](docs/database-recovery.md)
for prerequisites, Neon settings, separate secrets, and validation before cutover.
Production scheduling and independent storage still need configuration.
