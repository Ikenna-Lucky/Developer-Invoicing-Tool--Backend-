# Backend production readiness

Assessment: 21 November 2026. Scope: the Billd backend working tree, starting
with full NGN invoice payments. This is a progress register, not release approval.
The backend is not ready for a production readiness claim while the blockers
below remain. Render configuration and live transactions have not been verified.

## Payment changes

- Payment insertion and invoice settlement now commit in one transaction.
- An invoice row lock serializes concurrent payment events. Existing references
  are checked against the invoice and amount before a replay is acknowledged.
- Successful charges must match the full invoice total in NGN. A conflicting
  payment returns 422; a database failure returns 500 rather than success.
- Raw-body signatures use a constant-time comparison after format validation.
- Charge payloads are validated before database work. Events without Billd
  invoice metadata are ignored; malformed invoice IDs are rejected.

These changes do not repair historical payment inconsistencies, reconcile extra
payments, issue refunds, or establish how freelancers receive settlements.
Issued invoice details and items are now protected from edits and permanent
deletion. Sent/overdue invoices can be marked paid manually; this preserves the
existing offline-payment action. Status transitions now have database audit events,
but this action still does not create an offline payment ledger entry.
Offline payment recording and invoice snapshots of sender/client identity remain
separate work: changing a client profile can still affect regenerated documents.

## Invoice integrity changes

- Atomic per-user counters and a per-user unique constraint prevent number
  collisions. Counters survive draft deletion and roll back with failed creation.
- Quantity/rate precision matches storage; positive amounts use integer arithmetic
  and half-up rounding per line before summing the total.
- Only unpaid, unlinked drafts can be edited or permanently deleted. Issued
  invoices remain archivable/restorable. Clients with invoices cannot be deleted.
- Invoice locks coordinate edits, sends, status changes, deletion, and payment
  settlement. Database triggers protect issued invoice details and items as well.
- Migration 0004 repairs fields skipped by older journal timestamps, backfills
  counters, changes uniqueness/deletion constraints, and retains historical files.
- Docker packages migrations and applies them before serving requests. Its
  Puppeteer skip-download setting now matches the installed package.

## Verification

Session hardening adds unique JWT identifiers, explicit token purpose/issuer/
audience/algorithm checks, atomic refresh replacement, absolute session deadlines,
and server-side revocation checks. Password reset consumes the token, changes the
password, increments the account session version, and removes sessions in one
transaction. Registration also rolls back if session persistence fails.

Migration 0005 backfills session IDs and retains only the latest outstanding reset
link per account before enforcing uniqueness. Legacy JWTs are intentionally
rejected after deployment; users must sign in again. Server-side checks add a
database query to authenticated requests. Previously authorized requests can
finish after revocation. Frontend refresh coordination and truthful logout failure
handling remain necessary. Reused refresh tokens are rejected, but automatic
family revocation on replay is deferred to avoid treating benign simultaneous
refresh requests as account compromise.

Additional native Bun/PostgreSQL tests cover refresh uniqueness and concurrency,
reset single-use and rollback, logout/reset/refresh/login races, cookie deadlines,
per-device revocation, cross-account reset isolation, configuration validation,
legacy-token rejection, and migration from the previous session schema. Injected
database failures verify error responses; external email/OAuth and browser flows
remain unverified. Only disposable databases were migrated.

On 21 November 2026, TypeScript checking passed for source, scripts, and tests.
The workflow YAML parsed successfully. Native Bun 1.4.5 passed 120 unit/database tests:
27 webhook/authentication/email/PDF/monitoring checks and 93 PostgreSQL integration tests, with no skips.
The five real Chromium tests passed in the preceding PDF build; they were not rerun
for the monitoring change.

Initial execution used Node 24 with a temporary compatibility adapter. The final
run used a portable Bun 1.4.5 binary verified against the npm package integrity
hash. The database was real PostgreSQL 16 in a disposable container. Tests covered
exact saved amounts, concurrent duplicates,
concurrent distinct references, mismatches, reference reuse, signed HTTP requests,
and transaction rollback using an injected PostgreSQL update failure. The database
failure response test used an injected failing transaction implementation.
Invoice tests also covered ten concurrent allocations, counter rollback, number
retention after deletion, rounding, direct SQL protections, cross-user API access,
Trash behavior, competing sends, and concurrent client deletion/invoice creation.
The send-status test intentionally used no email credentials; it verifies state
changes and conflict responses, not delivery. Migration tests exercised the real
migrator on a fresh schema, a database with only migration 0000 recorded, and a
repeat run. All test databases are separately created and removed by each suite.

