import { afterAll, beforeAll, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "./database";
import * as schema from "../../src/db/schema";
import {
  createDraftInvoice,
  updateDraftInvoice,
  changeInvoiceStatus,
  permanentlyDeleteDraftInvoice,
  deleteClientWithoutInvoices,
} from "../../src/lib/invoices";
import {
  recordPaystackPayment,
  recordOfflinePayment,
} from "../../src/lib/payments";
import { decryptEmail, processNextEmail } from "../../src/lib/email-queue";

const context = createTestDatabase();
const { client, database } = context;
let invoicesRouter: ReturnType<
  typeof import("../../src/routes/invoices").createInvoicesRouter
>;
let clientsRouter: ReturnType<
  typeof import("../../src/routes/clients").createClientsRouter
>;
let createSession: typeof import("../../src/lib/sessions").createSession;

beforeAll(async () => {
  process.env.EMAIL_QUEUE_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  await context.create();
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
  process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";
  process.env.JWT_ACCESS_SECRET =
    "invoice-tests-access-secret-at-least-32-bytes";
  process.env.JWT_REFRESH_SECRET =
    "invoice-tests-refresh-secret-at-least-32-bytes";
  delete process.env.RESEND_API_KEY;
  delete process.env.PAYSTACK_SECRET_KEY;
  invoicesRouter = (
    await import("../../src/routes/invoices")
  ).createInvoicesRouter(database);
  clientsRouter = (
    await import("../../src/routes/clients")
  ).createClientsRouter(database);
  createSession = (await import("../../src/lib/sessions")).createSession;
}, 30_000);
afterAll(async () => {
  await context.close();
});

async function owner() {
  const userId = randomUUID(),
    clientId = randomUUID(),
    email = `${userId}@example.test`;
  await database.insert(schema.users).values({
    id: userId,
    email,
    fullName: "Test Owner",
    emailVerifiedAt: new Date(),
  });
  await database.insert(schema.clients).values({
    id: clientId,
    userId,
    name: "Test Client",
    email: "client@example.test",
  });
  return { userId, clientId, email };
}

function input(clientId: string) {
  return {
    clientId,
    issueDate: "2026-01-01T00:00:00.000Z",
    dueDate: "2026-01-31T00:00:00.000Z",
    items: [{ description: "Development", quantity: 1, rate: 10 }],
  };
}

async function fixture() {
  const account = await owner();
  const invoice = (await createDraftInvoice(
    database,
    account.userId,
    input(account.clientId),
  ))!;
  return { ...account, invoice };
}

async function headers(account: { userId: string; email: string }) {
  const session = await createSession(database, account.userId);
  return {
    "Content-Type": "application/json",
    Cookie: `access_token=${session.accessToken}`,
  };
}

test("drafts use live identity, while issuing freezes identity for API, PDFs, and resends", async () => {
  const account = await fixture();
  const auth = await headers(account);
  const { createInvoicesRouter } = await import("../../src/routes/invoices");
  const { buildInvoicePdfHtml } = await import("../../src/lib/pdf");
  let rendered: import("../../src/lib/pdf").PDFInput | undefined;
  const router = createInvoicesRouter(database, async (input) => {
    rendered = input;
    return Buffer.from("%PDF-test");
  });
  await database
    .update(schema.users)
    .set({
      businessName: "Original Studio",
      address: "Original sender address",
    })
    .where(eq(schema.users.id, account.userId));
  await database
    .update(schema.clients)
    .set({
      name: "Original Customer",
      address: "Original customer address",
      companyName: null,
    })
    .where(eq(schema.clients.id, account.clientId));
  expect(
    (await router.request(`/${account.invoice.id}/pdf`, { headers: auth }))
      .status,
  ).toBe(200);
  expect(rendered?.sender.businessName).toBe("Original Studio");
  expect(rendered?.invoice.identitySnapshot).toBeNull();
  const sent = await router.request(`/${account.invoice.id}/send`, {
    method: "POST",
    headers: auth,
  });
  expect(sent.status).toBe(202);
  const issued = (await sent.json()).data;
  expect(issued.identitySnapshot.source).toBe("issued");
  expect(issued.identitySnapshot.sender.businessName).toBe("Original Studio");
  expect(issued.identitySnapshot.sender).not.toHaveProperty("passwordHash");
  expect(issued.identitySnapshot.sender).not.toHaveProperty("googleId");
  await database
    .update(schema.users)
    .set({
      businessName: "Renamed Studio",
      address: "New sender address",
      email: `${randomUUID()}@new.test`,
    })
    .where(eq(schema.users.id, account.userId));
  await database
    .update(schema.clients)
    .set({
      name: "Renamed Customer",
      address: "New customer address",
      email: "new-client@example.test",
      companyName: "New Company",
    })
    .where(eq(schema.clients.id, account.clientId));
  const detail = (
    await (
      await router.request(`/${account.invoice.id}`, { headers: auth })
    ).json()
  ).data;
  expect(detail.client.name).toBe("Original Customer");
  expect(detail.client.email).toBe("client@example.test");
  expect(detail.client.companyName).toBeNull();
  expect(detail.identitySnapshot).toEqual(issued.identitySnapshot);
  const list = (
    await (
      await router.request("/?search=Original%20Customer", { headers: auth })
    ).json()
  ).data;
  expect(list).toHaveLength(1);
  expect(list[0].clientName).toBe("Original Customer");
  expect(list[0].clientCompany).toBeNull();
  expect(
    (await router.request(`/${account.invoice.id}/pdf`, { headers: auth }))
      .status,
  ).toBe(200);
  expect(rendered?.sender.businessName).toBe("Original Studio");
  expect(rendered?.sender.address).toBe("Original sender address");
  expect(rendered?.invoice.client.address).toBe("Original customer address");
  const html = buildInvoicePdfHtml(rendered!);
  expect(html).toContain("Original Studio");
  expect(html).not.toContain("Renamed Studio");
  while (
    await processNextEmail(database, async () => ({
      accepted: true,
      id: "snapshot-provider-id",
    }))
  ) {}
  await database
    .update(schema.emailJobs)
    .set({ createdAt: new Date(Date.now() - 120_000) })
    .where(eq(schema.emailJobs.invoiceId, account.invoice.id));
  expect(
    (
      await router.request(`/${account.invoice.id}/resend`, {
        method: "POST",
        headers: auth,
      })
    ).status,
  ).toBe(202);
  const jobs = await database.query.emailJobs.findMany({
    where: eq(schema.emailJobs.invoiceId, account.invoice.id),
  });
  expect(jobs).toHaveLength(2);
  const pending = jobs.find((job) => job.status === "pending")!;
  const message = decryptEmail(pending.id, pending.payload!);
  expect(message.to).toBe("client@example.test");
  expect(message.subject).toContain("Original Studio");
  expect(message.html).toContain("Original Customer");
  expect(message.html).not.toContain("Renamed Customer");
  await database
    .update(schema.invoices)
    .set({ deletedAt: new Date() })
    .where(eq(schema.invoices.id, account.invoice.id));
  const trash = (
    await (
      await router.request("/trash?search=Original%20Customer", {
        headers: auth,
      })
    ).json()
  ).data;
  expect(trash[0].clientName).toBe("Original Customer");
  const nextDraft = (await createDraftInvoice(
    database,
    account.userId,
    input(account.clientId),
  ))!;
  expect(
    (await router.request(`/${nextDraft.id}/pdf`, { headers: auth })).status,
  ).toBe(200);
  expect(rendered?.sender.businessName).toBe("Renamed Studio");
  expect(rendered?.invoice.client.name).toBe("Renamed Customer");
  const nextIssue = await router.request(`/${nextDraft.id}/send`, {
    method: "POST",
    headers: auth,
  });
  expect(
    (await nextIssue.json()).data.identitySnapshot.sender.businessName,
  ).toBe("Renamed Studio");
});

test("snapshot capture cannot be supplied on drafts or rewritten after issue through SQL", async () => {
  const account = await fixture();
  await expect(
    client`UPDATE invoices SET identity_snapshot = '{}'::jsonb WHERE id = ${account.invoice.id}`,
  ).rejects.toThrow("Draft invoices");
  await database
    .update(schema.invoices)
    .set({ status: "sent" })
    .where(eq(schema.invoices.id, account.invoice.id));
  const issued = await database.query.invoices.findFirst({
    where: eq(schema.invoices.id, account.invoice.id),
  });
  expect(issued?.identitySnapshot?.source).toBe("issued");
  for (const replacement of [null, {}]) {
    await expect(
      client`UPDATE invoices SET identity_snapshot = ${replacement === null ? null : JSON.stringify(replacement)}::jsonb WHERE id = ${account.invoice.id}`,
    ).rejects.toThrow("identity cannot be changed");
  }
  const another = await fixture();
  expect(another.invoice.identitySnapshot).toBeNull();
});

test("sending waits for concurrent identity edits and snapshots their committed details", async () => {
  const account = await fixture();
  const auth = await headers(account);
  let entered!: () => void, release!: () => void;
  const editing = new Promise<void>((done) => {
    entered = done;
  });
  const finishEdit = new Promise<void>((done) => {
    release = done;
  });
  const writer = database.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({ businessName: "Committed Studio" })
      .where(eq(schema.users.id, account.userId));
    await tx
      .update(schema.clients)
      .set({ name: "Committed Customer" })
      .where(eq(schema.clients.id, account.clientId));
    entered();
    await finishEdit;
  });
  await editing;
  let completed = false;
  const send = Promise.resolve(
    invoicesRouter.request(`/${account.invoice.id}/send`, {
      method: "POST",
      headers: auth,
    }),
  ).then((response) => {
    completed = true;
    return response;
  });
  try {
    await Bun.sleep(30);
    expect(completed).toBe(false);
  } finally {
    release();
  }
  await writer;
  const response = await send;
  expect(response.status).toBe(202);
  const issued = (await response.json()).data;
  expect(issued.identitySnapshot.sender.businessName).toBe("Committed Studio");
  expect(issued.identitySnapshot.client.name).toBe("Committed Customer");
});

