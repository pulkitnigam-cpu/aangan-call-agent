-- 004_workflow.sql
-- Workflow fixes from the 7 Oct review:
--  * keep what the agent PROMISED the caller, so routing never breaks a promise
--  * designers accept or pass on a lead; unaccepted leads are reassigned
--  * dropped / failed calls get a front-desk follow-up unless the caller rang back
--  * repeat calls merge into one lead instead of duplicating it
--  * an audit trail of every lead event (for "time to accept" etc. on the dashboard)

alter table calls
  add column lead_id          uuid references leads (id) on delete set null,
  add column status           text not null default 'completed'
    check (status in ('in_progress', 'completed', 'dropped', 'failed')),
  add column promised_outcome text
    check (promised_outcome in ('designer_callback', 'front_desk_callback', 'declined', 'escalated', 'none')),
  add column live_check       jsonb,        -- last check-fit result the agent got during the call
  add column processed_at     timestamptz,  -- post-call handled; makes the webhook idempotent
  add column followup_sent_at timestamptz;  -- dropped/failed call sent to the front desk

create index calls_phone_time_idx on calls (caller_phone, started_at desc);
create index calls_unfollowed_idx on calls (started_at)
  where status in ('dropped', 'failed') and followup_sent_at is null;

alter table leads
  add column owner               text not null default 'designer'
    check (owner in ('designer', 'front_desk')),
  add column accepted_at         timestamptz,
  add column declined_by         uuid[] not null default '{}',  -- designers who passed or timed out
  add column reassign_count      integer not null default 0,
  add column not_fit_reason      text,
  add column needs_review        boolean not null default false,
  add column review_reason       text,
  add column designer_message_id bigint,                        -- Telegram card, edited on each action
  add column last_call_at        timestamptz;

create table lead_events (
  id      bigint generated always as identity primary key,
  lead_id uuid not null references leads (id) on delete cascade,
  type    text not null,   -- created, merged, assigned, accepted, passed, timeout, reminded, escalated, called, visit_booked, not_fit, ...
  actor   text,            -- 'system', 'agent', designer id, 'frontdesk'
  data    jsonb,
  at      timestamptz not null default now()
);
create index lead_events_lead_idx on lead_events (lead_id, at);
