-- Flow-E phase 2: organisations, members and roles, real agents with keys, approval emails.
-- Idempotent. Postgres 15+ (Supabase) and PGlite. Each organisation has its own issuer key and
-- its own append-only, hash-chained, signed ledger (org_ledger_entries), separate from the
-- sandbox tables, which stay exactly as they were.

create table if not exists orgs (
  id                     uuid primary key,
  name                   text not null,
  -- mandate.yaml as JSON (snake_case), validated with the core schema on every read
  config                 jsonb not null,
  issuer                 text not null,
  issuer_public_key      text not null,
  -- AES-256-GCM with the server's key-encryption key, as for sandboxes
  issuer_private_key_enc text not null,
  created_by             text not null,
  created_at             timestamptz not null default now()
);

create table if not exists org_members (
  org_id     uuid not null references orgs (id),
  user_id    text not null,
  email      text not null,
  role       text not null check (role in ('owner', 'approver', 'viewer')),
  added_by   text not null,
  added_at   timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_by_user on org_members (user_id);

create table if not exists org_invitations (
  id          uuid primary key,
  org_id      uuid not null references orgs (id),
  email       text not null,
  role        text not null check (role in ('owner', 'approver', 'viewer')),
  -- SHA-256 of the one-time token; the token itself is only ever in the email
  token_hash  text not null unique,
  invited_by  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by text,
  revoked_at  timestamptz
);
create index if not exists org_invitations_by_org on org_invitations (org_id);

-- An agent's mandate lives in orgs.config; this row holds its name and signed credential.
create table if not exists org_agents (
  org_id       uuid not null references orgs (id),
  agent_id     text not null,
  display_name text not null,
  -- the Know Your Agent credential, signed by the org issuer (same format as the CLI)
  credential   jsonb not null,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  primary key (org_id, agent_id)
);

create table if not exists agent_keys (
  id           uuid primary key,
  org_id       uuid not null references orgs (id),
  agent_id     text not null,
  -- first characters of the key, shown so people can tell keys apart; never enough to use it
  prefix       text not null,
  -- SHA-256 of the whole key; the key itself is shown once and never stored
  key_hash     text not null unique,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   text,
  foreign key (org_id, agent_id) references org_agents (org_id, agent_id)
);
create index if not exists agent_keys_by_agent on agent_keys (org_id, agent_id);

create table if not exists org_ledger_entries (
  org_id     uuid    not null references orgs (id),
  seq        integer not null,
  id         text    not null,
  type       text    not null,
  agent_id   text    not null,
  created_at text    not null,
  data       text    not null,
  prev_hash  text    not null,
  hash       text    not null,
  signature  text    not null,
  primary key (org_id, seq),
  unique (org_id, id)
);

drop trigger if exists org_ledger_entries_no_change on org_ledger_entries;
create trigger org_ledger_entries_no_change
  before update or delete on org_ledger_entries
  for each row execute function flowe_ledger_append_only();

drop trigger if exists org_ledger_entries_no_truncate on org_ledger_entries;
create trigger org_ledger_entries_no_truncate
  before truncate on org_ledger_entries
  for each statement execute function flowe_ledger_append_only();

-- One-time links in approval emails: one per recipient, payment and action.
create table if not exists approval_tokens (
  id          uuid primary key,
  org_id      uuid not null references orgs (id),
  payment_id  text not null,
  user_id     text not null,
  email       text not null,
  action      text not null check (action in ('approve', 'decline')),
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index if not exists approval_tokens_by_payment on approval_tokens (org_id, payment_id);

-- Development outbox: emails are stored here instead of sent. Production refuses to use it.
create table if not exists email_outbox (
  id         uuid primary key,
  to_email   text not null,
  subject    text not null,
  body_text  text not null,
  body_html  text not null,
  kind       text not null,
  created_at timestamptz not null default now()
);

alter table orgs enable row level security;
alter table org_members enable row level security;
alter table org_invitations enable row level security;
alter table org_agents enable row level security;
alter table agent_keys enable row level security;
alter table org_ledger_entries enable row level security;
alter table approval_tokens enable row level security;
alter table email_outbox enable row level security;
