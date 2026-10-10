-- 001_init.sql
-- Core schema for the Aangan Studio call agent.
-- Plain Postgres (14+): runs unchanged on Neon or Supabase.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type call_category as enum ('new_project', 'existing_client', 'vendor', 'spam');
create type call_handler  as enum ('ai', 'human');
create type lead_score    as enum ('qualified', 'not_fit', 'unclear');
create type property_type as enum ('home', 'office');
create type lead_status   as enum (
  'new', 'assigned', 'called', 'visit_booked', 'visit_done', 'won', 'lost', 'not_fit'
);

-- Keeps updated_at current on every UPDATE.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- designers: who receives qualified leads on Telegram
-- ---------------------------------------------------------------------------
create table designers (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  areas            text[] not null default '{}',   -- Pune localities, lower-case
  telegram_chat_id text unique,                    -- filled after they /start the bot
  calendly_link    text,
  active           boolean not null default true,
  last_assigned_at timestamptz,                    -- drives round-robin
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger designers_updated_at before update on designers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- calls: one row per phone call (AI-handled, or logged by the front desk)
-- ---------------------------------------------------------------------------
create table calls (
  id                uuid primary key default gen_random_uuid(),
  vani_call_id      text unique,                   -- null for human-logged calls
  handled_by        call_handler not null default 'ai',
  caller_phone      text not null,                 -- E.164, e.g. +919812345678
  started_at        timestamptz not null,
  ended_at          timestamptz,
  duration_sec      integer check (duration_sec >= 0),
  recording_consent boolean,                       -- null = not asked / unknown
  transcript        text,
  category          call_category,
  score             lead_score,
  gemini_tokens     integer not null default 0,
  cost_inr          numeric(10, 2) not null default 0,
  raw_payload       jsonb,
  created_at        timestamptz not null default now()
);
create index calls_caller_phone_idx on calls (caller_phone);
create index calls_started_at_idx   on calls (started_at);

-- ---------------------------------------------------------------------------
-- leads: the enquiry extracted from a new-project call
-- ---------------------------------------------------------------------------
create table leads (
  id                 uuid primary key default gen_random_uuid(),
  call_id            uuid not null unique references calls (id) on delete cascade,
  name               text,
  phone              text not null,
  area               text,
  property_type      property_type,
  size_sqft          integer check (size_sqft > 0),
  scope              text,
  budget             text,                         -- as the caller said it, e.g. "10-12 lakh"
  timeline           text,
  possession         text,
  source             text,                         -- referral / instagram / ...
  score              lead_score not null,
  summary            text,
  status             lead_status not null default 'new',
  designer_id        uuid references designers (id),
  assigned_at        timestamptz,
  due_at             timestamptz,                  -- designer callback deadline; after-hours leads roll to next morning
  first_action_at    timestamptz,
  reminder_sent_at   timestamptz,
  escalated_at       timestamptz,
  hubspot_contact_id text,
  hubspot_deal_id    text,
  calendly_event_uri text unique,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index leads_phone_idx    on leads (phone);
create index leads_status_idx   on leads (status);
create index leads_designer_idx on leads (designer_id);
-- The reminder cron only scans leads still waiting on a designer.
create index leads_waiting_idx  on leads (due_at)
  where status = 'assigned' and first_action_at is null;
create trigger leads_updated_at before update on leads
  for each row execute function set_updated_at();
