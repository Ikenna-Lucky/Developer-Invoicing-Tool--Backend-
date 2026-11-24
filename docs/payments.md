# Payment recording and reconciliation

Invoices currently accept one full payment in NGN. Partial payments, refunds,
reversals, and settlement routing are outside this workflow. All endpoints below
require a signed-in, verified owner and an invoice outside Trash.

## Offline payments

`POST /invoices/:id/payments` records money received outside Paystack. Send an
`Idempotency-Key` header containing 16–128 letters, digits, underscores, or hyphens
(a UUID works). Generate it once for the payment and reuse it after a timeout or
retry. Do not generate a new key on each click.

```json
{
  "amount": "1250.50",
  "paidAt": "2026-11-22T10:00:00Z",
  "method": "bank_transfer",
  "reference": "Bank transaction or receipt number"
}
```

Amounts are decimal strings in naira, with at most two decimal places. The amount
must be positive and match the invoice total. Dates include a timezone and cannot
be in the future. Methods are `cash`, `bank_transfer`, and `other`; a reference is
required even for cash, where a receipt number can be used. The owner is attesting
that the payment was received; this endpoint does not verify bank transactions.

The payment and paid status commit together. The first request returns 201 with
`{ data: payment, duplicate: false }`. An identical retry returns the same payment
with 200 and `duplicate: true`. Amount formatting and equivalent timezone offsets
are normalized when comparing retries. Changing the invoice, amount, date, method,
or trimmed reference under the same key returns 409. Keys are scoped to the owner,
hashed in storage, unique, and retained with the payment without expiration.
Failed transactions leave no saved key or payment, so the original request can
be retried. Different keys cannot settle the same invoice twice.

Invoice row locks coordinate offline payments and Paystack webhooks across API
instances. Account/key transaction locks also serialize reuse across invoices.
The payment stores the authenticated owner in `recordedBy`. Database triggers
reject updates, deletes, and truncation of payment records. There is no correction
or reversal API yet; do not edit financial history manually.

## History

`GET /invoices/:id/payments` returns `{ data: [...] }`, newest first, bounded to
100 records. Normal invoices have at most one payment; this bound also applies
to historical data. Internal idempotency hashes are omitted. Paystack references
remain in the existing `stripePaymentId` field for compatibility. Offline receipt
references use `reference`; `method` identifies the source. Existing records gain
the `paystack` default because the previous payment writer used Paystack.

## Reconcile a missed Paystack webhook

`POST /invoices/:id/payments/reconcile` takes `{ "reference": "BILLD-..." }`.
Obtain the reference from Paystack's dashboard if the webhook was missed. The API
checks invoice ownership before contacting Paystack, then uses the server's secret
to call the [Verify Transaction endpoint](https://paystack.com/docs/api/transaction/).
The request has an eight-second deadline and a quota of ten checks per owner per
minute. A 429 response includes `Retry-After`.

Only a successful response with the requested reference, matching invoice metadata,
NGN currency, and exact total can settle the invoice. Verification and webhooks use
the same payment transaction and reference uniqueness rule. Repeated verification
returns `{ "result": "duplicate" }`; a new settlement returns `recorded`. Provider
failures return 502/503; invalid or unsuccessful verified charges return 422;
financial conflicts return 409. Raw provider payloads and secrets are not returned.

This is an owner-triggered recovery action, not an automatic reconciliation job or
a bank settlement report. A different payment already recorded on the invoice is
a conflict that needs investigation, including potential double payment/refund.

## Rollout

Migration `0010_payment_history.sql` adds payment fields, key uniqueness, and the
append-only trigger. It preserves existing payment rows and does not invent receipts
for historical paid invoices without a ledger entry. Review those separately.

Changing an unpaid invoice to paid through `PATCH /invoices/:id/status` now returns
409 with instructions to record a payment. Repeating paid on an already-paid
invoice remains a no-op. Update the frontend's manual-payment flow to collect the
fields above and retain its key before exposing the new workflow. Frontend files
were not changed in this build. Deploy schema before the new API; rolling back
the API restores the old status-only path and can create ledger gaps again.

Local verification uses real PostgreSQL for locks, constraints, migration,
rollback, ownership, sessions, offline history, and reconciliation/webhook replay.
Paystack verification is stubbed in automated checks; live provider behavior and
the Render/Neon deployment still need verification.
