import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { createTestDatabase } from "./database";
import * as schema from "../../src/db/schema";
import { createRequestLimits } from "../../src/middleware/request-limits";

const context = createTestDatabase();
const { database, client } = context;
let app: Hono, cookie: string, otherCookie: string;
const ownerId = randomUUID(),
  otherId = randomUUID();
const clientIds = Array.from({ length: 28 }, () => randomUUID());
const otherClient = randomUUID();
type Page = {
  data: { id: string; clientId?: string; status?: string }[];
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
};

beforeAll(async () => {
  await context.create();
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
  process.env.DATABASE_URL = "postgresql://unused:unused@localhost/unused";
  process.env.JWT_ACCESS_SECRET = "pagination-access-secret-at-least-32-bytes";
  process.env.JWT_REFRESH_SECRET =
    "pagination-refresh-secret-at-least-32-bytes";
  for (const id of [ownerId, otherId])
    await database.insert(schema.users).values({
      id,
      email: `${id}@example.test`,
      fullName: "Owner",
      emailVerifiedAt: new Date(),
    });
  await database.insert(schema.clients).values(
    clientIds.map((id, n) => ({
      id,
      userId: ownerId,
      name: n === 0 ? "Literal %_\\ Client" : `Client ${n}`,
      email: `${n}@example.test`,
      createdAt:
        n < 2
          ? sql`timestamp '2026-01-01 00:00:00.123456' - ${n} * interval '1 microsecond'`
          : sql`timestamp '2026-01-01 00:00:00.123000'`,
    })),
  );
  await database.insert(schema.clients).values({
    id: otherClient,
    userId: otherId,
    name: "Other client",
    email: "other@example.test",
  });
  for (const userId of [ownerId, otherId]) {
    await database.insert(schema.invoices).values(
      Array.from({ length: 12 }, (_, n) => ({
        id: randomUUID(),
        userId,
        clientId: userId === ownerId ? clientIds[n % 2] : otherClient,
        invoiceNumber: `PAGE-${n}`,
        status: n % 2 === 0 ? ("draft" as const) : ("sent" as const),
        issueDate: new Date("2026-01-01"),
        dueDate: new Date("2026-01-31"),
        totalAmount: "10.00",
        createdAt: sql`timestamp '2026-01-01 00:00:00.123456'`,
        deletedAt: n >= 6 ? sql`timestamp '2026-02-01 00:00:00.123456'` : null,
      })),
    );
  }
  const { createSession } = await import("../../src/lib/sessions");
  cookie = `access_token=${(await createSession(database, ownerId)).accessToken}`;
  otherCookie = `access_token=${(await createSession(database, otherId)).accessToken}`;
  app = new Hono();
  app.use("*", createRequestLimits());
  app.route(
    "/clients",
    (await import("../../src/routes/clients")).createClientsRouter(database),
  );
  app.route(
    "/invoices",
    (await import("../../src/routes/invoices")).createInvoicesRouter(database),
  );
}, 30_000);
afterAll(() => context.close());

async function get(path: string, session = cookie) {
  const response = await app.request(path, { headers: { Cookie: session } });
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}
async function allPages(path: string) {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page: Page = await get(
      `${path}${path.includes("?") ? "&" : "?"}limit=2${cursor ? `&cursor=${cursor}` : ""}`,
    );
    ids.push(...page.data.map((row) => row.id));
    cursor = page.pagination.nextCursor;
    expect(page.pagination.hasMore).toBe(cursor !== null);
    if (ids.length > 100) throw new Error("Pagination failed to advance");
  } while (cursor);
  return ids;
}

