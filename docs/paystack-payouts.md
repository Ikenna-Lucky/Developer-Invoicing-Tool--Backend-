# Freelancer payment routing

Billd uses one platform Paystack integration and a separate subaccount for each
freelancer. New NGN invoice checkouts route settlement to the invoice owner's
subaccount. Platform commission is zero (`percentage_charge: 0` and
`transaction_charge: 0`); the freelancer bears Paystack's processing fee
(`bearer: "subaccount"`). The client pays the invoice total. A full successful
charge marks the invoice paid even though the freelancer receives less after fees.
Payment received and money settled into a bank account are different events;
Billd does not claim that an invoice payment proves bank settlement.

## Setup and API

1. Configure `PAYSTACK_SECRET_KEY` with your platform's `sk_test_...` key. Keep it
   on the backend. There is no separate fee-policy environment variable.
2. Apply migration 0012 through the usual migration/deployment process.
3. Sign in with a verified Billd account. All `/payouts` routes require that
   session; writes also use the application's existing CSRF protection.
4. Call `GET /payouts/banks`. Follow the returned `next` cursor with
   `GET /payouts/banks?next=...` until it is null. Only active Nigerian NGN banks
   are returned, at most 100 per page.
5. Submit `POST /payouts/account` with `{"bankCode":"058","accountNumber":"0123456789"}`.
   Use the selected bank's actual code and the freelancer's intended account.
   The number here illustrates the input format; it is not a recommended account.
6. Read `GET /payouts/account` to check `pending` or `ready`. Responses include
   the resolved account name and last four digits, never the full account number,
   provider subaccount code, or credentials.
7. Send a draft invoice through the existing invoice endpoint. With a Paystack
   key configured, a ready payout account in the same environment is required.
   A provider failure leaves the invoice draft and does not queue its email.

The backend resolves the account name before creating the subaccount. Bank
resolution does not establish identity, account ownership, or KYC approval.
Freelancers must check their intended account details. This build adds backend
endpoints; a frontend onboarding form remains separate work.

## Retries and pending setup

Repeating the same completed setup returns the saved result. Concurrent requests
create at most one provider subaccount. Once creation starts, a timeout or invalid
provider response leaves a durable pending record. Automatic retries cannot create
another subaccount because the first request may already have succeeded remotely.

An operator should inspect the pending row and find the provider subaccount whose
description is exactly `Billd payout <payout-account-UUID>`. After confirming the
environment and provider record, run:

```bash
bun run payouts:reconcile <payout-account-UUID> <ACCT_subaccount-code>
```

Use the same database and Paystack credentials as the original setup. The command
fetches the provider record and checks its code, environment, currency, active
status, zero commission, description, and account-number fingerprint before
completing the pending record. It does not create or modify a provider subaccount.
If no remote subaccount exists, leave setup pending and investigate; this command
does not guess whether a failed creation can be retried safely.

Payout accounts cannot be changed or deleted through the API. Bank changes,
provider-account migration, and key rotation require a reviewed migration and
consideration of issued links. A changed API-key fingerprint deliberately blocks
new checkout creation for previously configured payout accounts. Do not edit bank
details behind an existing subaccount in the Paystack dashboard: issued invoices
reference that provider resource, and the local snapshot cannot prevent provider
administrators from changing it.

## Payment verification and existing invoices

Each new checkout stores its reference, invoice, owner subaccount, environment,
gross amount, and fee bearer. Database triggers prevent routing edits and
cross-owner attachment. Successful charge events and reconciliation must match
that saved reference, amount, currency, environment, and subaccount code. Missing
or conflicting routing evidence is rejected rather than treating the invoice as
paid. Signed webhooks are still required; browser redirects do not prove payment.

Migration 0012 preserves invoices already issued before the migration on the
legacy verification path. Their old links are not redirected to freelancers.
Review any outstanding legacy invoices before live use. Existing drafts use the
new routing path. Without a Paystack key, offline invoice sending remains available.

## Verification and live rollout

Local tests use disposable PostgreSQL databases and stub Paystack HTTP responses.
They cover setup retries and races, ambiguous creation and reconciliation,
ownership, immutable routing, fee payloads, provider failure rollback, invoice
send races, payment matching, and duplicate webhook processing. They do not prove
Paystack accepted a real account or settled money.

Before rollout, exercise bank listing, account resolution, subaccount creation,
checkout, a test payment, signed webhook delivery, and reconciliation with the
actual test integration. Confirm that actual charge payloads include `domain`
and `subaccount.subaccount_code`; missing evidence is rejected. Test mode moves
no real funds. Live activation requires Paystack eligibility/compliance checks,
separate live subaccounts, and a controlled end-to-end live settlement check.

Provider contracts: [split payments](https://paystack.com/docs/payments/split-payments/),
[subaccounts](https://paystack.com/docs/api/subaccount/),
[bank listing](https://paystack.com/docs/api/miscellaneous/), and
[account resolution](https://paystack.com/docs/api/verification/#resolve-account-number).
