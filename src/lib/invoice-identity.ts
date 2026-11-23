import type { Invoice, Client } from "../db/schema";

export function invoiceWithIdentity<T extends Invoice & { client: Client }>(
  invoice: T,
): T {
  const snapshot = invoice.identitySnapshot;
  return snapshot
    ? { ...invoice, client: { ...invoice.client, ...snapshot.client } }
    : invoice;
}
