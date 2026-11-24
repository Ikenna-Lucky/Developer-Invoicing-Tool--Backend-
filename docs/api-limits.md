# List pagination and request budgets

`GET /clients`, `GET /invoices`, and `GET /invoices/trash` return at most 25 rows by
default. Set `limit` from 1 through 100. The existing `data` array remains; a
`pagination` object describes continuation:

```json
{
  "data": [],
  "pagination": { "limit": 25, "hasMore": false, "nextCursor": null }
}
```

When `hasMore` is true, send the returned opaque `nextCursor` as `cursor` on the
next request, keeping the same filters. Stop when `nextCursor` is null. There is
no unbounded option, offset, total count, or arbitrary page jump. To restart or
change filters, omit the cursor. Empty lists return an empty array and null cursor.

All three routes accept trimmed `search` of at most 100 characters. Invoice routes
also accept `status=draft|sent|paid|overdue` and a UUID `clientId`. Filters combine
with the authenticated owner and active/Trash scope on every page. Search is
case-insensitive literal substring matching: `%`, `_`, and backslash are not user
wildcards. Malformed cursors, invalid filters, repeated parameters, unknown query
keys, and invalid limits return 400 rather than silently falling back.

Clients and active invoices sort by creation timestamp then ID, newest first;
Trash sorts by deletion timestamp then ID. Cursors retain database microseconds.
Deleting the previous page's last row does not invalidate continuation. A cursor
is not an authorization token; crafting one cannot remove the owner filter. This
is a live view rather than a frozen snapshot: new records above the cursor appear
after refreshing, and changes to Trash/status/search membership can change later
pages. Reset after edits if a current full view is needed.

Migration `0009_list_pagination` adds an owner/creation/ID client index and partial
owner/time/ID indexes for active and trashed invoices. Apply through the normal
migration process before rollout. Index creation is transactional and can lock
writes on large existing tables; plan a maintenance window and verify on staging.
The installed generator omits partial-index predicates in generated SQL, so this
migration explicitly supplies them. Schema snapshots still belong in the repo.
Substring search can still scan many owner records; response pagination is not a
production-scale search performance claim.

## Request sizes

The API entry applies these budgets before JSON parsing, authentication database
checks, and webhook processing (CSRF and CORS still run first):

| Path                                               |                                         Body budget |
| -------------------------------------------------- | --------------------------------------------------: |
| `/auth/me`                                         | 768 KiB, allowing the existing inline logo workflow |
| `/webhooks/paystack`                               |                                             256 KiB |
| `/invoices` and child routes                       |                                             128 KiB |
| Other routes, including clients and authentication |                                              16 KiB |

Limits count actual streamed bytes, regardless of Content-Length. Bodies above
the budget return 413; read failures return 400. Accepted bytes are preserved,
including Paystack's signed raw body. URLs above 8192 UTF-8 bytes return 414. A
complete URL is already supplied by the server at this point; ingress limits
remain important. Slow uploads, connection counts, and edge traffic still need
hosting-level deadlines/protection. These controls do not change rate quotas.

Write validation additionally limits:

| Field                                                 |           Maximum |
| ----------------------------------------------------- | ----------------: |
| Invoice line items on create/update                   |               100 |
| Item description                                      |    500 characters |
| Invoice notes                                         |   5000 characters |
| Client name/company and updated profile name/business |    200 characters |
| Client email                                          |    254 characters |
| Client/profile phone                                  |     40 characters |
| Client/profile address                                |   2000 characters |
| Updated profile logo string                           | 700000 characters |

Character limits do not replace byte limits; multilingual text can consume more
bytes. Existing PDF/logo decoding and rendering restrictions still apply. Oversize
fields/batches return 400 and do not persist partial changes. Historical oversized
values are not truncated or backfilled. A capped row count does not guarantee a
fixed response-byte size for legacy records.

## Frontend compatibility and verification

This change is backend-only. Current frontend callers read `data` and do not yet
consume `pagination`; accounts with more than 25 matches will show only the first
page until that UI is updated. Client selectors, list/search views, Trash, client
invoice history, and any totals computed from list results need pagination-aware
handling before deploying the contract change to those users. The existing
`clientId` invoice query is now actually applied by the backend. Do not display a
single page's length or sum as an account-wide total.

PostgreSQL tests traverse timestamp ties and sub-millisecond records, check owner
isolation and filters across pages, empty results, foreign/crafted cursors, deleted
anchors, invalid inputs, and rejected writes. Stream tests check byte preservation,
exact boundaries, missing/false Content-Length, read failures, and URL budgets.
Existing regression and recovery suites run against the forward migration. Hosted
CI, live Paystack delivery at these limits, deployed ingress, frontend flows, and
production-scale search/index costs remain unverified.
