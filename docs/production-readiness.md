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
existing offline-payment action but does not create an audited payment record.
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
The workflow YAML parsed successfully. Native Bun 1.4.5 passed 63 tests:
13 webhook/authentication checks and 50 PostgreSQL integration tests, with no skips.

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
the three smoke checks passed.
These checks
do not establish upgrade safety for every production state, deployed performance,
or live Paystack compatibility. Production migration/cutover, a verified backup,
and a forward-repair/rollback plan remain required before deployment.
Re-run these checks after payment, schema, runtime, or dependency changes.

## Remaining controls

| Area | Status and next work |
|---|---|
| Product rules (PR-01) | Invoice transitions and draft-only editing/deletion implemented. Settlement routing, offline payment audit, and release acceptance criteria remain. |
| Maintainability (PR-02) | Payment recording extracted into a focused operation; template extraction and naming cleanup remain. |
| Threats (PR-03) | Planned: document abuse and failure cases across authentication, payments, PDFs, and external services. |
| Identity and sessions (PR-04/05) | Atomic reset/refresh, unique tokens, consistent deadlines, and server-side revocation implemented and tested. Email verification, rate limits, replay escalation policy, and browser verification remain. |
| Ownership (PR-06) | Cross-user invoice read/edit/send/delete and client selection tests passed. Wider auth/client workflows remain. Team roles are outside the current individual-user model. |
| API security (PR-07) | Missing: explicit CSRF defense, template escaping, URL restrictions, request/resource limits, and wider startup configuration checks. Authentication configuration is validated. |
| Privacy and retention (PR-08) | Planned: account export/deletion, retention rules, and redacted operational logs. |
| Data correctness (PR-09) | Payment, numbering, rounding, deletion, and forward migration tests passed natively. Existing-data reconciliation, offline payment history, and identity snapshots remain. |
| Integrations/jobs (PR-10) | Missing: durable email work, truthful delivery state, provider timeouts, and payment reconciliation. |
| Tests (PR-11) | Financial, invoice isolation, session, and migration regressions passed. OAuth, PDFs, provider sandboxes, and assembled frontend/API journeys remain. |
| UX/contracts (PR-12) | Frontend edit/delete affordances and client-deletion copy need updates for the new 409 responses. Browser flows, session expiry, and accessible recovery remain unverified. |
| Performance/resilience (PR-13/14) | Missing: pagination and PDF concurrency limits. Workload targets, shutdown, and recovery tests remain undefined. |
| Builds/infrastructure (PR-15/16) | CI exists; hosted execution, scans, runtime pinning, environment isolation, and deployed secrets/config remain unverified. |
| Delivery (PR-17) | Docker migration packaging/startup updated but image unverified. Coordinated migration rollout, enforced merge/deploy gates, and rollback rehearsal remain. |
| Observability/audit (PR-18) | Console logging exists; request IDs, redaction, alerts, and financial/security audit history remain. |
| Recovery (PR-19) | Unverified: backup coverage and an exercised restore. Set acceptable data loss and recovery time with the maintainer. |
| Operations/governance (PR-20/21) | Planned: name the responder and release decision maker; document incident and payment-repair procedures. No risks have been accepted on the owner's behalf. |
| Maintenance (PR-22) | Planned: dependency updates, vulnerability triage, access reviews, and recurring restore checks. |
| Financial assurance (PR-23) | Required: reconciliation, settlement ownership, refunds/disputes, and immutable financial history appropriate to the supported product scope. |

The repository maintainer needs to assign operational ownership and service
targets before release. Work order: invoice/data invariants, identity/security,
durable integrations, wider integration tests and release gates, monitoring and
recovery. Product additions follow once the existing journeys are trustworthy.
