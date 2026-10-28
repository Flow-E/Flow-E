-- Reorder signals from other systems: they only add suggestions to the reorder list. Postgres
-- 15+ (Supabase) and PGlite. Idempotent: safe to run more than once.
--
-- A row typed in by a person has source null and status active. A signal adds a row with
-- source = the API key's name and status suggested (matched to the price list) or
-- needs_matching (not matched; never guessed). A person accepts, links or dismisses it; with
-- auto-include on, a run uses suggested rows once and marks them used.
-- org_reorder_signals keeps each signal's idempotency key and answer, so a repeated signal gets
-- the same answer and adds nothing.
--
-- Row-level security is enabled with no policies: only the server's own connection reads or
-- writes, and every query in the server is scoped by org_id.

alter table org_reorder_items add column if not exists source     text;
alter table org_reorder_items add column if not exists status     text not null default 'active';
alter table org_reorder_items add column if not exists reason     text;
alter table org_reorder_items add column if not exists needed_by  date;
alter table org_reorder_items add column if not exists price_item text;
alter table org_reorder_items add column if not exists unit       text;
alter table org_reorder_items add column if not exists created_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'org_reorder_items_status_check') then
    alter table org_reorder_items add constraint org_reorder_items_status_check
      check (status in ('active', 'suggested', 'needs_matching', 'dismissed', 'used'));
  end if;
end $$;

create table if not exists org_reorder_signals (
  org_id          uuid        not null references orgs (id),
  idempotency_key text        not null check (char_length(idempotency_key) between 1 and 200),
  key_id          uuid        not null,
  request         jsonb       not null,
  result          jsonb       not null,
  created_at      timestamptz not null default now(),
  primary key (org_id, idempotency_key)
);

alter table org_reorder_signals enable row level security;

create table if not exists org_integration_settings (
  org_id                 uuid    primary key references orgs (id),
  auto_include_suggested boolean not null default false,
  updated_by             text    not null,
  updated_at             timestamptz not null default now()
);

alter table org_integration_settings enable row level security;
