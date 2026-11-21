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

All routes except `/health` and `/auth/*` require an authenticated session (access token cookie).

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

## Deployment notes

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
ownership boundaries, and concurrent requests. PDF rendering and authentication
workflows still need integration tests.

Run `bun run test` for webhook boundary checks. For integration tests, set
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