CI now runs `bun run test` and `bun run test:integration` with PostgreSQL 16.
The hosted CI run and Docker image remain unverified. Tested migration scenarios
were exercised only against disposable databases. The local Docker build failed
while downloading the base image because Docker could not resolve its registry
CDN host; it did not reach the application build steps. Native API startup and
the five smoke checks passed.
These checks
do not establish upgrade safety for every production state, deployed performance,
or live Paystack compatibility. Production migration/cutover, a verified backup,
and a forward-repair/rollback plan remain required before deployment.
Re-run these checks after payment, schema, runtime, or dependency changes.

## Request security changes

Migration 0006 adds PostgreSQL rate counters shared across processes. Native tests
verify concurrent quotas, expiry cleanup, per-account normalization, spoofed IP
headers, 429/retry headers, oversized streamed bodies, outages, and real auth
router registration/login through the middleware. CSRF tests cover missing/null,
lookalike, sibling, trusted origins, preflight, safe reads, and the exact webhook
exemption. Existing webhook tests verify signatures separately. The native smoke
checks also exercise trusted and forbidden logout through the actual API entry.

The frontend's existing browser fetch requests supply Origin automatically.
Browser E2E and Render ingress behavior are unverified. Before deployment, verify
FRONTEND_URL and the trusted proxy count; zero trusts only socket addresses.
Rate policies and operational tradeoffs are recorded in README. Account quotas
can be exhausted intentionally; fixed windows, address rotation, distributed
abuse, general API/PDF limits, and edge protection need further work. Counters
use pseudonymous hashes and opportunistic bounded expiry cleanup. Database
failures stop limited authentication routes with 503, while logout and payment
webhook validation remain available outside this limiter. No production migration
or deployment was performed.

