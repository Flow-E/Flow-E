-- Flow-E website sandbox schema. Postgres 15+ (Supabase) and PGlite.
-- The ledger is append-only: triggers refuse UPDATE, DELETE and TRUNCATE. A reset archives the
-- old sandbox and starts a new one; nothing is ever rewritten.

create table if not exists sandboxes (
  id                     uuid primary key,
  owner_id               text not null,
  -- mandate.yaml as JSON (snake_case), validated with the core schema on every read
  config                 jsonb not null,
  -- signed Know Your Agent credentials per agent id
  credentials            jsonb not null,
  issuer                 text not null,
  issuer_public_key      text not null,
  -- AES-256-GCM with FLOWE_SANDBOX_KEY: base64url(iv) . base64url(tag) . base64url(ciphertext)
  issuer_private_key_enc text not null,
  created_at             timestamptz not null default now(),
  archived_at            timestamptz
);

create unique index if not exists sandboxes_one_active_per_owner
  on sandboxes (owner_id) where archived_at is null;

create table if not exists ledger_entries (
  sandbox_id uuid    not null references sandboxes (id),
  seq        integer not null,
  id         text    not null,
  type       text    not null,
  agent_id   text    not null,
  -- ISO 8601 text exactly as hashed; canonical JSON text exactly as hashed
  created_at text    not null,
  data       text    not null,
  prev_hash  text    not null,
  hash       text    not null,
  signature  text    not null,
  primary key (sandbox_id, seq),
  unique (sandbox_id, id)
);

create or replace function flowe_ledger_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'the ledger is append-only';
end;
$$;

drop trigger if exists ledger_entries_no_change on ledger_entries;
create trigger ledger_entries_no_change
  before update or delete on ledger_entries
  for each row execute function flowe_ledger_append_only();

drop trigger if exists ledger_entries_no_truncate on ledger_entries;
create trigger ledger_entries_no_truncate
  before truncate on ledger_entries
  for each statement execute function flowe_ledger_append_only();

-- Supabase exposes the public schema through its REST API with the public (anon) key. Row-level
-- security with no policies denies that path completely; the app connects server-side only.
alter table sandboxes enable row level security;
alter table ledger_entries enable row level security;
