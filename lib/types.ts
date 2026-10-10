// Row types mirroring db/migrations/*.sql.

import type { DecisionMaker, Intent, ProjectKind, ScopeKind } from "./policy";

export type CallCategory = "new_project" | "existing_client" | "vendor" | "spam";
export type CallHandler = "ai" | "human";
export type LeadScore = "qualified" | "not_fit" | "unclear";
export type PropertyType = "home" | "office";
export type LeadStatus =
  | "new"
  | "assigned"
  | "called"
  | "visit_booked"
  | "visit_done"
  | "won"
  | "lost"
  | "not_fit";

export interface Designer {
  id: string;
  name: string;
  areas: string[];
  telegram_chat_id: string | null;
  calendly_link: string | null;
  active: boolean;
  last_assigned_at: Date | null;
}

export interface Call {
  id: string;
  vani_call_id: string | null;
  handled_by: CallHandler;
  caller_phone: string;
  started_at: Date;
  ended_at: Date | null;
  duration_sec: number | null;
  recording_consent: boolean | null;
  transcript: string | null;
  category: CallCategory | null;
  score: LeadScore | null;
  gemini_tokens: number;
  cost_inr: string; // numeric comes back as a string to avoid float rounding
  raw_payload: unknown;
  language: "en" | "hi" | "mr" | "mixed" | null;
  escalate: boolean;
  escalation_reason: string | null;
  price_mentions: string[];
  lead_id: string | null;
  status: "in_progress" | "completed" | "dropped" | "failed";
  promised_outcome: string | null;
  live_check: unknown;
  processed_at: Date | null;
  followup_sent_at: Date | null;
}

export interface Lead {
  id: string;
  call_id: string;
  name: string | null;
  phone: string;
  area: string | null;
  property_type: PropertyType | null;
  size_sqft: number | null;
  scope: string | null;
  budget: string | null;
  timeline: string | null;
  possession: string | null;
  source: string | null;
  score: LeadScore;
  summary: string | null;
  status: LeadStatus;
  designer_id: string | null;
  assigned_at: Date | null;
  due_at: Date | null;
  first_action_at: Date | null;
  reminder_sent_at: Date | null;
  escalated_at: Date | null;
  hubspot_contact_id: string | null;
  hubspot_deal_id: string | null;
  calendly_event_uri: string | null;
  intent: Intent | null;
  project_kind: ProjectKind | null;
  scope_kind: ScopeKind | null;
  room_count: number | null;
  bhk: number | null;
  current_state: string | null;
  site_available_in_weeks: number | null;
  deadline_date: Date | null; // postgres.js parses `date` columns into Date
  budget_max_inr: string | null; // bigint comes back as a string
  decision_maker: DecisionMaker | null;
  rented: boolean | null;
  consultation_preference: string | null;
  priority: boolean;
  open_questions: string[];
  score_reasons: string[];
  handoff_notes: string[];
  agent_score: LeadScore | null;
  owner: "designer" | "front_desk";
  accepted_at: Date | null;
  declined_by: string[];
  reassign_count: number;
  not_fit_reason: string | null;
  needs_review: boolean;
  review_reason: string | null;
  designer_message_id: string | null; // bigint comes back as a string
  last_call_at: Date | null;
  created_at: Date;
}
