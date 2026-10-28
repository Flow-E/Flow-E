-- Webhooks: notifications to other systems when a payment is decided, an order is recorded or
-- an invoice is matched. Postgres 15+ (Supabase) and PGlite. Idempotent: safe to run more than
-- once.
--
-- Deliveries are made from the ledger, after the fact: each endpoint has a cursor (the last
-- ledger entry it has seen), so sending can never change, block or slow a decision. The
-- endpoint's signing secret is stored encrypted (it is needed to sign every delivery). Response
-- bodies are never stored.
--
-- Row-level security is enabled with no policies: only the server's own connection reads or
-- writes, and every query in the server is scoped by org_id.

create table if not exists org_webhooks (
  id          uuid        primary key,
  org_id      uuid        not null references orgs (id),
  url         text        not null check (char_length(url) between 9 and 500),
  events      text[]      not null,
  secret_enc  text        not null,
  cursor_seq  integer     not null default 0,
  created_by  text        not null,
  created_at  timestamptz not null default now(),
  disabled_at timestamptz
);

create index if not exists org_webhooks_by_org on org_webhooks (org_id, created_at desc);

alter table org_webhooks enable row level security;

create table if not exists org_webhook_deliveries (
  id              uuid        primary key,
  org_id          uuid        not null references orgs (id),
  webhook_id      uuid        not null references org_webhooks (id),
  event           text        not null,
  entry_seq       integer     not null,
  payload         jsonb       not null,
  status          text        not null check (status in ('pending', 'delivered', 'failed')),
  attempts        integer     not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status     integer,
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  unique (webhook_id, entry_seq, event)
);

create index if not exists org_webhook_deliveries_due on org_webhook_deliveries (status, next_attempt_at);
create index if not exists org_webhook_deliveries_by_org on org_webhook_deliveries (org_id, created_at desc);

alter table org_webhook_deliveries enable row level security;
