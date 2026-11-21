import "../../src/instrumentation";
import { flush } from "@sentry/bun";
import { reportError } from "../../src/lib/observability";

if (process.argv[2] === "fatal") {
  setTimeout(() => {
    throw new Error("secret-fatal-payload");
  }, 0);
} else if (process.argv[2] === "rejection") {
  void Promise.reject(new Error("secret-rejection-payload"));
} else {
  reportError("request.failed", new Error("secret-provider-response"));
  await flush(1500);
}
