import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createMiddleware } from "hono/factory";

const requests = new AsyncLocalStorage<{ requestId: string }>();

export type RuntimeEvent =
  | "request.completed"
  | "request.failed"
  | "runtime.fatal"
  | "monitoring.check"
  | "session.revocation_failed"
  | "oauth.exchange_failed"
  | "oauth.callback_failed"
  | "pdf.failed"
  | "paystack.checkout_failed"
  | "paystack.webhook_failed"
  | "paystack.not_configured"
  | "email.worker_failed"
  | "email.delivery_failed"
  | "api.started"
  | "api.start_failed"
  | "api.shutdown_started"
  | "api.shutdown_failed"
  | "api.shutdown_forced"
  | "api.stopped";

type LogFields = {
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
};
type ErrorReporter = (
  event: RuntimeEvent,
  requestId?: string,
  cause?: unknown,
) => void;
let reporter: ErrorReporter | undefined;

export function setErrorReporter(value: ErrorReporter | undefined) {
  reporter = value;
}

// Only these fields cross the logging boundary. Error messages can contain SQL,
// tokens, or provider responses, so callers pass a fixed event name instead.
export function logEvent(
  event: RuntimeEvent,
  fields: LogFields = {},
  failed = false,
  cause?: unknown,
) {
  const requestId = requests.getStore()?.requestId;
  const record = {
    timestamp: new Date().toISOString(),
    level: failed ? "error" : "info",
    event,
    requestId,
    method: fields.method,
    route: fields.route,
    status: fields.status,
    durationMs: fields.durationMs,
  };
  if (failed) console.error(JSON.stringify(record));
  else console.log(JSON.stringify(record));
  if (failed) {
    try {
      reporter?.(event, requestId, cause);
    } catch {
      /* Monitoring must not change the response. */
    }
  }
}

export function reportError(event: RuntimeEvent, cause?: unknown) {
  logEvent(event, {}, true, cause);
}

export function requestLogging() {
  return createMiddleware(async (c, next) => {
    const requestId = randomUUID();
    return requests.run({ requestId }, async () => {
      const started = performance.now();
      c.header("X-Request-ID", requestId);
      await next();
      // Unknown methods and URLs are caller-controlled and may contain secrets.
      const method = [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
        "HEAD",
      ].includes(c.req.method)
        ? c.req.method
        : "OTHER";
      logEvent("request.completed", {
        method,
        route: c.req.routePath,
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}
