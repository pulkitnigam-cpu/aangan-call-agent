// The agent's live "check_fit" tool. Before closing a new-project call, the
// agent sends what it has collected; this applies Nikhil's rubric and returns
// the exact closing line. The agent's promise and the backend's routing then
// come from the same rules, so the caller is never promised something the
// system won't do.

import { callbackDue, describeDue, frontDeskDue } from "./hours";
import { scoreLead, type Criterion, type LeadFacts, type ScoreResult } from "./policy";
import { parseFacts } from "./schemas";
import type { LeadScore } from "./types";

export type PromisedOutcome = "designer_callback" | "front_desk_callback" | "declined" | "escalated" | "none";

export interface FitAnswer {
  score: LeadScore;
  /** One direct question to ask before closing (rubric: unclear on 1–3), or null. */
  ask_next: string | null;
  /** What to say to close, in English; the agent says it in the caller's language. */
  say: string;
  outcome: PromisedOutcome;
  checks: ScoreResult["checks"];
}

/** Fills gaps with "unknown"/null; drops anything that isn't a LeadFacts key (zod). */
export function toFacts(partial: unknown): LeadFacts {
  return parseFacts(partial);
}

const OUT_OF_SCOPE = ["restaurant", "hotel", "retail", "gym"];

// Wording mirrors agent/system-prompt.md §4 (taken from the front desk's own
// calls in September). Never contains a figure.
const DECLINE = {
  area: "Thank you for thinking of us. We only work in Pune and PCMC — our execution depends on our own contractors being on site, so we can't do justice to a project there.",
  advice: "We're a full-service studio — our projects are design and execution together, so we don't do advice-only visits. If you decide to go ahead with a full redesign, we'd love to hear from you.",
  timeline: "I want to be honest with you — even one room takes us at least 8 to 10 weeks from start to finish, and we wouldn't want to rush your home. If the date can move, we'd be glad to help.",
  budget: "Thank you for sharing that. For that scope with full execution — materials, furniture and the work on site — that would be significantly below what a project like this costs with us. I'd rather be upfront now than have you come to a consultation and be disappointed.",
  scope: "Those spaces need a specialist — they have very different material and compliance needs. We focus on homes and offices, so we're not the right fit for this one.",
  small: "Our team is set up for a certain scale, and a space that size isn't one we could do well at the quality we'd want to promise.",
  decision: "It sounds like the decision sits with someone else — please do have them call us whenever they're ready; we'd be glad to help.",
  multiple: "This sounds like it may not be the right fit for us right now — but please do reach out if your timeline or scope changes.",
} as const;

function declineLine(f: LeadFacts, r: ScoreResult): string {
  const failed = (Object.entries(r.checks) as [Criterion, string][]).filter(([, v]) => v === "fail").map(([k]) => k);
  if (failed.length >= 2) return DECLINE.multiple;
  switch (failed[0]) {
    case "service_area": return DECLINE.area;
    case "timeline": return DECLINE.timeline;
    case "budget": return DECLINE.budget;
    case "decision_maker": return DECLINE.decision;
    case "real_project":
      if (OUT_OF_SCOPE.includes(f.project_kind)) return DECLINE.scope;
      if (f.intent === "design_and_execution") return DECLINE.small; // only size can fail it then
      return DECLINE.advice;
    default: return DECLINE.multiple;
  }
}

function nextQuestion(f: LeadFacts, r: ScoreResult): string | null {
  if (r.checks.real_project === "unknown") {
    if (f.project_kind === "other") return "Could you tell me a little more about the space — what is it used for?";
    if (f.intent === "design_and_execution") return null; // over the size cap: a human decides
    return "Are you looking for us to design and also execute it — materials, furniture and the work on site?";
  }
  if (r.checks.service_area === "unknown") return "Which area is the site in — is that within Pune city or PCMC?";
  if (r.checks.timeline === "unknown") {
    if (f.site_available_in_weeks !== null && f.site_available_in_weeks > 10) {
      return "When would the site be ready for work to start?";
    }
    return "When would you need the project complete — is that date firm?";
  }
  return null;
}

export function checkFit(partial: unknown, now: Date): FitAnswer {
  const f = toFacts(partial);
  const r = scoreLead(f, now);

  if (r.score === "qualified") {
    return {
      score: r.score,
      ask_next: null,
      say: `Thank you. One of our designers will call you ${describeDue(now, callbackDue(now))} to fix a time for the consultation — it's free and there's no obligation.`,
      outcome: "designer_callback",
      checks: r.checks,
    };
  }
  if (r.score === "not_fit") {
    return { score: r.score, ask_next: null, say: declineLine(f, r), outcome: "declined", checks: r.checks };
  }
  return {
    score: r.score,
    ask_next: nextQuestion(f, r),
    say: `Thank you. Someone from our team will call you ${describeDue(now, frontDeskDue(now))} to take this forward.`,
    outcome: "front_desk_callback",
    checks: r.checks,
  };
}
