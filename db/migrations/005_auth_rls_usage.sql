-- 005_auth_rls_usage.sql
--  * designers.email: the Google account a designer signs in to the dashboard with.
--    Sign-in is Google OAuth only; there is no sign-up. An email not in this
--    table (or in DASHBOARD_ADMIN_EMAILS) is turned away.
--  * Input/output token counts per call, for the cost formula in the build brief.
--  * ai_usage: every other Gemini call the system makes (Telegram bot questions),
--    so "what the tool costs to run" is complete.
--  * Row Level Security on every table. The app connects as the table owner and
--    is unaffected; Supabase's public API roles (anon/authenticated) get nothing.

alter table designers
  add column email text unique check (email = lower(email));

alter table calls
  add column llm_input_tokens  integer not null default 0,
  add column llm_output_tokens integer not null default 0;

create table ai_usage (
  id            bigint generated always as identity primary key,
  kind          text not null,           -- 'bot_question', ...
  actor         text,                    -- who asked (designer id, 'nikhil', 'frontdesk')
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_inr      numeric(10, 4) not null default 0,
  at            timestamptz not null default now()
);
create index ai_usage_at_idx on ai_usage (at);

alter table designers         enable row level security;
alter table calls             enable row level security;
alter table leads             enable row level security;
alter table lead_events       enable row level security;
alter table ai_usage          enable row level security;
alter table if exists schema_migrations enable row level security; -- created by scripts/migrate.ts