test("each user starts at INV-0001 and concurrent creations stay unique", async () => {
  const first = await owner(),
    second = await owner();
  expect(
    (await createDraftInvoice(database, first.userId, input(first.clientId)))
      ?.invoiceNumber,
  ).toBe("INV-0001");
  expect(
    (await createDraftInvoice(database, second.userId, input(second.clientId)))
      ?.invoiceNumber,
  ).toBe("INV-0001");
  const created = await Promise.all(
    Array.from({ length: 10 }, () =>
      createDraftInvoice(database, first.userId, input(first.clientId)),
    ),
  );
  expect(new Set(created.map((invoice) => invoice?.invoiceNumber)).size).toBe(
    10,
  );
  expect(
    (
      await database.query.invoiceCounters.findFirst({
        where: eq(schema.invoiceCounters.userId, first.userId),
      })
    )?.lastNumber,
  ).toBe(11);
});

test("deleting the latest draft does not reuse its invoice number", async () => {
  const { userId, clientId, invoice } = await fixture();
  await database
    .update(schema.invoices)
    .set({ deletedAt: new Date() })
    .where(eq(schema.invoices.id, invoice.id));
  await permanentlyDeleteDraftInvoice(database, userId, invoice.id);
  expect(
    await database.query.invoiceItems.findMany({
      where: eq(schema.invoiceItems.invoiceId, invoice.id),
    }),
  ).toHaveLength(0);
  expect(
    (await createDraftInvoice(database, userId, input(clientId)))
      ?.invoiceNumber,
  ).toBe("INV-0002");
});

