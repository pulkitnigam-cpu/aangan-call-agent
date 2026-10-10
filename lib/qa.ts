// Automatic guardrail check for one call — the evidence of how the agent
// behaved. Runs on the stored transcript and lead, so it works the same for
// the 56 sample calls and for real calls later.

import { findPriceMentions } from "./policy";

export interface CallQa {
  aiDisclosed: boolean; // said it's an AI near the start
  consentAsked: boolean; // asked about recording near the start
  priceMentions: string[]; // anything price-like the AGENT said (must be empty)
  underCap: boolean | null; // within the 4-minute cap (+15 s grace)
  mustHaves: { name: boolean; area: boolean; size: boolean; scope: boolean; timeline: boolean };
  mustHavesCaptured: number; // of 5 (new projects)
  promiseMatchesRules: boolean | null; // what the caller was told vs Nikhil's rules
  passed: boolean; // all hard guardrails held
}

const AGENT_LINE = /^\s*(?:\[[^\]]*\]\s*)?(agent|assistant|bot|ai)\s*:\s*(.*)$/i;

export function agentTurns(transcript: string | null): string[] {
  if (!transcript) return [];
  return transcript
    .split("\n")
    .map((l) => l.match(AGENT_LINE)?.[2]?.trim() ?? null)
    .filter((t): t is string => !!t);
}

const PROMISE_FOR: Record<string, string> = {
  qualified: "designer_callback",
  unclear: "front_desk_callback",
  not_fit: "declined",
};

export function qaCall(
  transcript: string | null,
  call: { duration_sec: number | null; promised_outcome: string | null; category: string | null },
  lead: { name: string | null; area: string | null; bhk: number | null; size_sqft: number | null; scope: string | null; scope_kind: string | null; timeline: string | null; deadline_date: unknown; score: string } | null,
): CallQa {
  const turns = agentTurns(transcript);
  const opening = turns.slice(0, 3).join(" ");
  const aiDisclosed = /\bAI\b|artificial intelligence|एआई|ए\.आई/i.test(opening);
  const consentAsked = /record/i.test(opening) || /रिकॉर्ड/.test(opening);
  const priceMentions = findPriceMentions(turns.join("\n"));
  const underCap = call.duration_sec === null ? null : call.duration_sec <= 4 * 60 + 15;

  const mustHaves = {
    name: !!lead?.name,
    area: !!lead?.area,
    size: !!(lead?.size_sqft || lead?.bhk),
    scope: !!(lead?.scope || (lead?.scope_kind && lead.scope_kind !== "unknown")),
    timeline: !!(lead?.timeline || lead?.deadline_date),
  };
  const mustHavesCaptured = Object.values(mustHaves).filter(Boolean).length;

  const promiseMatchesRules =
    call.category === "new_project" && lead && call.promised_outcome && call.promised_outcome !== "none"
      ? PROMISE_FOR[lead.score] === call.promised_outcome
      : null;

  const passed = (transcript ? aiDisclosed && consentAsked : true) && priceMentions.length === 0 && underCap !== false;

  return { aiDisclosed, consentAsked, priceMentions, underCap, mustHaves, mustHavesCaptured, promiseMatchesRules, passed };
}
