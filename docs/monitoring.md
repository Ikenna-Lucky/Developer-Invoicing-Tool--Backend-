# Backend monitoring and audit history

Every API response includes a server-generated `X-Request-ID`. Request completion
logs contain the registered route template, method, status, duration, and request
ID. Raw paths, query strings, IPs, headers, cookies, bodies, email addresses, and
provider error messages are excluded. Search Render logs by request ID when
investigating a report. A client-supplied request ID is never trusted.

Unexpected API failures, caught OAuth/payment/PDF failures, email worker errors,
and terminal email delivery failures produce fixed error events. Expected 4xx
responses remain completion logs. Fatal exceptions and unhandled rejections emit
`runtime.fatal`, attempt a bounded flush, and exit with status 1. The application
does not continue running after an unhandled failure. Verify Render restarts and
external uptime checks separately; Sentry cannot report a process that never starts.

## Set up Sentry on Render

1. Create a separate Sentry project for this backend, using the Bun platform.
2. Copy its DSN from **Project Settings → Client Keys (DSN)**. Add `SENTRY_DSN`
   to the backend Render service's environment. Leave it empty to disable remote
   reporting. No Sentry auth token or frontend changes are required.
3. Deploy the backend. Its first import initializes monitoring before the app's
   routes. Automatic HTTP, SQL, console, breadcrumb, and tracing integrations are
   disabled. Do not paste the default Sentry setup snippet over this configuration.
4. In a backend shell with that environment, run `bun run monitoring:check`.
   Confirm the `monitoring.check` issue appears in the correct project, inspect
   its payload, and resolve it. Flushing the SDK queue alone does not prove receipt.
5. Configure an issue alert to notify the maintainer for new errors, then run the
   check again to confirm notification delivery. Also alert on recurring
   `email.worker_failed`, `email.delivery_failed`, and `paystack.webhook_failed`.
   Set thresholds and notification frequency to fit actual traffic.

Sentry receives fixed event names, a request ID when present, and source
filenames/line numbers limited to this backend's source directories. Raw error
messages, absolute paths, function names, source snippets, local variables,
request/user context, and provider payloads are removed before sending. This
deliberately limits diagnosis: inspect the identified code path and reproduce the
failure with safe test data. Errors are grouped by event name. Do not add raw
exception logging to troubleshoot production data.

The integration is disabled under `NODE_ENV=test`. Tests use a local collector to
exercise the real SDK without contacting Sentry. No live Sentry delivery, Render
deployment, notification, or production restart has been verified here.

References: [Bun SDK setup](https://bun.sh/guides/ecosystem/sentry),
[finding the DSN](https://www.sentry.help/en/articles/13964441-what-is-a-sentry-dsn).

## Audit records

Migration `0008_audit_events` adds database triggers and an indexed `audit_events`
table. History starts when the migration is applied; it does not invent events
for existing records. Triggers cover account creation/profile/password/verification
changes, client changes, invoice creation/items/status/Trash/deletion, payment
writes, session creation/revocation/removal, and email queue/terminal states.
No-op profile/invoice writes do not create update events. Refresh rotation can
record revocation of the old token; a replacement in the same session does not
create a second `session.created` event.

Records contain owner ID, resource ID, action, database timestamp, and a small
allowlist of details: invoice status transitions, payment amount/invoice ID, or
email purpose. They omit names, addresses, tokens, hashes, invoice text, email
content, checkout references, and provider payloads. `owner_id` means the owner
of the changed data; it is **not actor attribution**. These database events do not
contain request IDs or establish whether a person, webhook, job, or direct SQL
initiated a change. Manual paid-status events are recorded but do not substitute
for an offline payment ledger or reconciliation.

Business changes and history commit or roll back together. An audit write failure
fails the business write. Payment webhook retries therefore keep their existing
transaction/replay semantics. Update, delete, and truncate of audit records are
blocked by a trigger; records have no cascading foreign keys and survive account
deletion. A privileged database owner can disable triggers or change the schema,
so this is not a tamper-proof external ledger. Use separate migration and runtime
database roles before production, with runtime DDL prohibited and audit writes
restricted; those roles have not been provisioned by this change.

There is no public audit endpoint. Authorized operators can query with a bound
owner ID, for example:

```sql
SELECT id, action, resource_id, details, occurred_at
FROM audit_events
WHERE owner_id = $1
ORDER BY occurred_at DESC, id DESC
LIMIT 100;
```

Treat these IDs and amounts as sensitive operational data. Restrict database,
Render, and Sentry access. Audit retention/export/deletion policy, capacity
monitoring, actor/request attribution, external archival, backup/restore tests,
uptime monitoring, and alert-response ownership remain release work. Do not
disable append-only protection just to run a cleanup job without an agreed policy.
