import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { db as defaultDb, type DB } from "../db";
import { payoutAccounts } from "../db/schema";
import { createAuthMiddleware } from "../middleware/auth";
import { consumeRateLimit } from "../middleware/rate-limit";
import {
  paystackCredentials,
  paystackResponse,
  payoutInput,
  payoutView,
  setupPayoutAccount,
} from "../lib/payouts";
import type { Variables } from "../types";

export function createPayoutsRouter(
  database: DB = defaultDb,
  request: typeof fetch = fetch,
) {
  const router = new Hono<{ Variables: Variables }>();
  router.use("*", createAuthMiddleware(database, true));
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const limit = await consumeRateLimit(
      database,
      `payouts:${c.get("userId")}`,
      30,
      900,
    );
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfter));
      return c.json({ error: "Too many payout requests" }, 429);
    }
    await next();
  });
  router.get(
    "/banks",
    zValidator("query", z.object({ next: z.string().max(200).optional() })),
    async (c) => {
      const query = new URLSearchParams({
        country: "nigeria",
        currency: "NGN",
        perPage: "100",
        use_cursor: "true",
      });
      const next = c.req.valid("query").next;
      if (next) query.set("next", next);
      const result = await paystackResponse(`/bank?${query}`, {}, request);
      const banks = z
        .object({
          data: z.array(
            z.object({
              name: z.string(),
              code: z.string(),
              active: z.boolean(),
            }),
          ),
          meta: z.object({ next: z.string().nullable() }),
        })
        .safeParse(result);
      if (!banks.success)
        throw new HTTPException(502, {
          message: "Paystack returned an invalid bank list",
        });
      return c.json({
        data: banks.data.data
          .filter((bank) => bank.active)
          .map(({ name, code }) => ({ name, code })),
        next: banks.data.meta.next,
      });
    },
  );
  router.get("/account", async (c) => {
    const { mode } = paystackCredentials();
    const account = await database.query.payoutAccounts.findFirst({
      where: and(
        eq(payoutAccounts.userId, c.get("userId")),
        eq(payoutAccounts.mode, mode),
      ),
    });
    return c.json({ data: account ? payoutView(account) : null, mode });
  });
  router.post("/account", zValidator("json", payoutInput), async (c) =>
    c.json({
      data: await setupPayoutAccount(
        database,
        c.get("userId"),
        c.req.valid("json"),
        request,
      ),
    }),
  );
  return router;
}

export default createPayoutsRouter();
