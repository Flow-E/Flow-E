-- The product is now called Mandate. 001 and 002 created the append-only guard as
-- flowe_ledger_append_only(); they stay as written because they may already have run. This
-- migration gives the guard its new name and points every ledger trigger at it. Idempotent.
-- The tables keep their rows; nothing here touches ledger data.

create or replace function mandate_ledger_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'the ledger is append-only';
end;
$$;

drop trigger if exists ledger_entries_no_change on ledger_entries;
create trigger ledger_entries_no_change
  before update or delete on ledger_entries
  for each row execute function mandate_ledger_append_only();

drop trigger if exists ledger_entries_no_truncate on ledger_entries;
create trigger ledger_entries_no_truncate
  before truncate on ledger_entries
  for each statement execute function mandate_ledger_append_only();

drop trigger if exists org_ledger_entries_no_change on org_ledger_entries;
create trigger org_ledger_entries_no_change
  before update or delete on org_ledger_entries
  for each row execute function mandate_ledger_append_only();

drop trigger if exists org_ledger_entries_no_truncate on org_ledger_entries;
create trigger org_ledger_entries_no_truncate
  before truncate on org_ledger_entries
  for each statement execute function mandate_ledger_append_only();

drop function if exists flowe_ledger_append_only();