test("clients have bounded default pages and traverse timestamp ties without duplicates or gaps", async () => {
  const first = await get("/clients");
  expect(first.data).toHaveLength(25);
  expect(first.pagination.hasMore).toBe(true);
  const ids = await allPages("/clients");
  expect(ids).toHaveLength(28);
  expect(new Set(ids)).toEqual(new Set(clientIds));
  expect(ids.slice(0, 2)).toEqual(clientIds.slice(0, 2));
  const single = await get("/clients?limit=1");
  const following = await get(`/clients?limit=1&cursor=${single.pagination.nextCursor}`);
  expect(following.data[0].id).toBe(clientIds[1]);
  const empty = await get("/clients?search=missing");
  expect(empty.pagination).toEqual({
    limit: 25,
    hasMore: false,
    nextCursor: null,
  });
});

test("active, Trash, status, client, and literal-search filters stay scoped on every page", async () => {
  for (const path of ["/invoices", "/invoices/trash"]) {
    const ids = await allPages(path);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    const owned =
      await client`SELECT id FROM invoices WHERE user_id = ${ownerId} AND (deleted_at IS NOT NULL) = ${path.endsWith("trash")}`;
    expect(new Set(ids)).toEqual(new Set(owned.map((row) => row.id)));
    expect(await allPages(`${path}?status=sent`)).toHaveLength(3);
    const filtered = await get(`${path}?clientId=${clientIds[0]}`);
    expect(filtered.data.every((row) => row.clientId === clientIds[0])).toBe(
      true,
    );
    expect((await get(`${path}?clientId=${otherClient}`)).data).toHaveLength(0);
  }
  expect(
    (await get("/clients?search=" + encodeURIComponent("%_\\"))).data.map(
      (row) => row.id,
    ),
  ).toEqual([clientIds[0]]);
});

test("another account's cursor cannot bypass ownership and a deleted anchor does not break continuation", async () => {
  const foreign = await get("/clients?limit=1", otherCookie);
  const crafted = Buffer.from(
    JSON.stringify({
      time: "2027-01-01T00:00:00.000000",
      id: foreign.data[0].id,
    }),
  ).toString("base64url");
  expect(
    (await get(`/clients?limit=100&cursor=${crafted}`)).data
      .map((row) => row.id)
      .sort(),
  ).toEqual([...clientIds].sort());
  const first = await get("/clients?limit=3");
  const anchor = first.data.at(-1)!;
  await client`DELETE FROM clients WHERE id = ${anchor.id}`;
  const next = await get(
    `/clients?limit=100&cursor=${first.pagination.nextCursor}`,
  );
  expect(next.data).toHaveLength(25);
  expect(
    next.data.some((row) => first.data.some((old) => old.id === row.id)),
  ).toBe(false);
});

test("invalid and repeated parameters and impossible cursor dates return 400", async () => {
  const badCursor = Buffer.from(
    JSON.stringify({ time: "2026-02-31T00:00:00.000000", id: randomUUID() }),
  ).toString("base64url");
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1e2",
    "limit=2&limit=3",
    "cursor=bad",
    `cursor=${badCursor}`,
    "status=unknown",
    "clientId=bad",
    `search=${"a".repeat(101)}`,
    "offset=2",
  ])
    expect(
      (await app.request(`/invoices?${query}`, { headers: { Cookie: cookie } }))
        .status,
    ).toBe(400);
  expect(
    (
      await app.request("/clients?status=draft", {
        headers: { Cookie: cookie },
      })
    ).status,
  ).toBe(400);
});

test("oversized write fields and invoice batches are rejected without persistence", async () => {
  const send = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect(
    (
      await send("/clients", {
        name: "n".repeat(201),
        email: "new@example.test",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send("/invoices", {
        clientId: clientIds[0],
        issueDate: "2026-01-01T00:00:00Z",
        dueDate: "2026-01-31T00:00:00Z",
        items: Array.from({ length: 101 }, () => ({
          description: "Work",
          quantity: 1,
          rate: 1,
        })),
      })
    ).status,
  ).toBe(400);
  expect((await send("/clients", { name: "A".repeat(17000) })).status).toBe(
    413,
  );
});
