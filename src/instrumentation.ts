import * as Sentry from "@sentry/bun";
import { reportError, setErrorReporter } from "./lib/observability";

// Rebuild outgoing events rather than trying to redact every provider's payload.
export function sanitizeMonitoringEvent(
  event: Sentry.ErrorEvent,
): Sentry.ErrorEvent {
  const candidate = event.tags?.billdEvent ?? event.message;
  const name =
    typeof candidate === "string" &&
    /^(api\.(start_failed|shutdown_failed|shutdown_forced)|monitoring\.check|runtime\.fatal|request\.failed|session\.revocation_failed|oauth\.(exchange|callback)_failed|pdf\.failed|paystack\.(checkout_failed|webhook_failed|not_configured)|email\.(worker|delivery)_failed)$/.test(
      candidate,
    )
      ? candidate
      : "runtime.fatal";
  const requestId = event.tags?.requestId;
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: "javascript",
    level: "error",
    message: name,
    fingerprint: [name],
    exception: {
      values: [
        {
          type: "RuntimeError",
          value: name,
          stacktrace: {
            frames: (
              event.exception?.values?.[0]?.stacktrace?.frames ?? []
            ).flatMap((frame) => {
              const path = frame.filename
                ?.replaceAll("\\", "/")
                .match(
                  /(?:^|\/)(src\/(?:lib|routes|middleware)\/[a-z-]+\.ts|src\/index\.ts)$/,
                )?.[1];
              return path
                ? [
                    {
                      filename: path,
                      lineno: frame.lineno,
                      colno: frame.colno,
                      in_app: true,
                    },
                  ]
                : [];
            }),
          },
        },
      ],
    },
    tags:
      typeof requestId === "string" && /^[a-f0-9-]{36}$/.test(requestId)
        ? { requestId }
        : {},
  };
}

if (process.env.SENTRY_DSN && process.env.NODE_ENV !== "test") {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    defaultIntegrations: false,
    beforeSend: sanitizeMonitoringEvent,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    sendClientReports: false,
    attachStacktrace: true,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
  });
  setErrorReporter((event, requestId, cause) => {
    Sentry.captureException(cause ?? new Error(event), {
      level: "error",
      tags: { requestId, billdEvent: event },
    });
  });
}

// Fatal errors still terminate the process. A bounded flush gives monitoring a
// chance to send the sanitized event before Render restarts the service.
if (process.env.NODE_ENV !== "test") {
  let stopping = false;
  const fatal = (cause: unknown) => {
    if (stopping) process.exit(1);
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 2000);
    reportError("runtime.fatal", cause);
    void Sentry.flush(1500)
      .catch(() => false)
      .finally(() => {
        clearTimeout(timer);
        process.exit(1);
      });
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}

export const flushMonitoring = () => Sentry.flush(1000);
