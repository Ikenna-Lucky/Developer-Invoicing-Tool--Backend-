import postgres from "postgres";

export function createDatabaseReadiness(
  connectionString: string,
  options: {
    ssl?: postgres.Options<{}>["ssl"];
    timeoutMs?: number;
    cacheMs?: number;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 2000;
  let closed = false;
  let pending: Promise<boolean> | undefined;
  let active: ReturnType<typeof postgres> | undefined;
  let expiresAt = 0;
  let cached = false;
  return {
    ready(): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      if (pending) return pending;
      if (Date.now() < expiresAt) return Promise.resolve(cached);
      const client = postgres(connectionString, {
        ssl: options.ssl ?? "require",
        max: 1,
        prepare: false,
        connect_timeout: 2,
      });
      active = client;
      let timer: ReturnType<typeof setTimeout>;
      // A dedicated connection prevents probe cancellation from touching invoices,
      // payments, or any other query in the application's pool.
      pending = Promise.race([
        client
          .begin(async (transaction) => {
            await transaction`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
            await transaction`SELECT 1`;
          })
          .then(
            () => !closed,
            () => false,
          ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ])
        .then((ready) => {
          cached = ready && !closed;
          expiresAt = Date.now() + (options.cacheMs ?? 1000);
          return cached;
        })
        .finally(() => {
          clearTimeout(timer);
          void client.end({ timeout: 0 }).catch(() => {});
          active = undefined;
          pending = undefined;
        });
      return pending;
    },
    async close() {
      closed = true;
      await active?.end({ timeout: 0 });
    },
  };
}
