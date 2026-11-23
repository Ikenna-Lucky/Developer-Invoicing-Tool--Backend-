# CI security checks

Backend CI now has three independent security checks alongside the existing
type, behavior, migration, smoke, and Docker build checks:

| Check                              | Coverage                                          | Blocking result                                                                   |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Dependency security audit          | Bun lockfile, including development tools         | High/critical advisory, or audit failure                                          |
| Git history secret scan            | All fetched Git history, using Gitleaks 8.30.1    | Secret finding, or scanner failure                                                |
| Docker build (includes image scan) | Locally built `billd-api:ci`, using Grype 0.122.1 | High/critical image finding, including unfixed findings, or scan/database failure |

The dependency and secret jobs run independently of application tests. The image
job follows passing application checks; dependency findings do not prevent it
from running. No scan uses `continue-on-error`, ignores unfixed advisories, or
automatically accepts existing vulnerable dependencies. Lower-severity dependency
advisories do not block; the image table can still show lower-severity findings.

Scanner releases have fixed versions and hardcoded SHA-256 archive checksums
verified against official GitHub release metadata. The workflow does not execute
an unversioned installer. Dependency advisories and Grype's vulnerability database
remain live data. Registry, download, checksum, database, or scanner errors fail
the corresponding job rather than proving a clean result.

Gitleaks redacts detected values. Two fingerprints stored in the CI workflow identify
exact historical findings: the example encryption-key placeholder and the
deterministic configuration-test key. Both were checked against their historical
source. CI writes them to a temporary ignore file; no repository `.gitleaksignore`
is needed. There is no blanket exclusion for tests or `.env` files. Inline
`gitleaks:allow` comments are ignored by CI. New findings need investigation;
do not add broad exclusions to obtain a green result. The scan covers Git history,
not an operator's untracked local `.env` or secrets stored outside the repository.

## Dependency remediation — 23 November 2026

The upgraded lockfile passes the **full Bun audit with no known vulnerabilities**
across 117 audited packages (exit 0), without advisory exclusions or a lowered
severity threshold. The original 16 high findings and one moderate tooling finding
are no longer reported. This is time-bound advisory evidence, not a guarantee
against future disclosures or a clean Docker-image result.

Patched direct versions are Hono 4.13.21, Zod 4.6.7, its Hono validator 0.9.1,
Drizzle ORM 0.45.4, Drizzle Kit 0.31.11, and Puppeteer 25.18.1. An esbuild 0.28.2
override replaces the older vulnerable copy required by the deprecated
`@esbuild-kit/core-utils` tooling chain. Its actual caller resolves 0.28.2;
synchronous CJS and asynchronous ESM TypeScript transforms were exercised under
Node 24.12.0, and Drizzle's schema generation passed. Remove/review the override
when Drizzle drops the legacy loader. It is a compatibility override, not an
advisory suppression.

Zod's pagination default now uses its numeric output type while retaining 25
items. Tests assert PostgreSQL messages inside Drizzle's new error `cause` while
retaining rollback/constraint checks. A raw SQL JSON test explicitly serializes
its parameter to match the upgraded driver integration. Database errors can carry
query parameters; existing production logging/monitoring sanitization remains in
place.

Drizzle snapshots were upgraded from format 6 to 7 using `drizzle-kit up`. The
latest snapshot now includes the existing invoice-counter check and partial-index
predicates that older metadata omitted. Snapshot IDs/chains are preserved. Schema
generation reports no changes. Applied SQL migrations and journal entries were
not changed, and no new database migration is required. The check command still
warns about the historical timestamps of migrations 0001–0003; corrective migration
0004 and the legacy-upgrade tests remain in place. Do not rewrite applied history.

TypeScript, a frozen-lockfile install, 54 unit/runtime tests (one existing Windows
signal skip), 118 PostgreSQL integration tests (678 assertions), and seven real
Chrome PDF tests (33 assertions) passed locally. Database tests used PostgreSQL 17
with matching recovery tools; providers were stubbed. Linux/PostgreSQL 16 CI,
Render/Neon deployment, and the built-image vulnerability scan remain unverified.

## Initial findings and scanner verification

The initial Bun 1.4.5 audit found **16 high-severity advisories**, which blocked the
dependency gate before the upgrades above. Affected packages included direct
dependencies `drizzle-orm`, `hono`, and `zod`, plus transitive
`basic-ftp`, `brace-expansion`, `extract-zip`, `ip-address`, `js-yaml`, and `ws`.
No advisory exceptions were added for these findings.

Remediation required upgrade planning and regression verification, including
compatibility across Drizzle/migrations, Zod/validation, and Puppeteer/PDF security.
Scanner findings alone do not establish that every advisory is exploitable in
Billd. Review each advisory and dependency path. Prefer compatible patched
versions; do not force major transitive overrides without checking their callers.

The full-history Gitleaks scan passed locally after the two exact synthetic
exceptions (46 commits). A separately generated, nonfunctional synthetic token
still caused exit code 1, confirming detection remains enabled. Grype's binary
checksum/version/CLI were checked, but Docker was unavailable locally, so the
built-image scan and Linux workflow execution remain unverified. No clean image
result is claimed. Application tests were not rerun for workflow/document-only
changes.

## Enforcing and maintaining the checks

After pushing, require the dependency, secret, application, and Docker scan jobs
in GitHub branch protection/rulesets. Verify Render waits for those CI checks
before deploying. Workflow changes alone do not configure either dashboard; these
settings were not read or changed here. No new account, provider secret, scanner
license, or elevated workflow permission is required.

If a real secret is found, revoke/rotate it first, assess exposure, and remove the
source. Removing the current line does not remove it from history. Coordinate
history cleanup separately rather than rewriting shared branches automatically.
Keep scanner versions/checksums reviewed together. Any advisory exception needs
a specific finding, reason, owner, expiry, and explicit release decision; none
has been accepted for the current vulnerability findings.

References: [Bun audit](https://bun.com/docs/pm/cli/audit),
[Gitleaks](https://github.com/gitleaks/gitleaks),
[Grype](https://github.com/anchore/grype). These checks detect known patterns and
advisories; they do not replace code review, live configuration verification, or
application security testing.
