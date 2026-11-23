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

## Current findings — 23 November 2026

The local Bun 1.4.5 audit found **16 high-severity advisories**. Consequently the
new dependency gate is expected to fail on the current lockfile. Affected packages
include direct dependencies `drizzle-orm`, `hono`, and `zod`, plus transitive
`basic-ftp`, `brace-expansion`, `extract-zip`, `ip-address`, `js-yaml`, and `ws`.
No dependency versions or advisory exceptions were changed in this build.

These findings require upgrade planning and regression verification, including
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