test("a failed invoice insert rolls its counter back", async () => {
  const { userId, clientId } = await fixture();
  await client.unsafe(`CREATE FUNCTION reject_test_item() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.description = 'force-failure' THEN RAISE EXCEPTION 'injected item failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(
    "CREATE TRIGGER test_item_failure BEFORE INSERT ON invoice_items FOR EACH ROW EXECUTE FUNCTION reject_test_item()",
  );
  try {
    await expect(
      createDraftInvoice(database, userId, {
        ...input(clientId),
        items: [{ description: "force-failure", quantity: 1, rate: 10 }],
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining("injected item failure") },
    });
  } finally {
    await client.unsafe("DROP TRIGGER test_item_failure ON invoice_items");
    await client.unsafe("DROP FUNCTION reject_test_item()");
  }
  expect(
    (await createDraftInvoice(database, userId, input(clientId)))
      ?.invoiceNumber,
  ).toBe("INV-0002");
});

test("totals equal the sum of line amounts rounded to kobo", async () => {
  const account = await owner();
  const invoice = await createDraftInvoice(database, account.userId, {
    ...input(account.clientId),
    items: [
      { description: "First", quantity: 0.5, rate: 0.01 },
      { description: "Second", quantity: 0.5, rate: 0.01 },
    ],
  });
  expect(invoice?.totalAmount).toBe("0.02");
  expect(invoice?.items.map((item) => Number(item.amount))).toEqual([
    0.01, 0.01,
  ]);
});

test("draft edits replace items and reject invalid dates and excessive totals", async () => {
  const { userId, invoice } = await fixture();
  const edited = await updateDraftInvoice(database, userId, invoice.id, {
    items: [{ description: "Revised", quantity: 2, rate: 12.25 }],
  });
  expect(edited?.totalAmount).toBe("24.50");
  expect(edited?.items).toHaveLength(1);
  await expect(
    updateDraftInvoice(database, userId, invoice.id, {
      dueDate: "2025-01-01T00:00:00.000Z",
    }),
  ).rejects.toThrow("before issue date");
  await expect(
    updateDraftInvoice(database, userId, invoice.id, {
      items: [{ description: "Overflow", quantity: 99_999_999.99, rate: 2 }],
    }),
  ).rejects.toThrow("Invoice total");
});

test("sent and paid invoice details cannot be edited, even through direct SQL", async () => {
  const { userId, invoice } = await fixture();
  await database
    .update(schema.invoices)
    .set({ status: "sent" })
    .where(eq(schema.invoices.id, invoice.id));
  await expect(
    updateDraftInvoice(database, userId, invoice.id, { notes: "Changed" }),
  ).rejects.toThrow("Only unpaid drafts");
  await expect(
    client`update invoices set total_amount = 1 where id = ${invoice.id}`,
  ).rejects.toThrow("cannot be changed");
  await expect(
    client`update invoice_items set rate = 1 where invoice_id = ${invoice.id}`,
  ).rejects.toThrow("cannot be changed");
  await expect(
    client`delete from invoice_items where invoice_id = ${invoice.id}`,
  ).rejects.toThrow("cannot be changed");
  await recordOfflinePayment(database, userId, invoice.id, randomUUID(), {
    amount: invoice.totalAmount,
    paidAt: "2026-01-02T00:00:00Z",
    method: "cash",
    reference: "cash receipt",
  });
  await expect(
    updateDraftInvoice(database, userId, invoice.id, { notes: "Changed" }),
  ).rejects.toThrow("Only unpaid drafts");
  await expect(
    changeInvoiceStatus(database, userId, invoice.id, "draft"),
  ).rejects.toThrow("cannot change");
  await expect(
    client`update invoices set status = 'sent' where id = ${invoice.id}`,
  ).rejects.toThrow("cannot move backwards");
});

test("clients with invoices and issued invoices in Trash cannot be permanently deleted", async () => {
  const { userId, clientId, invoice } = await fixture();
  await expect(
    deleteClientWithoutInvoices(database, userId, clientId),
  ).rejects.toThrow("Clients with invoices");
  await expect(
    client`delete from clients where id = ${clientId}`,
  ).rejects.toThrow("foreign key constraint");
  await database
    .update(schema.invoices)
    .set({ status: "sent", deletedAt: new Date() })
    .where(eq(schema.invoices.id, invoice.id));
  await expect(
    permanentlyDeleteDraftInvoice(database, userId, invoice.id),
  ).rejects.toThrow("Only unpaid drafts");
  await expect(
    client`delete from invoices where id = ${invoice.id}`,
  ).rejects.toThrow("cannot be permanently deleted");
  await expect(
    deleteClientWithoutInvoices(database, userId, clientId),
  ).rejects.toThrow("Clients with invoices");
});

test("clients without invoice history can be deleted", async () => {
  const { userId, clientId } = await owner();
  await deleteClientWithoutInvoices(database, userId, clientId);
  expect(
    await database.query.clients.findFirst({
      where: eq(schema.clients.id, clientId),
    }),
  ).toBe(undefined);
});

test("creating an invoice while deleting its client cannot erase invoice history", async () => {
  const account = await owner();
  const results = await Promise.allSettled([
    createDraftInvoice(database, account.userId, input(account.clientId)),
    deleteClientWithoutInvoices(database, account.userId, account.clientId),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const saved = await database.query.invoices.findMany({
    where: eq(schema.invoices.clientId, account.clientId),
  });
  expect(saved.length).toBe(results[0].status === "fulfilled" ? 1 : 0);
});

test("database uniqueness is per user and linked drafts cannot be edited", async () => {
  const { userId, clientId, invoice } = await fixture();
  await expect(client`insert into invoices (id, user_id, client_id, invoice_number, issue_date, due_date, total_amount)
    values (${randomUUID()}, ${userId}, ${clientId}, ${invoice.invoiceNumber}, now(), now(), 10)`).rejects.toThrow(
    "invoices_user_invoice_number_unique",
  );
  await database
    .update(schema.invoices)
    .set({ stripePaymentLink: "https://checkout.example.test/test" })
    .where(eq(schema.invoices.id, invoice.id));
  await expect(
    updateDraftInvoice(database, userId, invoice.id, { notes: "Changed" }),
  ).rejects.toThrow("Only unpaid drafts");
  await expect(
    client`update invoices set total_amount = 1 where id = ${invoice.id}`,
  ).rejects.toThrow("cannot be changed");
});

test("status changes reject draft shortcuts and premature overdue marking", async () => {
  const { userId, invoice } = await fixture();
  await expect(
    changeInvoiceStatus(database, userId, invoice.id, "sent"),
  ).rejects.toThrow("use Send");
  await expect(
    changeInvoiceStatus(database, userId, invoice.id, "paid"),
  ).rejects.toThrow("use Send");
  await updateDraftInvoice(database, userId, invoice.id, {
    dueDate: "2099-01-01T00:00:00.000Z",
  });
  await database
    .update(schema.invoices)
    .set({ status: "sent" })
    .where(eq(schema.invoices.id, invoice.id));
  await expect(
    changeInvoiceStatus(database, userId, invoice.id, "overdue"),
  ).rejects.toThrow("not overdue");
  await expect(
    changeInvoiceStatus(database, userId, invoice.id, "paid"),
  ).rejects.toThrow("Record a payment");
  await recordOfflinePayment(database, userId, invoice.id, randomUUID(), {
    amount: invoice.totalAmount,
    paidAt: "2026-01-02T00:00:00Z",
    method: "cash",
    reference: "cash receipt",
  });
  expect(
    (await changeInvoiceStatus(database, userId, invoice.id, "paid")).status,
  ).toBe("paid");
});

test("editing and payment settlement cannot leave changed paid totals", async () => {
  const { userId, invoice } = await fixture();
  await database
    .update(schema.invoices)
    .set({ status: "sent", paystackRoutingRequired: false })
    .where(eq(schema.invoices.id, invoice.id));
  const results = await Promise.allSettled([
    recordPaystackPayment(database, {
      reference: `BILLD-${randomUUID()}`,
      amount: 1000,
      currency: "NGN",
      status: "success",
      paid_at: new Date().toISOString(),
      metadata: { invoice_id: invoice.id },
    }),
    updateDraftInvoice(database, userId, invoice.id, {
      items: [{ description: "Changed", quantity: 1, rate: 1 }],
    }),
  ]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1].status).toBe("rejected");
  const saved = await database.query.invoices.findFirst({
    where: eq(schema.invoices.id, invoice.id),
  });
  expect(saved?.status).toBe("paid");
  expect(saved?.totalAmount).toBe("10.00");
});

test("another user cannot read, edit, send, archive, restore, or delete an invoice", async () => {
  const { invoice } = await fixture(),
    other = await owner();
  const auth = await headers(other);
  for (const [path, method, body] of [
    [`/${invoice.id}`, "GET", undefined],
    [`/${invoice.id}/pdf`, "GET", undefined],
    [`/${invoice.id}`, "PUT", { notes: "Changed" }],
    [`/${invoice.id}/status`, "PATCH", { status: "paid" }],
    [`/${invoice.id}/send`, "POST", undefined],
    [`/${invoice.id}/resend`, "POST", undefined],
    [`/${invoice.id}`, "DELETE", undefined],
    [`/${invoice.id}/restore`, "POST", undefined],
    [`/${invoice.id}/permanent`, "DELETE", undefined],
  ] as const) {
    const response = await invoicesRouter.request(path, {
      method,
      headers: auth,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status).toBe(404);
  }
  await expect(
    createDraftInvoice(database, other.userId, input(invoice.clientId)),
  ).rejects.toThrow("Client not found");
});

test("Trash blocks reads, edits, status changes, PDF, send, and resend until restored", async () => {
  const account = await fixture(),
    auth = await headers(account);
  expect(
    (
      await invoicesRouter.request(`/${account.invoice.id}`, {
        method: "DELETE",
        headers: auth,
      })
    ).status,
  ).toBe(200);
  for (const [suffix, method, body] of [
    ["", "GET", undefined],
    ["/pdf", "GET", undefined],
    ["", "PUT", { notes: "Changed" }],
    ["/status", "PATCH", { status: "paid" }],
    ["/send", "POST", undefined],
    ["/resend", "POST", undefined],
  ] as const) {
    expect(
      (
        await invoicesRouter.request(`/${account.invoice.id}${suffix}`, {
          method,
          headers: auth,
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      ).status,
    ).toBe(404);
  }
  expect(
    (
      await invoicesRouter.request(`/${account.invoice.id}/restore`, {
        method: "POST",
        headers: auth,
      })
    ).status,
  ).toBe(200);
  expect(
    (await invoicesRouter.request(`/${account.invoice.id}`, { headers: auth }))
      .status,
  ).toBe(200);
});

test("HTTP validation rejects excess precision and clients with invoices return 409", async () => {
  const account = await fixture(),
    auth = await headers(account);
  expect(
    (
      await invoicesRouter.request("/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          ...input(account.clientId),
          items: [{ description: "Invalid", quantity: 0.001, rate: 1 }],
        }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await clientsRouter.request(`/${account.clientId}`, {
        method: "DELETE",
        headers: auth,
      })
    ).status,
  ).toBe(409);
});

test("concurrent sends accept one status change and cannot overwrite a paid invoice", async () => {
  delete process.env.PAYSTACK_SECRET_KEY;
  const account = await fixture(),
    auth = await headers(account);
  const responses = await Promise.all(
    Array.from({ length: 2 }, () =>
      invoicesRouter.request(`/${account.invoice.id}/send`, {
        method: "POST",
        headers: auth,
      }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    202, 409,
  ]);
  await recordOfflinePayment(
    database,
    account.userId,
    account.invoice.id,
    randomUUID(),
    {
      amount: account.invoice.totalAmount,
      paidAt: "2026-01-02T00:00:00Z",
      method: "cash",
      reference: "cash receipt",
    },
  );
  expect(
    (
      await invoicesRouter.request(`/${account.invoice.id}/send`, {
        method: "POST",
        headers: auth,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await database.query.invoices.findFirst({
        where: eq(schema.invoices.id, account.invoice.id),
      })
    )?.status,
  ).toBe("paid");
});

test("issuing an invoice queues email atomically and exposes truthful, owner-scoped status", async () => {
  const account = await fixture();
  await updateDraftInvoice(database, account.userId, account.invoice.id, {
    notes: "<script>unsafe</script>",
  });
  const ownHeaders = await headers(account);
  const response = await invoicesRouter.request(`/${account.invoice.id}/send`, {
    method: "POST",
    headers: ownHeaders,
  });
  expect(response.status).toBe(202);
  const body = (await response.json()) as {
    email: { id: string; status: string };
  };
  expect(body.email.status).toBe("pending");
  const job = (await database.query.emailJobs.findFirst({
    where: eq(schema.emailJobs.id, body.email.id),
  }))!;
  expect(decryptEmail(job.id, job.payload!).html).toContain(
    "&lt;script&gt;unsafe&lt;/script&gt;",
  );
  const status = await invoicesRouter.request(
    `/${account.invoice.id}/email-deliveries`,
    { headers: ownHeaders },
  );
  expect(status.status).toBe(200);
  const data = (await status.json()) as { data: { status: string }[] };
  expect(data.data[0].status).toBe("pending");
  const stranger = await owner();
  expect(
    (
      await invoicesRouter.request(`/${account.invoice.id}/email-deliveries`, {
        headers: await headers(stranger),
      })
    ).status,
  ).toBe(404);
  while (
    await processNextEmail(database, async () => ({
      accepted: true,
      id: "mock-provider-id",
    }))
  ) {}
  expect(
    (await database.query.emailJobs.findFirst({
      where: eq(schema.emailJobs.id, job.id),
    }))!.status,
  ).toBe("accepted");
});

test("concurrent resends reuse pending work instead of sending duplicate emails", async () => {
  const account = await fixture();
  const ownHeaders = await headers(account);
  const sent = await invoicesRouter.request(`/${account.invoice.id}/send`, {
    method: "POST",
    headers: ownHeaders,
  });
  expect(sent.status).toBe(202);
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      invoicesRouter.request(`/${account.invoice.id}/resend`, {
        method: "POST",
        headers: ownHeaders,
      }),
    ),
  );
  for (const response of results) expect(response.status).toBe(202);
  expect(
    await database.query.emailJobs.findMany({
      where: eq(schema.emailJobs.invoiceId, account.invoice.id),
    }),
  ).toHaveLength(1);
});

test("an email queue failure leaves an invoice editable instead of falsely issued", async () => {
  const account = await fixture();
  await client.unsafe(
    "CREATE FUNCTION fail_invoice_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected invoice enqueue failure'; END $$; CREATE TRIGGER fail_invoice_mail BEFORE INSERT ON email_jobs FOR EACH ROW EXECUTE FUNCTION fail_invoice_mail()",
  );
  try {
    expect(
      (
        await invoicesRouter.request(`/${account.invoice.id}/send`, {
          method: "POST",
          headers: await headers(account),
        })
      ).status,
    ).toBe(500);
    expect(
      (await database.query.invoices.findFirst({
        where: eq(schema.invoices.id, account.invoice.id),
      }))!.status,
    ).toBe("draft");
    expect(
      (await database.query.invoices.findFirst({
        where: eq(schema.invoices.id, account.invoice.id),
      }))!.identitySnapshot,
    ).toBeNull();
    expect(
      await database.query.emailJobs.findMany({
        where: eq(schema.emailJobs.invoiceId, account.invoice.id),
      }),
    ).toHaveLength(0);
  } finally {
    await client.unsafe(
      "DROP TRIGGER fail_invoice_mail ON email_jobs; DROP FUNCTION fail_invoice_mail()",
    );
  }
});

test("PDF routes enforce verification, ownership, and Trash before invoking the renderer", async () => {
  const account = await fixture(),
    stranger = await owner();
  let renders = 0;
  const router = (
    await import("../../src/routes/invoices")
  ).createInvoicesRouter(database, async () => {
    renders++;
    return Buffer.from("%PDF-test");
  });
  expect(
    (
      await router.request(`/${account.invoice.id}/pdf`, {
        headers: await headers(stranger),
      })
    ).status,
  ).toBe(404);
  await database
    .update(schema.users)
    .set({ emailVerifiedAt: null })
    .where(eq(schema.users.id, account.userId));
  expect(
    (
      await router.request(`/${account.invoice.id}/pdf`, {
        headers: await headers(account),
      })
    ).status,
  ).toBe(403);
  await database
    .update(schema.users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(schema.users.id, account.userId));
  await database
    .update(schema.invoices)
    .set({ deletedAt: new Date() })
    .where(eq(schema.invoices.id, account.invoice.id));
  expect(
    (
      await router.request(`/${account.invoice.id}/pdf`, {
        headers: await headers(account),
      })
    ).status,
  ).toBe(404);
  expect(renders).toBe(0);
  await database
    .update(schema.invoices)
    .set({ deletedAt: null, invoiceNumber: 'INV"\r\nUnexpected: header' })
    .where(eq(schema.invoices.id, account.invoice.id));
  const response = await router.request(`/${account.invoice.id}/pdf`, {
    headers: await headers(account),
  });
  expect(response.status).toBe(200);
  expect(renders).toBe(1);
  expect(response.headers.get("Content-Type")).toBe("application/pdf");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Disposition")).not.toMatch(/[\r\n]/);
  expect(await response.text()).toBe("%PDF-test");
});

test("PDF quotas are shared per account and do not affect another owner's downloads", async () => {
  const account = await fixture();
  let renders = 0;
  const router = (
    await import("../../src/routes/invoices")
  ).createInvoicesRouter(database, async () => {
    renders++;
    return Buffer.from("%PDF-test");
  });
  const ownHeaders = await headers(account);
  for (let n = 0; n < 10; n++)
    expect(
      (
        await router.request(`/${account.invoice.id}/pdf`, {
          headers: ownHeaders,
        })
      ).status,
    ).toBe(200);
  const blocked = await router.request(`/${account.invoice.id}/pdf`, {
    headers: ownHeaders,
  });
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(renders).toBe(10);
  const other = await fixture();
  expect(
    (
      await router.request(`/${other.invoice.id}/pdf`, {
        headers: await headers(other),
      })
    ).status,
  ).toBe(200);
});

test("PDF limits, busy responses, and timeouts retain useful statuses without exposing failures", async () => {
  const account = await fixture();
  const ownHeaders = await headers(account);
  for (const status of [422, 503, 504] as const) {
    const router = (
      await import("../../src/routes/invoices")
    ).createInvoicesRouter(database, async () => {
      throw new HTTPException(status, { message: "Safe PDF error" });
    });
    const response = await router.request(`/${account.invoice.id}/pdf`, {
      headers: ownHeaders,
    });
    expect(response.status).toBe(status);
    if (status === 503) expect(response.headers.get("Retry-After")).toBe("5");
  }
  const router = (
    await import("../../src/routes/invoices")
  ).createInvoicesRouter(database, async () => {
    throw Error("private source URL and token");
  });
  const response = await router.request(`/${account.invoice.id}/pdf`, {
    headers: ownHeaders,
  });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private source");
});
