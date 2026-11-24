# Database backup and recovery

The database is hosted on Neon (confirmed by the maintainer on 22 November 2026).
This repository supplies encrypted logical backups, a guarded restore command,
and a disposable CI restore drill. It does not enable a production backup
schedule, upload copies, change the Neon plan, or verify the live history window.

## Neon recovery settings

In the Neon console, record the project's PostgreSQL major version and configured
history window. Check the actual setting rather than assuming a free-plan limit.
Confirm the oldest recoverable point, who can initiate recovery, and who receives
failure notifications. Neon instant restore can recover within its history
window; an independent encrypted export also covers a separate failure boundary.
See [Neon backups](https://neon.com/docs/manage/backup-pg-dump).

Before release, the maintainer must choose:

| Decision                       | Still required                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Recovery point objective (RPO) | Maximum acceptable lost work, e.g. hours of invoices/payments                                                    |
| Recovery time objective (RTO)  | Maximum time to restore and validate the service                                                                 |
| Backup schedule and retention  | Frequency must fit the agreed RPO; retain known-good generations                                                 |
| Independent storage            | Restricted, encrypted, durable storage outside the app host; avoid one credential deleting source and all copies |
| Operational owner              | Person responsible for backup failures, missed runs, and restore drills                                          |

Recommended starting proposal: daily independent exports plus exports before
schema changes, seven daily and four weekly generations, and a monthly isolated
restore drill. This is a proposal, not an agreed RPO/RTO or an activated schedule.
Use a persistent scheduler with failure and missing-backup alerts. A Render
service's temporary filesystem is not backup storage. Confirm storage cost and
access before configuring uploads. Keep the previous known-good copy until a new
generation has passed a restore drill.

## Prerequisites

Install Bun and PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`) on the
operator machine or dedicated backup runner. Put the PostgreSQL `bin` directory on
PATH. Match the clients and recovery server to the source's major version; local
tests use PostgreSQL 16. The application Docker image does not include these
operator tools. The native subprocesses have a 30-minute deadline.

For Neon, click **Connect**, disable **Connection pooling**, and copy the direct
URL. Keep `sslmode=require` and any `channel_binding=require` parameter. The tool
rejects Neon pooler hosts, insecure remote connections, and unsupported URL
options. Credentials are passed to PostgreSQL through the child environment,
not command-line arguments. Use an isolated trusted runner: environment variables
can still be visible to privileged processes. Use a backup role with the reads
needed for all application and Drizzle tables; recovery needs DDL permissions.

Prepare these values in a private ignored `.env.local` file or a secret manager:

```dotenv
BACKUP_DATABASE_URL=postgresql://backup_user:password@direct-host/neondb?sslmode=require
BACKUP_ENCRYPTION_KEY=replace_with_a_separate_64_character_hex_key
```

Generate the backup key once, for example with `openssl rand -hex 32`. Keep it in
a password manager separately from backup storage. It must differ from the email
queue encryption key. Losing it makes these backups unrecoverable; retain old
backup keys until their generations expire. Do not paste credentials into shell
commands or commit them. The recovery scripts deliberately do not fall back to
the application's `DATABASE_URL`.

## Create an encrypted backup

From the backend directory, create an ignored local `backups` directory, then run
with a new timestamped filename (PowerShell example):

```powershell
New-Item -ItemType Directory -Path backups -Force
bun --env-file=.env.local run db:backup "backups/billd-2026-11-22T020000Z.billd-backup"
```

`pg_dump` exports a consistent custom-format snapshot. Its bytes stream directly
through AES-256-GCM to the encrypted file; no plaintext dump is written during
backup. A versioned header and random IV are authenticated with the contents.
Existing files are never overwritten. Ordinary failures remove partial output;
abrupt termination can leave an incomplete file, which authentication rejects.
Only exit status zero and a `backup.completed` log count as export success.
Record the start/completion times, source project/branch, PostgreSQL/tool version,
Git commit, byte count, and upload result in restricted operational evidence.
The completion timestamp is not the exact database snapshot time.

Upload only the encrypted completed file to the chosen independent storage and
verify the uploaded copy by restoring that downloaded generation. The scripts do
not upload or delete generations automatically. Git and Docker ignore backup
directories and common dump suffixes as an extra precaution.

## Restore into an isolated database

1. Pick a trusted known-good backup. Dumps execute database code during restore;
   encryption verifies the file/key, not whether the source operator was trusted.
2. Create a fresh recovery database on a separate Neon project or isolated
   recovery server, with no app or worker connected. Name it
   `billd_restore_drill_20261122` (the `billd_restore_` prefix is mandatory).
   Use the source's PostgreSQL major version. A branch cloned from production
   already contains data; the tool will refuse to overwrite it.
3. Download the encrypted backup. In a separate private `.env.recovery` file,
   set `BACKUP_ENCRYPTION_KEY` to its original key, `RESTORE_DATABASE_URL` to
   the direct recovery connection URL, and
   `RESTORE_CONFIRM_DATABASE=billd_restore_drill_20261122`.
4. Run:

```powershell
bun --env-file=.env.recovery run db:restore "backups/billd-2026-11-22T020000Z.billd-backup"
```

The tool authenticates the entire file before invoking PostgreSQL. It temporarily
decrypts to a private OS temporary directory (POSIX directory/file modes 700/600;
Windows uses inherited account ACLs). Use an encrypted disk and trusted account.
The directory is removed on normal success or failure; a machine crash or forced
kill can leave `billd-restore-*` directories requiring restricted operator cleanup.
Allow enough temporary disk space for the decrypted custom archive.

Restore requires an empty target and explicit matching database name. It uses
`--single-transaction --exit-on-error --no-owner --no-privileges`; it never uses
`--clean`, drops a database, or disables audit triggers. Schema, data, constraints,
functions, triggers, and Drizzle's migration journal are restored. Role grants,
database ownership, external objects, and provider configuration are not restored.
Required Billd tables are checked afterward. Exit zero is database-level success,
not permission to direct live traffic to the target.

PostgreSQL references: [pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)
and [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html).

## Validate before reconnecting the application

Check migration journal, account/client counts, invoice/item totals, payment
amounts/references, counters, and audit history against restricted backup evidence.
Verify issued invoices remain protected and an attempted audit deletion is denied.
Use the matching application commit; do not automatically migrate restored data
with an unreviewed newer release. Provision the intended runtime permissions.

Keep the recovered service isolated from Resend, Paystack, and production OAuth
while validating login, ownership, invoice listing, and PDF generation with safe
accounts. Do not start the normal production app immediately: it starts the email
worker when keys are present. Never use live customer data in a public staging UI.

A database backup does not contain Render configuration, JWT signing secrets,
`EMAIL_QUEUE_ENCRYPTION_KEY`, provider credentials, DNS, or any externally stored
files. Keep recoverable copies of required configuration in a separate secret
manager; preserve the original email key to decrypt restored queued messages.
Inventory external logos/PDFs/object storage if they become sources of truth.

Restoring an earlier point can revive sessions, reset/verification links, and
pending email jobs, or lose payments that Paystack already processed. Before
releasing the service, explicitly decide session/token invalidation and queue
reconciliation. Inspect provider acceptance records before allowing sends, and
reconcile Paystack references/amounts since the recovery point before retrying
anything. Stable email idempotency keys only help inside the provider's retention
window. Do not replay every job or webhook blindly.

For an incident: stop application writes and workers, preserve the current
database and logs, choose/record the recovery point, restore in isolation, validate
and reconcile external side effects, then have the maintainer authorize cutover
of `DATABASE_URL`. Verify health, authentication, invoice reads, worker behavior,
and monitoring after restart. Keep the old database isolated for investigation;
do not delete it during recovery. Record end-to-end elapsed time and lost work
against the agreed RTO/RPO, and capture follow-up actions.

## Evidence and routine drills

`bun run test:integration` now includes a disposable full-schema dump/encrypt/
decrypt/restore drill. It compares financial records, audit history, counters,
encrypted jobs, and migrations; decrypts a restored job with the original email
key; checks invoice/audit protections, next invoice numbering, and payment replay;
and rejects bad keys, tampering, populated targets, and existing output files.
CI installs matching PostgreSQL 16 clients and uses dummy data only. On Windows,
the test can use `RECOVERY_TEST_CONTAINER=billd-review-postgres` to run utilities
in the disposable test container. That override is test-only.

On 22 November 2026 the local PostgreSQL 16 drill restored about 40 KB in roughly
1.5 seconds, including decrypt/preflight/checks but excluding database provisioning
and service recovery. It used synthetic data and a Docker utility adapter. This
does not establish production restore time or prove Neon point-in-time recovery.
Live Neon history, uploaded copies, scheduled exports, production data volume,
application login after restore, notifications, and full service cutover remain
unverified. Rehearse those steps in a controlled environment before release.
