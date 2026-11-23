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

## Image scan follow-up — 23 November 2026

Hosted CI for commit `d185f0651bf28130850f6d6d848f3b5b982b5e6d` passed the
application, dependency, and secret jobs. The image built, but Grype failed with
exit 2. The supplied table contains 118 critical and 605 high package findings;
these are package/advisory pairs, not a count of independently exploitable bugs.
Chromium and chromium-common account for 608 of those pairs. Other findings
include OpenSSL, XML, printing, and system libraries. The full image gate remains
failed; no exceptions have been accepted.

Some matches need source-level investigation: Debian lists installed Chromium
`156.0.8078.108-1~deb13u1` as fixed for
[CVE-2026-125350](https://security-tracker.debian.org/tracker/CVE-2026-125350)
and [CVE-2026-121156](https://security-tracker.debian.org/tracker/CVE-2026-121156),
while the supplied scan flags that version. This does not invalidate the remaining
findings. A blank fixed-version column or a `won't fix` state is not permission to
ignore a vulnerability. Review the match namespace, package source, version range,
and vendor status before treating an individual result as incorrect.

Docker now uses Bun `1.4.5-slim`, matching CI, and upgrades installed Debian
packages before installing Chromium. CI builds with `--pull --no-cache` so an old
base or cached apt layer cannot bypass that refresh. PDF security/lifecycle tests
run inside the resulting image without external network access. The existing
explicit browser libraries are retained until an image can be built and their
dependency requirements checked; no required library was removed speculatively.

Grype still fails on high/critical findings, including unfixed ones. It now saves
JSON containing match details, package locations, and scanner/database metadata.
Blocking findings appear in the job log. Download the
`image-security-<commit SHA>` artifact from the workflow run for the full report;
it is retained for 14 days, including on scan failure. Scanner failures retain
their original nonzero status; a missing report also fails artifact collection.

The exact Bun tag was verified through the official registry (HTTP 200). Workflow
YAML parsing, formatting, and Bash syntax checks passed. Both local build attempts
failed before pulling the base image because Docker could not resolve
`auth.docker.io`; host-side registry access succeeded. A refreshed image, its
container PDF tests, and its vulnerability scan therefore remain unverified.
Do not assume this refresh removes all of the reported findings. No deployed
service, Docker daemon configuration, scanner exclusions, or production data was
changed.

## Alpine candidate evaluation — 24 November 2026

The JSON report for `241e1cd917091f2e3aa7b0d494fc5f5dd609ee96` contains 1,504
matches, including 118 critical and 601 high package/advisory pairs across 352
distinct blocking CVEs. All blocking matches use `debian:distro:debian:13` through
the dpkg matcher, not generic CPE matching. Chromium and chromium-common account
for 608 blocking pairs. There are 642 `not-fixed` and 77 `wont-fix` blocking
matches, with no listed fixed versions. The valid Grype database was built on
23 November. Some vendor fixed-version discrepancies remain; they do not establish
that all 719 blocking matches are incorrect.

`Dockerfile.alpine` is an evaluation candidate, not the Render Dockerfile. The
official registry metadata for `oven/bun:1.4.5-alpine` showed Alpine 3.24.4. Alpine
3.24's package catalog lists Chromium `158.0.8127.36-r0`, newer than the Debian
browser in the report. The candidate checks the Alpine release, stays on its
stable repositories, upgrades packages, and installs Chromium, CA certificates,
and Liberation fonts. Package dependencies are resolved by apk. No Debian
libraries are copied into the musl-based image and no edge repositories are mixed
in. Newer packages alone do not prove fewer vulnerabilities or compatibility.

CI now evaluates both Dockerfiles in parallel with `fail-fast: false`. The
existing required check name `Docker build` remains the Debian job; the additional
job is `Alpine image evaluation`. Each image runs the existing runtime and PDF
tests without external network access. Scan installation/execution still runs
after a test failure if the image built, so compatibility failures do not hide
security evidence. Both scans retain the high/critical failure threshold and
14-day reports, now named `image-security-<SHA>-debian` and
`image-security-<SHA>-alpine` to avoid artifact collisions.

Promote a candidate only after its build, runtime tests, PDF tests, vulnerability
triage, and database/startup integration have been verified. In particular, musl
compatibility is not established by the existing Windows or Debian tests. This
evaluation does not deploy either image or change Render settings.

Local YAML parsing, formatting, and Bash syntax checks passed. The Alpine pull
failed at Docker's DNS lookup for `auth.docker.io`, while direct host-side registry
inspection succeeded. No local candidate execution or comparative scan result is
claimed. The next pushed workflow run supplies those reports; unresolved findings
still block release.

Sources: [official Bun image variants](https://hub.docker.com/r/oven/bun),
[Alpine 3.24 Chromium](https://pkgs.alpinelinux.org/package/v3.24/community/x86_64/chromium),
[Liberation fonts](https://pkgs.alpinelinux.org/package/v3.24/main/x86_64/font-liberation),
and [Puppeteer's Alpine guidance](https://pptr.dev/troubleshooting#running-on-alpine).

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
