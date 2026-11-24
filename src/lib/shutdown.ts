import { logEvent, reportError } from "./observability";

type ShutdownResources = {
  server: { stop(force?: boolean): Promise<void> };
  stopEmailWorker(): Promise<void>;
  closeReadiness(): Promise<void>;
  stopPdf(force?: boolean): Promise<void>;
  closeDatabase(): Promise<void>;
  flushMonitoring(): Promise<unknown>;
  exit(code: number): void;
};

export function createShutdown(
  resources: ShutdownResources,
  timeoutMs = 25_000,
) {
  let draining = false;
  let pending: Promise<void> | undefined;
  return {
    isDraining: () => draining,
    shutdown() {
      if (pending) return pending;
      draining = true;
      logEvent("api.shutdown_started");
      pending = new Promise<void>((resolve) => {
        let finished = false;
        const force = () => {
          for (const close of [
            () => resources.server.stop(true),
            () => resources.stopPdf(true),
            resources.closeReadiness,
            resources.closeDatabase,
          ]) {
            try {
              void close().catch(() => {});
            } catch {
              /* Continue terminating the remaining resources. */
            }
          }
        };
        const finish = (code: number) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (code !== 0) force();
          else logEvent("api.stopped");
          resources.exit(code);
          resolve();
        };
        const timer = setTimeout(() => {
          reportError("api.shutdown_forced");
          finish(1);
        }, timeoutMs);
        void (async () => {
          await Promise.all([
            resources.stopEmailWorker(),
            resources.server.stop(false),
            resources.closeReadiness(),
          ]);
          if (finished) return;
          await resources.stopPdf();
          if (finished) return;
          await resources.closeDatabase();
          if (finished) return;
          await resources.flushMonitoring();
        })().then(
          () => finish(0),
          (error) => {
            if (!finished) reportError("api.shutdown_failed", error);
            finish(1);
          },
        );
      });
      return pending;
    },
  };
}