Reference: [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Email verification and delivery changes

Email verification gates dashboard, client, and invoice access; auth/recovery
routes remain usable. Registration creates a session, hashed one-time token, and
encrypted email job atomically. Verification requires a matching authenticated
account, expires in 24 hours, consumes once, and is explicit rather than triggered
by GET. Resends serialize on the user row, enforce a cooldown, replace older
links, and cancel queued obsolete work. Existing accounts remain unverified until
proof is obtained; Google requires a fresh provider-verified response. Unverified
password accounts cannot be silently linked through Google.

Verification, password-reset, and invoice messages use a PostgreSQL outbox.
Queue payloads use AES-GCM with a separate environment key; terminal payloads are
erased. Leased worker claims use SKIP LOCKED, bounded attempts, exponential delay,
jitter, deadlines, and a stable provider idempotency key inside a 23-hour horizon.
Workers recover after a crash/acknowledgement failure. Issuing an invoice and
queueing its email commit together; the API/UI distinguish queued from provider
accepted. Provider acceptance is not confirmed inbox delivery. Owner-only status
endpoints and frontend status views expose progress without email bodies/tokens.
Account switching now retains frontend session state if server logout fails.

Native PostgreSQL tests cover single-use/expired/mismatched tokens, account gates,
resend races, transactional enqueue failure, encryption binding, worker concurrency,
lease recovery, provider-success/database-ack failure, cancellation during send,
bounded retries, and invoice status isolation. Resend HTTP and Google profiles are
stubbed; no real emails or provider account changes were performed. TypeScript is
checked in both repositories; the frontend production build also passed. Migration tests include older account rows and do
not auto-verify them. Browser E2E, actual inbox receipt, deployed keys/queue workers,
provider reconciliation, retention, backpressure, alerting, and bounce tracking
remain unverified or missing. See README for configuration and rollout details.

## PDF security changes

Invoice HTML escapes every user-controlled text field. The page disables
JavaScript and service workers, uses restrictive CSP, and aborts all resource
requests except the validated inline PNG/JPEG logo. Remote logos retain the
existing initials fallback. Logo bytes/dimensions, invoice text/rows, HTML size,
rendered height, PDF output, render duration, and concurrency are bounded. Fresh
browser processes remove cross-request page state; no automatic retry doubles
expensive work. The account download quota persists in PostgreSQL. Ownership,
verification, and Trash checks precede quota/render work; response filenames and
cache/content-type headers are hardened.

Five real Windows Chrome tests exercised literal malicious text, logo decoding,
request interception against a local HTTP sentinel even with CSP bypassed,
concurrent rejection, browser cleanup, and deadline recovery. Height/output guards
use injected browser measurements/output while retaining a real browser. Unit
tests cover invalid logo protocols, malformed/oversized/animated image headers,
text/row limits, late launches, and failure recovery. PostgreSQL HTTP tests cover
ownership, verification, Trash, shared account quota, download headers, and error
statuses; their PDF output is injected. The rendered malicious-content screenshot
was visually inspected: content remained literal and the invoice layout readable.
TypeScript and API smoke checks passed. CI includes the real Chromium suite;
hosted CI and Linux container execution have not been verified.

No frontend, migration, deployment, or production data changes were made. Header
checks are not full image normalization. Chromium still runs without its sandbox,
and browser/OS/container resource limits, egress policy, dependency patching,
large-workload verification, general request limits, and pagination remain release
work. Limits bound application work, not peak memory or every browser failure.
See README for exact limits and compatibility behavior.

## Monitoring and audit changes

Request IDs and JSON completion/error logs exclude raw request and provider data.
The optional Sentry SDK rebuilds events from fixed names, request IDs, and limited
source locations; automatic instrumentation and tracing are disabled. Fatal
exceptions/rejections log safely, flush within a bounded deadline, and exit with
failure. A local HTTP collector exercised the actual SDK transport; subprocess
tests verified fatal exits with no DSN. Real Sentry receipt, alert delivery, Render
restarts, hosted CI, Linux runtime behavior, and operational response remain unverified.

Migration 0008 records selected account, session, client, invoice/item, payment,
and email events in the same transaction as the underlying write. Tests cover
rollback, injected audit write failure, concurrent payment replays, credential/
content exclusion, verification/password/session/email transitions, Trash, no-op
writes, account deletion, and append-only update/delete/truncate protection.
Fresh/legacy/repeated migration checks passed on disposable PostgreSQL 16.
Schema snapshot generation reports no further changes. TypeScript and API smoke
checks passed. No production migration, external notification, frontend change,
or deployment was performed.

These records identify the data owner, not the actor, and do not carry HTTP
request IDs. They are not an offline-payment ledger or tamper-proof external
archive. A privileged database owner can alter trigger protections. Provision
separate migration/runtime roles, decide retention/export policy, monitor table
and queue growth, verify backup/restore, and configure/test alerts before release.
See [monitoring setup](monitoring.md) for Render steps and the manual check.

## Backup and recovery changes

On 22 November 2026, the maintainer confirmed Neon hosting. Separate operator
commands stream custom pg_dump archives through AES-256-GCM and authenticate the
entire encrypted archive before restoration. Restores require an explicitly named
empty recovery database and use one transaction without clean/drop flags. Backup
files are never overwritten; failed exports remove partial files. Secrets stay
out of command arguments, output logs, and backup filenames. Temporary decrypted
restore files use restricted local permissions and normal-path cleanup; abrupt
termination still requires private operator cleanup.

The real PostgreSQL 16 drill compared recovered financial data, audit records,
email jobs, counters, and migration history, and verified original-key email
payload decryption, financial/audit protections, next invoice number, and payment
replay behavior. Wrong keys, archive tampering, populated targets, existing backup
files, failed dumps, unsafe URLs, and missing restore confirmation were rejected.
The tiny synthetic restore took about 1.5 seconds excluding database provisioning
and service recovery; it is not a production RTO measurement.

Native Bun 1.4.5 passed 127 tests (30 unit and 97 PostgreSQL integration checks)
with no skips. TypeScript passed. Windows used PostgreSQL client utilities inside
the disposable Docker server; native Linux client execution and hosted CI remain
unverified. CI installs matching PostgreSQL 16 clients and includes the drill.
No app code, production database, Neon settings, scheduler, or upload destination
was changed. No new dependency or database migration was needed.

See [database recovery](database-recovery.md) for direct Neon connections, separate
key custody, configuration recovery, session/token revival, email/payment
reconciliation, and validation before cutover. The owner must approve RPO/RTO,
storage/retention, schedule, and response ownership. Live Neon restore/history,
independent uploaded generations, backup-failure notifications, production-scale
restore, and application login/full cutover remain release gates.

## Pagination and request budgets

On 22 November 2026, client, active invoice, and Trash lists gained cursor
pagination (default 25, maximum 100), stable timestamp/ID ordering with database
microsecond precision, and validated filters. Search treats wildcard characters
literally; invoice lists now honor the frontend's existing clientId filter.
Every continuation retains the owner and active/Trash filters. Migration 0009
adds owner/time/ID indexes, with explicit partial predicates for invoices because
the installed migration generator omits them from generated SQL. Plan index
creation locks against real table sizes before rollout.

API-entry middleware now caps actual streamed body bytes before parsing/database
work, with budgets for client/auth writes, invoices, profile logos, and Paystack.
URL length, field lengths, and invoice item counts are bounded. The existing auth
body helper shares the stream reader; the main entry applies one body-limit pass.
Rate quotas, invoice totals, authorization, and verification rules are preserved.

Native Bun 1.4.5 passed 135 tests (33 unit and 102 PostgreSQL integration checks),
with no skips. TypeScript, assembled API smoke checks, and snapshot consistency
passed. Focused pagination checks passed again after adding a deterministic
single-row sub-millisecond continuation assertion. Tests cover full traversal,
ties, scoped active/Trash/status/client/search filters, empty results, crafted
foreign cursors, deleted anchors, malformed/repeated inputs, write rejection,
streamed byte boundaries, missing/false length headers, byte preservation, read
errors, and long URLs. Existing migration and encrypted recovery drills passed
against migration 0009 on disposable PostgreSQL 16.

This is a backend-only contract change: existing frontend consumers do not yet
read pagination and will show only the first 25 matches. Update lists, client
selectors/history, and list-derived totals before deploying to affected users.
Browser workflows, hosted CI, live provider payload sizes, production index/search
performance, ingress limits/deadlines, and historical oversized values remain
unverified or deferred. No production migration or deployment was performed.
See [API limits](api-limits.md) for exact budgets and rollout requirements.

## PDF CI timeout follow-up

The reported GitHub run timed out on its first real Chromium test after roughly
10 seconds while four later tests passed. The existing launch/protocol deadline
was 10 seconds; the log did not identify the exact timed-out operation. Cold CI
startup is plausible, not established as the root cause.

Real-browser security tests now allow a 45-second render with 30-second browser
startup/protocol deadlines and appropriately bounded test deadlines. Production
retains its 20-second render and 10-second browser limits. No retry or security
assertion was removed. Timeout errors carry a fixed stage and elapsed time; failed
browser checks log those fields, and CI prints the browser version. The separate
four-second stall test prepares its browser before starting the render timer and
requires the failure to occur during printing, then verifies cleanup and capacity
recovery. This prevents a slow launch from satisfying the intentional stall check.

On 22 November 2026, 34 unit tests, five real Windows Chromium tests, TypeScript,
and workflow YAML parsing passed. The browser suite also passed before the final
print-stage assertion was added, then was run again with that assertion. Hosted
Linux CI has not been rerun here; these results do not prove the reported runner
issue is resolved. Database suites were not rerun for this focused timeout change.

## Graceful shutdown and database readiness — 22 November 2026

PR-14/16: implemented with local verification. The API owns its Bun listener,
rejects new business work during a drain, waits for accepted HTTP requests and the
active email job, closes PDF/database resources, and attempts a monitoring flush.
A 25-second deadline forces termination with a failure exit. `/health/ready` uses
a separate bounded PostgreSQL probe; `/health` remains independent of the database.
The production entry applies migrations and starts the API in the same process.
See [server lifecycle](server-lifecycle.md) for configuration and failure behavior.

Final verification on Bun 1.4.5: TypeScript passed; 44 unit/runtime tests passed
with one Windows-only POSIX signal test skipped; all seven real Chrome tests
passed (33 assertions). Earlier in this build, the combined regression run passed
150 tests with that one skip, including 106 PostgreSQL integration tests. Focused
readiness checks passed after the transaction-local timeout change. A disposable
TLS-enabled PostgreSQL startup check applied all ten migrations, returned ready,
and shut down cleanly. External email/payment services were disabled or stubbed.

An interrupted repeat browser run failed with socket resets, a locked Chrome
profile, and a stalled-render timeout; the final sequential run passed without
relaxing assertions. The repeated full regression run was interrupted when local
Docker became unavailable. Docker still could not start during final verification,
so the complete database suite was not repeated against the final artifact and
the disposable `billd-review-postgres` container could not be removed. Remove it
once Docker is available. Running through the older global Bun 1.3.12 also stalled;
final checks used the CI-matched Bun 1.4.5 directly.

Hosted Linux SIGTERM behavior, the deployment image, Render routing/draining,
production workload, and live-provider completion remain unverified. Configure
Render readiness and shutdown timing as documented, then rehearse a deployment.
No production configuration, deployment, or database was changed.

## Offline payment history and Paystack reconciliation — 22 November 2026

PR-09/10/18/23: implemented with local verification. Offline receipts record the
full NGN amount, payment date, method, reference, and authenticated owner. Account-
scoped durable idempotency keys and invoice locks coordinate retries, distinct
keys, and simultaneous webhooks. Receipt insertion, paid status, and the existing
audit event commit together. Payments reject SQL updates/deletes/truncation.
Owner-only reconciliation verifies a supplied Paystack reference, validates the
invoice/amount/currency, and reuses webhook recording. Verification is bounded to
eight seconds and ten checks per owner per minute. See [payments](payments.md).

Bun 1.4.5 TypeScript and 46 unit/runtime tests passed, with the existing Windows
POSIX-signal skip. The complete 112-test integration suite passed on an isolated
local PostgreSQL 17 cluster using matching recovery tools. After adding final
edge cases, all 20 focused payment/migration tests passed (104 assertions),
including history preservation on upgrade, concurrency, rollback, SQL immutability,
API authentication/ownership, invalid reconciliation, replay, and rate limiting.
Schema generation reports no further changes. Paystack HTTP responses are stubbed;
no live payments or customer messages were sent. PostgreSQL 16/Linux CI, Neon,
Render, and live Paystack compatibility remain to be verified. Docker was
unavailable, so PostgreSQL 17 is local evidence rather than an exact CI replica.

The frontend must replace manual paid-status changes with the new receipt form
and retain a retry key. The status endpoint now rejects new paid transitions with
409, while repeating paid on an already-paid invoice remains a no-op. Migration
0010 adds fields/key uniqueness and the append-only trigger without inventing
receipts or actors for old data. Existing paid invoices without payment records
need review. Automatic scheduled reconciliation, payment reversals/refunds,
partial payments, settlement routing, and historical repair remain outstanding.
No production migration or deployment was performed.

## Issued invoice identity snapshots — 22 November 2026

PR-09/18: implemented and verified locally. First issuance captures allowlisted
sender/client fields in PostgreSQL; drafts remain live. Issued snapshots cannot
be replaced or removed. API detail/list/Trash/name-search, PDFs, and invoice email
resends use saved identity, including explicit nulls. Send holds shared profile
locks to keep checkout/email/capture consistent with concurrent profile edits.
Failed issuance rolls back snapshot, status, and queued email together. Resends
retain the original recipient; explicit correction/redelivery remains separate.
See [invoice identity](invoice-identity.md) for the contract and rollout limits.

Migration 0011 backfills existing issued invoices from profiles available at
migration time with `legacy_backfill` provenance; it cannot recover lost original
identity. New captures are marked `issued`. Migration storage/locking must be
assessed against production invoice and embedded-logo volume. No production data,
configuration, or frontend files changed. Older frontend views that derive sender
identity from the current profile still need to consume the saved sender fields.

Bun 1.4.5 TypeScript, 47 unit/runtime tests (one existing Windows POSIX-signal skip),
117 PostgreSQL integration tests (665 assertions), and seven real Windows Chrome
tests (33 assertions) passed. Database checks used isolated PostgreSQL 17 with
matching backup tools because Docker remained unavailable. They cover profile
changes, subsequent invoices, concurrent edits, immutable SQL capture, API/search,
PDF input/HTML, saved email recipients, rollback, and legacy migration. Schema
snapshot generation reports no further changes. One prior full run caught a
payment fixture copying an issued snapshot into a draft; the fixture now clears
it and the full rerun passed. Render/Neon rollout, PostgreSQL 16/Linux CI, live
provider behavior, migration timing at production volume, and frontend invoice
views remain unverified. Document identity is frozen, not a byte-identical PDF.

## Startup configuration validation — 23 November 2026

PR-07/15/16: confirmed gaps addressed with local verification. Both server entry
points validate before the listener; the migration entry validates before database
migrations and monitoring initialization. Existing JWT/key/proxy parsers are reused.
Production requires explicit HTTPS frontend/API origins; strict port/mode/database
URL checks, paired optional OAuth credentials, sender syntax, provider whitespace,
and optional DSN shape checks reject invalid configuration with safe explanations.
OAuth redirect construction canonicalizes trailing slashes. Cookie behavior is
preserved and tested rather than redesigned. Resend's default sender remains
allowed. No provider keys, environment values, or deployment settings were read
from Render or changed. See [configuration](configuration.md) for rollout rules.

TypeScript and 54 unit/runtime tests passed (285 assertions, one existing Windows
POSIX-signal skip). Actual Bun subprocess checks exercise rejection by both entry
points without printing supplied secrets or reaching an unavailable database.
The full 117-test database regression suite passed on isolated PostgreSQL 17
with matching recovery tools. After adding production-mode cookie/OAuth coverage
and final parser edge cases, 32 focused session/request-security checks passed
(192 assertions), including HttpOnly/Secure/SameSite flags, exact callback paths,
CSRF, right-counted proxy selection, and rate limits. Unit/type checks were then
rerun successfully after improving JWT expiry error context. Providers are
stubbed; production credentials, browser delivery, hosted CI, and Render's real
ingress chain remain unverified. PDF behavior was unchanged and its browser suite
was not rerun for this build.

NODE_ENV must be explicitly production on Render; missing mode intentionally
retains local development behavior. No proxy count was guessed: the existing
safe default ignores forwarded headers but may group users behind a proxy.
Verify the actual chain and ingress restrictions before choosing a positive hop
count. Configuration syntax checks do not prove secret entropy, provider access,
TLS certificate policy, DNS ownership, or deployment correctness. No migration,
frontend change, or production deployment was performed.

## CI dependency, secret, and image gates — 23 November 2026

PR-15/22: security checks implemented; dependency gate currently failed on known
findings. CI audits the full Bun lockfile at high/critical, scans full fetched Git
history with redacted Gitleaks, and scans the built image with Grype at high or
above, including unfixed findings. Scanner versions and release-archive checksums
are pinned. Jobs retain read-only repository permissions and no deployment secrets.
The existing Docker build check name is preserved for required-status compatibility.
See [security checks](security-checks.md) for findings and enforcement instructions.

Local Bun 1.4.5 audit returned exit 1 with 16 high advisories affecting direct
Drizzle ORM, Hono, and Zod dependencies and several transitive packages. No upgrades,
vulnerability suppressions, or risk acceptance were applied. This is a release
blocker requiring dependency remediation and regression evidence, not proof that
every advisory is reachable through current application routes.

Gitleaks 8.30.1 was checksum-verified and scanned 46 commits. Two exact historical
findings were verified as the documentation encryption-key placeholder and a
synthetic test key; their fingerprints alone are excluded. The repeated history
scan returned zero. A new synthetic token still returned exit 1. Grype 0.122.1's
Windows archive checksum, version, image-target syntax, failure threshold, and
DB-age configuration were verified. Workflow YAML and every shell block passed
syntax checks. Docker was unavailable, so the actual built-image scan and hosted
Linux workflow remain unverified. No clean image result is claimed. Runtime code
was unchanged; application regression tests were not rerun for this build.

GitHub required checks and Render's wait-for-CI deployment policy still need
operator verification. No repository ruleset or Render setting was changed. These
checks do not themselves prevent a separately configured deployment, prove absence
of secrets outside scanned history, or establish complete security coverage.

## Remaining controls

| Area                              | Status and next work                                                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product rules (PR-01)             | Invoice transitions and draft-only editing/deletion implemented. Offline payment receipts and owner-triggered reconciliation are implemented/tested. Settlement routing and release acceptance criteria remain.                                                                                |
| Maintainability (PR-02)           | Payment recording extracted into a focused operation; template extraction and naming cleanup remain.                                                                                                                                                                                           |
| Threats (PR-03)                   | Planned: document abuse and failure cases across authentication, payments, PDFs, and external services.                                                                                                                                                                                        |
| Identity and sessions (PR-04/05)  | Atomic reset/refresh, unique tokens, consistent deadlines, and server-side revocation implemented and tested. Shared IP/account rate limits are tested. Email verification and account gates are tested. Deployed proxy validation, replay escalation policy, and browser verification remain. |
| Ownership (PR-06)                 | Cross-user invoice read/edit/send/delete and client selection tests passed. Wider auth/client workflows remain. Team roles are outside the current individual-user model.                                                                                                                      |
| API security (PR-07)              | Exact origin CSRF checks and bounded authentication bodies implemented/tested. PDF escaping, network denial, logo validation, and render limits are tested. Request limits and startup configuration validation are implemented/tested; deployed proxy and browser checks remain.              |
| Privacy and retention (PR-08)     | Allowlisted operational logs and outgoing monitoring events implemented/tested. Account export/deletion and retention rules remain.                                                                                                                                                            |
| Data correctness (PR-09)          | Payment, numbering, rounding, deletion, and forward migration tests passed natively. Offline payment history and reference-based reconciliation are implemented/tested. Issued identity snapshots are implemented/tested. Historical financial/identity repair remains.                        |
| Integrations/jobs (PR-10)         | Durable encrypted email jobs, provider acceptance state, retries, and timeouts are tested locally. Owner-triggered payment reconciliation is implemented/tested. Hosted workers, live delivery, backpressure, and scheduled reconciliation remain.                                             |
| Tests (PR-11)                     | Financial, invoice isolation, session, and migration regressions passed. Real PDF security tests passed; live OAuth, provider sandboxes, and assembled frontend/API journeys remain.                                                                                                           |
| UX/contracts (PR-12)              | Frontend pagination controls/selectors/totals must be updated before the paginated contract is deployed to affected users. Edit/delete affordances and client-deletion copy need updates for the 409 responses. Browser flows, session expiry, and accessible recovery remain unverified.      |
| Performance/resilience (PR-13/14) | PDF concurrency/deadline/size limits implemented and tested; cursor pagination and list indexes implemented/tested. Shutdown and readiness have local test evidence; hosted draining, workload targets, and recovery targets remain unverified.                                                |
| Builds/infrastructure (PR-15/16)  | CI security gates implemented; dependency audit currently fails with 16 high advisories. Hosted image scan, runtime pinning, environment isolation, and deployed configuration remain unverified.                                                                                              |
| Delivery (PR-17)                  | Docker migration packaging/startup updated but image unverified. Coordinated migration rollout, enforced merge/deploy gates, and rollback rehearsal remain.                                                                                                                                    |
| Observability/audit (PR-18)       | JSON logs, request IDs, optional sanitized Sentry events, and transactional database history implemented/tested. Live delivery/alerts, uptime checks, actor/request attribution, restricted database roles, and retention remain.                                                              |
| Recovery (PR-19)                  | Encrypted logical backups and guarded empty-target recovery tested on disposable PostgreSQL 16. Neon history window, production exports/storage/schedule, full application recovery, RPO/RTO, and operational ownership remain unverified or undecided.                                        |
| Operations/governance (PR-20/21)  | Planned: name the responder and release decision maker; document incident and payment-repair procedures. No risks have been accepted on the owner's behalf.                                                                                                                                    |
| Maintenance (PR-22)               | Planned: dependency updates, vulnerability triage, access reviews, and recurring restore checks.                                                                                                                                                                                               |
| Financial assurance (PR-23)       | Required: reconciliation, settlement ownership, refunds/disputes, and immutable financial history appropriate to the supported product scope.                                                                                                                                                  |

The repository maintainer needs to assign operational ownership and service
targets before release. Work order: invoice/data invariants, identity/security,
durable integrations, wider integration tests and release gates, monitoring and
recovery. Product additions follow once the existing journeys are trustworthy.

The two synthetic secret-scan exceptions now live directly in the CI workflow,
which writes a temporary ignore file. The repository .gitleaksignore was removed
at the maintainer's request. YAML and shell syntax checks passed after this move.
A fresh full-history scan was not verified: elevated validation timed out, while
the sandbox run could not read Git history and reported zero commits. The earlier
46-commit result applies to the same two fingerprints before their relocation.
