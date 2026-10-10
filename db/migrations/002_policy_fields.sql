-- 002_policy_fields.sql
-- Fields the agent collects for Nikhil's five criteria (knowledge/qualified.md),
-- plus escalation and the price-guardrail audit.

alter table calls
  add column language          text check (language in ('en', 'hi', 'mr', 'mixed')),
  add column escalate          boolean not null default false,  -- existing client needs a senior person
  add column escalation_reason text,
  add column price_mentions    text[] not null default '{}';    -- anything price-like the AGENT said; should always be empty

alter table leads
  add column intent                  text check (intent in (
    'design_and_execution', 'advice_only', 'self_execution', 'furniture_only',
    'vastu_only', 'structural_only', 'exploring', 'unknown')),
  add column project_kind            text check (project_kind in (
    'home', 'office', 'clinic', 'studio', 'restaurant', 'hotel', 'retail', 'gym', 'other', 'unknown')),
  add column scope_kind              text check (scope_kind in (
    'full_home', 'partial_home', 'single_room', 'commercial_fitout', 'unknown')),
  add column room_count              integer check (room_count > 0),
  add column current_state           text,
  add column site_available_in_weeks integer check (site_available_in_weeks >= 0),
  add column deadline_date           date,
  add column budget_max_inr          bigint check (budget_max_inr >= 0),
  add column decision_maker          text check (decision_maker in (
    'self', 'authorised', 'research_only', 'not_authorised', 'unknown')),
  add column rented                  boolean,
  add column consultation_preference text,
  add column priority                boolean not null default false, -- let down before, or VIP referral
  add column open_questions          text[] not null default '{}',   -- for the designer to answer
  add column score_reasons           text[] not null default '{}',   -- why not_fit / unclear
  add column handoff_notes           text[] not null default '{}',   -- uncertainties to pass on
  add column agent_score             lead_score;                     -- the LLM's own call, kept to compare

create index calls_escalate_idx on calls (started_at) where escalate;
