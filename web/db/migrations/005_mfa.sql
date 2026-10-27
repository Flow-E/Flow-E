-- Second factor: authenticator-app codes (TOTP) for owners and approvers. Postgres 15+
-- (Supabase) and PGlite. Idempotent: safe to run more than once.
--
-- One row per person (the session's user id, e.g. a Supabase user id). A row with enabled_at
-- null is a set-up that was started but not yet confirmed with a first code.
-- Only the server's own database connection reads or writes this table: row-level security is
-- enabled with no policies, so Supabase's public (anon) key can do nothing here.

create table if not exists user_mfa (
  user_id         text        primary key,
  -- the shared TOTP secret, AES-256-GCM with the server's key-encryption key (as issuer keys)
  secret_enc      text        not null,
  enabled_at      timestamptz,
  -- the last 30-second step a code was accepted for; a code for this step or earlier is refused
  last_step       bigint,
  -- SHA-256 hashes of the unused one-time recovery codes; the codes themselves are shown once
  recovery_hashes jsonb       not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);

alter table user_mfa enable row level security;
