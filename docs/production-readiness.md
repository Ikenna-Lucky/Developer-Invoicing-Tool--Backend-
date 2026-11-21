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
Invoice edits and manual status changes still need rules that protect paid records.

## Verification

On 21 November 2026, TypeScript checking passed for source, scripts, and tests.
The workflow YAML parsed successfully. Six webhook/validation tests and nine
PostgreSQL integration tests passed locally, with no skipped tests.

Local execution used Node 24 with a temporary TypeScript/Bun-test compatibility
adapter because Bun was unavailable. The database was real PostgreSQL 16 in a
disposable container. Tests covered exact saved amounts, concurrent duplicates,
concurrent distinct references, mismatches, reference reuse, signed HTTP requests,
and transaction rollback using an injected PostgreSQL update failure. The database
failure response test used an injected failing transaction implementation.

CI now runs `bun run test` and `bun run test:integration` with PostgreSQL 16.
Native Bun execution and the hosted CI run remain unverified. Integration setup
applies migration SQL in filename order; it does not establish migration journal
correctness, upgrade safety, deployed performance, or live Paystack compatibility.
Re-run these checks after payment, schema, runtime, or dependency changes.

## Remaining controls

| Area | Status and next work |
|---|---|
| Product rules (PR-01) | Planned: define invoice transitions, settlement routing, supported payment cases, and release acceptance criteria. |
| Maintainability (PR-02) | Payment recording extracted into a focused operation; template extraction and naming cleanup remain. |
| Threats (PR-03) | Planned: document abuse and failure cases across authentication, payments, PDFs, and external services. |
| Identity and sessions (PR-04/05) | Missing safeguards: email verification, rate limits, atomic reset/refresh, unique refresh tokens, and consistent session lifetimes. |
| Ownership (PR-06) | Per-user query filters observed; cross-user API regression tests remain. Team roles are outside the current individual-user model. |
| API security (PR-07) | Missing: explicit CSRF defense, template escaping, URL restrictions, request/resource limits, and startup configuration checks. |
| Privacy and retention (PR-08) | Planned: account export/deletion, retention rules, and redacted operational logs. |
| Data correctness (PR-09) | Payment transaction tests passed under the local adapter. Invoice numbering, exact line-item totals, client deletion cascades, and migration ordering remain blockers. |
| Integrations/jobs (PR-10) | Missing: durable email work, truthful delivery state, provider timeouts, and payment reconciliation. |
| Tests (PR-11) | Payment regressions added; auth, invoice CRUD, isolation, migrations, and assembled frontend/API journeys remain. |
| UX/contracts (PR-12) | Unverified: frontend compatibility, retry messaging, session expiry, and accessible error recovery. |
| Performance/resilience (PR-13/14) | Missing: pagination and PDF concurrency limits. Workload targets, shutdown, and recovery tests remain undefined. |
| Builds/infrastructure (PR-15/16) | CI exists; hosted execution, scans, runtime pinning, environment isolation, and deployed secrets/config remain unverified. |
| Delivery (PR-17) | Missing/unverified: Docker migration packaging, migration rollout, enforced merge/deploy gates, and rollback rehearsal. |
| Observability/audit (PR-18) | Console logging exists; request IDs, redaction, alerts, and financial/security audit history remain. |
| Recovery (PR-19) | Unverified: backup coverage and an exercised restore. Set acceptable data loss and recovery time with the maintainer. |
| Operations/governance (PR-20/21) | Planned: name the responder and release decision maker; document incident and payment-repair procedures. No risks have been accepted on the owner's behalf. |
| Maintenance (PR-22) | Planned: dependency updates, vulnerability triage, access reviews, and recurring restore checks. |
| Financial assurance (PR-23) | Required: reconciliation, settlement ownership, refunds/disputes, and immutable financial history appropriate to the supported product scope. |

The repository maintainer needs to assign operational ownership and service
targets before release. Work order: invoice/data invariants, identity/security,
durable integrations, wider integration tests and release gates, monitoring and
recovery. Product additions follow once the existing journeys are trustworthy.
