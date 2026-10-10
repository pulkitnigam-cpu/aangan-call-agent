-- 003_bhk.sql
-- The agent asks for "carpet area, or at least the BHK", but there was no
-- column for BHK. Designers want it on the card, and the budget check uses it
-- when size is unknown.

alter table leads
  add column bhk integer check (bhk between 1 and 10);
