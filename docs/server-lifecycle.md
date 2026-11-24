# Server readiness and shutdown

The Bun server owns its listening socket explicitly. `bun scripts/start.ts`
applies the packaged migrations and starts the API in the same process. The
Docker command invokes that file directly, so the serving process receives the
container's signals. `bun run start` remains a convenience command. For a native
Render service, use `bun scripts/start.ts` as the start command and verify signal
forwarding if you introduce any wrapper or process manager. Development can still
run `bun run dev` without automatic migrations.

## Health endpoints

| Endpoint        | Meaning                                                  | Response                                                      |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `/health`       | The API process can respond; no database call            | 200                                                           |
| `/health/ready` | Not draining and a bounded PostgreSQL probe succeeded    | 200 ready or 503 unavailable                                  |
| `/health/db`    | Legacy database diagnostic, using the same bounded probe | Existing 200/500 contract; 503 if the app is already draining |

Health responses use `Cache-Control: no-store` and omit database/provider errors,
connection details, credentials, and stack traces. Readiness has a two-second
probe budget and one-second result cache, coalesces concurrent checks, and uses a
separate short-lived TLS connection with a transaction-local server-side statement
timeout. The timeout is set inside the probe transaction rather than as a startup
parameter, preserving compatibility with transaction poolers. It does
not queue behind or cancel business queries in the application's pool. Probe
connections are closed after the check; shutdown also closes an active probe.
A cold or unreachable Neon compute returns unavailable and can recover on later
checks. Cached readiness can be stale for up to a second.

Readiness confirms database connectivity, not every API journey, migration
compatibility, pool capacity, email delivery, or Paystack availability. The
production entry completes migrations before opening the listening socket. Keep
external uptime/business monitoring as separate controls.

## Shutdown order

`SIGTERM`, `SIGINT`, and `SIGHUP` trigger one idempotent shutdown. Repeated signals
do not start duplicate cleanup or extend the deadline.

1. Mark the instance as draining. The admission gate rejects further business
   work with 503 and `Retry-After: 5` before authentication/database work. Liveness
   remains logically healthy until the listening socket closes; readiness cannot
   report success during a drain.
2. Stop the email polling timer and new job claims, stop accepting TCP
   connections, and close the readiness probe. Bun drains accepted HTTP requests,
   including response streams. Existing keep-alive connections cannot introduce
   new business work through the admission gate.
3. Wait for accepted requests and the active email job, including its database
   acknowledgement, to finish. Do not revoke its lease merely because shutdown
   started. A new instance has its own worker and follows the existing queue lease
   and idempotency rules.
4. Finish outstanding PDF cleanup. Puppeteer's independent signal handlers are
   disabled so they cannot preempt an accepted print; the server owns cleanup.
   Further PDF work is refused once the renderer is stopped.
5. Close the application PostgreSQL pool with a two-second cleanup bound, attempt
   a one-second monitoring flush, log `api.stopped`, and exit with status zero.

The entire drain has a **25-second deadline**, including dependency cleanup. If
it expires, or cleanup fails, log `api.shutdown_forced` or `api.shutdown_failed`,
force HTTP connections and tracked Chromium processes closed, initiate database
cleanup, and exit with status one. Incomplete requests may fail. Queue leases
recover interrupted jobs under the existing retry rules; external acceptance
without a database acknowledgement still requires idempotency/reconciliation.
A forced exit is not a successful drain and does not prove whether an interrupted
financial transaction committed. Do not acknowledge or replay payments blindly.
Fatal exceptions retain their separate fail-fast handler; they do not promise
normal graceful-drain behavior. `SIGKILL` cannot be handled by the application.

## Render configuration and verification

After this version is deployed, set the backend's **Health Check Path** to
`/health/ready` and verify that the public endpoint returns 200 when Neon is
reachable. Keep `/health` for process liveness checks. Configure a shutdown delay
of at least 30 seconds; Render documents 30 seconds as its default, which leaves
headroom around the application's 25-second deadline. These dashboard settings
have not been changed by this build.

In a controlled deployment, verify a long request finishes on the old instance,
new traffic reaches the ready replacement, and logs contain
`api.shutdown_started` followed by `api.stopped`. Also verify database outages
produce 503 readiness within the probe budget while liveness remains 200. Observe
recovery before marking the new deployment healthy. Alert on forced/failed
shutdowns using the configured operational logging/monitoring service. Container
termination, platform routing, free-tier behavior, and regional outages are not
zero-downtime guarantees provided by this code.

References: [Render deploy shutdown](https://render.com/docs/deploys),
[Render health checks](https://render.com/docs/health-checks), and
[Bun server stop](https://bun.sh/reference/globals/bun/Server/stop), and
[Neon transaction pooling](https://neon.com/docs/connect/connection-pooling).

## Local evidence

Tests exercise actual Bun response-stream draining and refusal of new TCP
connections; ordered/idempotent cleanup; forced deadlines and cleanup failure;
worker drain with real PostgreSQL queue acceptance; database outage/recovery;
independent probes with an occupied business connection; coalescing and a stalled
TCP peer; liveness versus readiness; and the actual API entry's shutdown handler.
Real Chromium tests cover both accepted-print draining and forced browser cleanup.

On Windows, the actual API process is tested through its registered signal handler
using a test-only stdin fixture that emits the event. The operating-system
SIGTERM subprocess test is skipped on Windows and runs on Linux CI; Windows
process termination does not provide equivalent POSIX signal behavior. A separate
local check executed the production start file against disposable TLS-enabled
PostgreSQL: all ten existing migrations applied, readiness returned 200, and the
registered shutdown handler exited cleanly with external providers disabled.
Hosted CI, a deployed Render signal/routing rehearsal, production load, and live
provider draining still need verification. No production deployment or database
change was performed.
