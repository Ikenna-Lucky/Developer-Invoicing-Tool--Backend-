# Invoice identity snapshots

Drafts use the current business and client profiles. The first transition out of
draft captures the sender's name, business name, email, address, phone, and logo;
and the client's name, company name, email, address, and phone. Authentication
fields, passwords, session data, and provider credentials are not copied.

The `identitySnapshot` field contains `sender`, `client`, `source`, and
`capturedAt`. PostgreSQL captures it in the issuance transaction and rejects
later replacement or removal. A caller cannot supply a draft snapshot. Direct
SQL issuance also captures the identity. The normal Send flow holds shared locks
on the sender and client while it initializes checkout and issues the invoice,
so profile changes cannot split the checkout/email/snapshot identities. These
locks can delay profile edits during a slow checkout call (up to its existing
eight-second deadline). Snapshot, status, and queued email roll back together if
issuance fails; a draft preview alone does not create a snapshot.

Invoice detail responses overlay saved client identity onto the existing `client`
object. The original client ID remains the relationship; client profile endpoints
still show the current profile. Invoice lists, Trash, and name search use the
saved name; lists also use saved email/company where those fields already exist.
Future drafts and new invoices use updated profiles. Snapshot sender fields are
available in the detail response for a future frontend invoice view. No frontend
files changed here.

PDFs and invoice emails use saved details, including saved null values rather
than falling back to a newly added address, company name, or logo. Resends go to
the saved client email. Sending to a different address needs a separate explicit
delivery/correction workflow; editing a client profile does not redirect an issued
invoice. Already queued emails retain their existing encrypted payloads.

Snapshots preserve identity, not an identical binary PDF. Payment status,
renderer changes, and other supported document behavior can still change a later
PDF. An embedded data-URL logo is preserved in the snapshot; an external logo URL
does not become an archived image. Existing PDF validation still rejects external
image fetches and unsupported/oversized logos.

## Migration and existing invoices

Migration `0011_invoice_identity.sql` adds the JSON field and capture/protection
functions. Existing non-draft invoices copy the profiles available at migration
time with `source: legacy_backfill`. This is not proof of their original identity;
details may already have changed. Capture time records the migration statement
time. Newly issued snapshots use `source: issued`. Drafts stay null. Historical
email payloads/PDF downloads are not rewritten.

The backfill updates issued invoice rows and adds their normal audit events
without copying snapshot contents into the audit log. Plan migration timing for
the actual invoice count and logo sizes: it runs in startup migrations, can hold
table/row locks, and adds storage proportional to saved identities/logos. Deploy
schema before this API code. Rolling back only the API leaves database snapshots
intact, but older document readers may show live profiles again.

Identity corrections, an invoice revision/reissue workflow, and recovery of missing
historical details remain separate work. No production migration or deployment
was performed during this build.
