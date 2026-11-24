# Backend startup configuration

Both `bun src/index.ts` and `bun scripts/start.ts` validate configuration before
opening the listener. The production entry validates before applying migrations
or initializing monitoring. Invalid settings stop startup with the variable name
and a safe explanation; values and connection URLs are not included in these
validation errors. The database constructor remains lazy during preflight.

## Production settings

Set `NODE_ENV=production` on Render. The app does not infer production from a
hostname: missing `NODE_ENV` retains local development behavior. Supported values
are `development`, `test`, and `production`.

- `DATABASE_URL`: PostgreSQL URL with host and database name. The application's
  existing PostgreSQL client requires TLS; an explicit `sslmode` must be `require`,
  `verify-ca`, or `verify-full`. Validation does not prove connectivity or validate
  certificates. Startup migrations and `/health/ready` exercise connectivity.
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`: distinct, nonblank secrets of at
  least 32 bytes. Generate random values, rather than relying on the length check
  to prove entropy. Existing duration limits still apply to their expiry settings.
- `FRONTEND_URL` and `API_URL`: explicitly required HTTPS origins in production.
  Do not include paths, credentials, query strings, fragments, whitespace, or
  loopback/localhost addresses. For example, use `https://app.example.com` and
  `https://api.example.com`. A final slash is accepted and normalized away.
- `PORT`: defaults to `3001`; accepts a complete decimal integer from 1–65535.
  Ephemeral port `0` is allowed only under `NODE_ENV=test`.
- `RESEND_API_KEY`: required in production. `EMAIL_QUEUE_ENCRYPTION_KEY` retains
  its existing requirement of exactly 64 hexadecimal characters. Preserve that
  encryption key while queued messages still depend on it.
- `EMAIL_FROM`: optional, defaulting to `Billd <onboarding@resend.dev>`. Accepts a
  mailbox or `Name <mailbox>` without line breaks. Resend's default sender is still
  permitted; this check does not remove its provider-side recipient restrictions
  or prove a domain is verified.

Google OAuth is optional: leave **both** `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` empty to disable it, or configure both. API/provider keys
cannot contain whitespace. Configure Google's authorized redirect URI to exactly
`API_URL/auth/google/callback`. Redirect construction now normalizes final slashes;
production auth cookies retain `HttpOnly`, `Secure`, and `SameSite=None`. The
Google state cookie retains `SameSite=Lax` for the provider's top-level callback.
Actual browser cookie delivery still depends on browser policies and deployment.

Paystack remains optional; test keys are not prohibited in a production-mode
staging service. Monitoring remains optional: an empty `SENTRY_DSN` uses structured
logs only. If supplied, it must have the HTTP(S) DSN shape, public key and numeric
project ID, with HTTPS in production. Validation does not contact any provider
or prove credentials, delivery, payment settlement, or error ingestion work.

Development retains HTTP localhost defaults for frontend/API origins. Its email
workflows still need an encryption key and working provider setup. Operator-only
backup/restore commands and direct migration commands retain their own validation;
these startup checks do not run every administrative script.

## Render proxy verification remains operational work

The existing `RATE_LIMIT_PROXY_HOPS` parser is reused: `0` ignores forwarded
addresses and uses the socket peer; `1`–`9` select that entry counted from the right
of `X-Forwarded-For`. Malformed/missing selected addresses share an unknown bucket.
No new hop count was guessed or deployed in this build.

Render documents that its proxies affect the socket address and forwarded chain.
See [Render's proxy discussion](https://render.com/articles/how-to-proxy-analytics-through-your-own-domain).
Verify the actual staging ingress, including custom-domain and provider-domain
paths, before setting a positive count. Confirm known clients resolve separately,
caller-supplied leftmost entries cannot change the trusted address, and requests
cannot reach the service around trusted ingress. Use restricted temporary
diagnostics or provider support; do not expose an unauthenticated IP/debug route.
Then repeat the check through the production path. Leaving zero behind a proxy
can combine users into a proxy bucket; trusting the wrong entry can enable spoofing.
That deployment check remains unverified here.

## Rollout and local evidence

Before deploying, review production origins, provider pairs, TLS URL options, and
the exact mode in Render's environment settings. Preserve existing secrets rather
than regenerating them to satisfy a syntax check. A validation rejection means the
process will not start or apply migrations; fix the named setting and redeploy.

Tests cover malformed values, secret-safe errors from both actual entry points,
valid local startup, production cookie flags, normalized OAuth redirects, and
existing CSRF/proxy/rate-limit behavior. Database regressions use a disposable
PostgreSQL instance; OAuth/provider calls are stubbed. Render environment settings,
live provider credentials, and the real proxy chain were not read or changed.
