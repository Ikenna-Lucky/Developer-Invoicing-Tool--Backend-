import "../src/instrumentation";
import { flush } from "@sentry/bun";
import { reportError } from "../src/lib/observability";

if (!process.env.SENTRY_DSN || process.env.NODE_ENV === "test") {
  console.error(
    "Set SENTRY_DSN and use a non-test environment for this check.",
  );
  process.exit(1);
}
reportError("monitoring.check");
const drained = await flush(5000);
console.log(
  drained
    ? "Monitoring queue flushed. Confirm monitoring.check in your Sentry project."
    : "Monitoring queue did not flush before the deadline.",
);
process.exitCode = drained ? 0 : 1;
