-- "Run reorder": an organisation's reorder list and the log of each run of the built-in
-- purchasing agent. Postgres 15+ (Supabase) and PGlite. Idempotent: safe to run more than once.
--
-- The agent itself has no special access: it asks for payments through the same tools as any
-- external agent, and every decision is a signed ledger entry as usual. These tables only hold
-- what to reorder and a plain-language log of what each run did.
--
-- Only the server's own database connection reads or writes these tables: row-level security is
-- enabled with no policies, so Supabase's public (anon) key can do nothing here. Every query in
-- the server is scoped by org_id.

create table if not exists org_reorder_items (
  id         uuid        primary key,
  org_id     uuid        not null references orgs (id),
  position   integer     not null check (position between 0 and 999),
  item       text        not null check (char_length(item) between 1 and 200),
  supplier   text        check (supplier is null or char_length(supplier) between 1 and 200),
  quantity   integer     not null check (quantity between 1 and 100000),
  -- Optional, entered by hand: reorder only when stock is below min_stock.
  stock      integer     check (stock is null or stock between 0 and 100000000),
  min_stock  integer     check (min_stock is null or min_stock between 0 and 100000000),
  category   text        check (category is null or category ~ '^[0-9]{4}$'),
  country    text        check (country is null or country ~ '^[A-Z]{2}$'),
  updated_by text        not null,
  updated_at timestamptz not null default now()
);

create index if not exists org_reorder_items_by_org on org_reorder_items (org_id, position);

alter table org_reorder_items enable row level security;

create table if not exists org_agent_runs (
  id          uuid        primary key,
  org_id      uuid        not null references orgs (id),
  agent_id    text        not null,
  mode        text        not null check (mode in ('claude', 'simulated')),
  status      text        not null check (status in ('running', 'finished', 'stopped', 'failed')),
  started_by  text        not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  steps       integer     not null default 0,
  tokens      integer     not null default 0,
  log         jsonb       not null default '[]'::jsonb
);

create index if not exists org_agent_runs_by_org on org_agent_runs (org_id, started_at desc);

alter table org_agent_runs enable row level security;
