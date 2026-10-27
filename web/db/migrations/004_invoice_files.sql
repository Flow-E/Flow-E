-- Supplier invoice files (PDF, PNG, JPEG; at most 5 MB) uploaded to an organisation. Postgres 15+
-- (Supabase) and PGlite. Idempotent: safe to run more than once.
--
-- The invoice itself is a signed ledger entry (invoice.recorded, with this file's SHA-256); this
-- table keeps the original document next to it. invoice_id stays null until a person confirms
-- the invoice. Kept 10 years (Swiss bookkeeping rules); deletion is not built yet.
--
-- Only the server's own database connection reads or writes this table: row-level security is
-- enabled with no policies, so Supabase's public (anon) key can do nothing here.

create table if not exists org_invoice_files (
  id          uuid        primary key,
  org_id      uuid        not null references orgs (id),
  invoice_id  text,
  filename    text        not null check (char_length(filename) between 1 and 120),
  mime        text        not null check (mime in ('application/pdf', 'image/png', 'image/jpeg')),
  size        integer     not null check (size between 1 and 5242880),
  sha256      text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes       bytea       not null,
  uploaded_by text        not null,
  created_at  timestamptz not null default now()
);

create index if not exists org_invoice_files_by_invoice on org_invoice_files (org_id, invoice_id);

alter table org_invoice_files enable row level security;
