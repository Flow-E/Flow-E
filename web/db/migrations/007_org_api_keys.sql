-- Organisation API keys for other systems (inventory, accounting), separate from agent keys,
-- and the access log of every call made with them. Postgres 15+ (Supabase) and PGlite.
-- Idempotent: safe to run more than once.
--
-- Only the key's SHA-256 is stored; the key itself is shown once. The access log holds method,
-- path and status only: never the key, the body or the caller's address. Rows older than 90
-- days are deleted by the server.
--
-- Only the server's own database connection reads or writes these tables: row-level security is
-- enabled with no policies, so Supabase's public (anon) key can do nothing here. Every query in
-- the server is scoped by org_id.

create table if not exists org_api_keys (
  id           uuid        primary key,
  org_id       uuid        not null references orgs (id),
  name         text        not null check (char_length(name) between 1 and 80),
  prefix       text        not null,
  key_hash     text        not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes       text[]      not null,
  created_by   text        not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists org_api_keys_by_org on org_api_keys (org_id, created_at desc);

alter table org_api_keys enable row level security;

create table if not exists org_api_access_log (
  id         uuid        primary key,
  org_id     uuid        not null references orgs (id),
  key_id     uuid        not null references org_api_keys (id),
  method     text        not null check (char_length(method) between 1 and 10),
  path       text        not null check (char_length(path) between 1 and 200),
  status     integer     not null,
  created_at timestamptz not null default now()
);

create index if not exists org_api_access_log_by_org on org_api_access_log (org_id, created_at desc);

alter table org_api_access_log enable row level security;
