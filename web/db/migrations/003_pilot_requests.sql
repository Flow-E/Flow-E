-- Pilot requests from the form on the home page (POST /api/pilot). Postgres 15+ (Supabase) and
-- PGlite. Idempotent: safe to run more than once.
--
-- Only the server's own database connection reads or writes this table: row-level security is
-- enabled with no policies, so Supabase's public (anon) key can do nothing here.

create table if not exists pilot_requests (
  id                uuid        primary key,
  created_at        timestamptz not null default now(),
  name              text        not null check (char_length(name) between 1 and 120),
  email             text        not null check (char_length(email) between 3 and 254),
  company           text        not null check (char_length(company) between 1 and 160),
  role              text        not null check (char_length(role) between 1 and 120),
  size              text        not null check (size in ('1-9', '10-49', '50-249', '250-999', '1000+')),
  buying            text        not null check (char_length(buying) between 1 and 2000),
  country           text                 check (country is null or char_length(country) <= 80),
  message           text                 check (message is null or char_length(message) <= 4000),
  -- new: not yet answered · contacted: the founder replied · declined: not a fit, or spam
  status            text        not null default 'new'
                                check (status in ('new', 'contacted', 'declined')),
  status_changed_at timestamptz,
  status_changed_by text
);

create index if not exists pilot_requests_newest on pilot_requests (created_at desc);

alter table pilot_requests enable row level security;
