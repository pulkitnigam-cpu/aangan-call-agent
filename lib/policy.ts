// Nikhil's qualification rubric (knowledge/qualified.md) and the studio's
// service rules (knowledge/services.md) as code.
//
// The voice agent applies these rules in conversation. The backend re-applies
// them here, deterministically, on the extracted fields after every call, so a
// lead is never forwarded on the LLM's judgment alone.

import type { LeadScore } from "./types";

// ---------------------------------------------------------------------------
// Facts the agent collects (see agent/extraction-schema.json)
// ---------------------------------------------------------------------------

export type Intent =
  | "design_and_execution" // what we do
  | "advice_only" // "just ideas", "come and advise"
  | "self_execution" // "I'll do the execution myself"
  | "furniture_only" // standalone sourcing
  | "vastu_only" // standalone Vastu advisory
  | "structural_only" // architecture / moving walls / permits
  | "exploring" // "just exploring", "early stage"
  | "unknown";

export type ProjectKind =
  | "home"
  | "office"
  | "clinic"
  | "studio"
  | "restaurant"
  | "hotel"
  | "retail"
  | "gym"
  | "other"
  | "unknown";

export type ScopeKind = "full_home" | "partial_home" | "single_room" | "commercial_fitout" | "unknown";

export type DecisionMaker =
  | "self" // owner / founder / the decider
  | "authorised" // spouse/partner/company has authorised them
  | "research_only" // "just checking for my parents" — owners still to engage
  | "not_authorised" // explicitly cannot move forward
  | "unknown";

export interface LeadFacts {
  intent: Intent;
  project_kind: ProjectKind;
  scope_kind: ScopeKind;
  room_count: number | null; // rooms in scope incl. kitchen, when not full home
  bhk: number | null; // 1BHK = 1, 2BHK = 2, ... (homes only)
  area: string | null; // locality, in Latin script
  size_sqft: number | null; // carpet area
  budget_max_inr: number | null; // only if the caller volunteered it
  deadline_date: string | null; // YYYY-MM-DD the project must be complete by
  site_available_in_weeks: number | null; // 0 = available now
  decision_maker: DecisionMaker;
}

// ---------------------------------------------------------------------------
// Service area (services.md)
// ---------------------------------------------------------------------------

/** Localities named in services.md. */
export const SERVICE_AREAS = [
  // Pune city
  "kothrud", "baner", "aundh", "wakad", "koregaon park", "kalyani nagar", "viman nagar",
  "hadapsar", "magarpatta", "nibm", "kondhwa", "undri", "shivane", "warje", "erandwane", "deccan",
  // PCMC
  "pimpri", "chinchwad", "pimple saudagar", "pimple nilakh", "ravet", "hinjewadi",
] as const;

/**
 * "Adjoining areas" that services.md covers but doesn't name. ASSUMED — confirm
 * this list with Nikhil before launch.
 */
export const ADJOINING_AREAS = [
  "kharadi", "balewadi", "pashan", "bavdhan", "karve nagar", "sus", "mahalunge", "sunderban",
  "shivajinagar", "model colony", "prabhat road", "camp", "wanowrie", "mundhwa", "keshav nagar",
  "yerawada", "kalyani", "sinhagad road", "dhayari", "nanded city", "katraj", "bibwewadi",
  "sahakar nagar", "dahanukar", "kasba", "salisbury park", "akurdi", "nigdi", "bhosari", "moshi",
  "tathawade", "punawale", "sangvi", "pimple gurav", "pimple", "thergaon", "rahatani",
] as const;

/** Named as out of area in services.md / qualified.md. */
export const OUT_OF_AREA = [
  "talegaon", "lonavala", "nashik", "mumbai", "thane", "navi mumbai", "satara", "nagpur",
  "aurangabad", "kolhapur", "bangalore", "bengaluru", "hyderabad", "goa",
] as const;

function normalise(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function mentions(haystack: string, term: string): boolean {
  return haystack.includes(` ${term} `);
}

/** True if the area mentions any of the given localities (designer routing). */
export function areaMatches(area: string, localities: string[]): boolean {
  const a = normalise(area);
  return localities.some((l) => mentions(a, normalise(l).trim()));
}

export type Check = "pass" | "fail" | "unknown";

const GENERIC_CITY = /\b(pune|pcmc|pimpri chinchwad)\b/;

export function checkServiceArea(area: string | null): Check {
  if (!area) return "unknown";
  const a = normalise(area);
  // Non-Latin script or no letters at all: can't judge, so ask.
  if (a.trim() === "") return "unknown";

  const inArea = [...SERVICE_AREAS, ...ADJOINING_AREAS].some((t) => mentions(a, t));
  const outArea = OUT_OF_AREA.some((t) => mentions(a, t));
  // "Baner, moving from Mumbai": conflicting, so ask rather than decline.
  if (inArea && outArea) return "unknown";
  // "Talegaon Dabhade, near Pune" fails on Talegaon; "Pune" is not a locality.
  if (outArea) return "fail";
  if (inArea) return "pass";
  // Just "Pune" / "PCMC" with no locality: in the city, good enough.
  const rest = a.replace(/\b(pune|pcmc|pimpri chinchwad|city|maharashtra|near|in|the)\b/g, " ").trim();
  return GENERIC_CITY.test(a) && rest === "" ? "pass" : "unknown";
}

// ---------------------------------------------------------------------------
// Scope (services.md)
// ---------------------------------------------------------------------------

const OUT_OF_SCOPE_KINDS: ProjectKind[] = ["restaurant", "hotel", "retail", "gym"];
const COMMERCIAL_KINDS: ProjectKind[] = ["office", "clinic", "studio"];
const COMMERCIAL_MIN_SQFT = 500; // studio practice (Sep transcripts, T18)
const COMMERCIAL_MAX_SQFT = 3000; // services.md: "up to approximately 3,000 sq ft"

// ---------------------------------------------------------------------------
// Budget floor — INTERNAL ONLY. Lowest tiers from pricing.md. Never sent to the
// voice agent and never spoken; used only to catch a volunteered budget that is
// clearly below any project of the described scope (qualified.md criterion 4).
// ---------------------------------------------------------------------------

// tests/pricing-drift.test.ts fails if these stop matching knowledge/pricing.md,
// so a pricing update can't silently leave the budget check behind.
export const PRICE_FLOORS = {
  residentialPerSqft: 1800, // "Standard specification" low end
  commercialPerSqft: 1200, // "Basic fitout" low end
  singleRoom: 350_000, // "Single room redesign (all-in)" low end
} as const;
const RES_FLOOR_PER_SQFT = PRICE_FLOORS.residentialPerSqft;
const COMMERCIAL_FLOOR_PER_SQFT = PRICE_FLOORS.commercialPerSqft;
const SINGLE_ROOM_FLOOR = PRICE_FLOORS.singleRoom;
/** "Clearly below" = under half the lowest indicative cost for that scope. */
const CLEARLY_BELOW_RATIO = 0.5;

export function budgetFloorInr(f: LeadFacts): number | null {
  if (COMMERCIAL_KINDS.includes(f.project_kind)) {
    return f.size_sqft ? f.size_sqft * COMMERCIAL_FLOOR_PER_SQFT : null;
  }
  if (f.scope_kind === "single_room") return SINGLE_ROOM_FLOOR;
  if (f.scope_kind === "partial_home" && f.room_count) return f.room_count * SINGLE_ROOM_FLOOR;
  if (f.scope_kind === "full_home") {
    if (f.size_sqft) return f.size_sqft * RES_FLOOR_PER_SQFT;
    // No size, but BHK known: bedrooms + living + kitchen, priced as rooms.
    if (f.bhk) return (f.bhk + 2) * SINGLE_ROOM_FLOOR;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timeline (services.md + qualified.md criterion 3)
// ---------------------------------------------------------------------------

const MIN_WEEKS_TO_COMPLETE = 8; // one room, start to finish (T07)
const COMFORT_WEEKS = 10; // qualified.md: execution within 8–10 weeks of consultation
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weeksBetween(from: Date, toIsoDate: string): number {
  const to = new Date(`${toIsoDate}T23:59:59+05:30`);
  return (to.getTime() - from.getTime()) / WEEK_MS;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type Criterion = "real_project" | "service_area" | "timeline" | "budget" | "decision_maker";

export interface ScoreResult {
  score: LeadScore;
  checks: Record<Criterion, Check>;
  /** Why it failed or is unclear — goes on the front-desk card. */
  reasons: string[];
  /** Uncertainties to pass to the designer (criteria 4 and 5 never block). */
  notes: string[];
}

export function scoreLead(f: LeadFacts, callAt: Date): ScoreResult {
  const reasons: string[] = [];
  const notes: string[] = [];

  // 1. Real project — design + execution, in a space type we do.
  let realProject: Check;
  if (OUT_OF_SCOPE_KINDS.includes(f.project_kind)) {
    realProject = "fail";
    reasons.push(`${f.project_kind} interiors are outside our scope`);
  } else if (
    ["advice_only", "self_execution", "furniture_only", "vastu_only", "structural_only"].includes(f.intent)
  ) {
    realProject = "fail";
    reasons.push(`wants ${f.intent.replace(/_/g, " ")}, not design with execution`);
  } else if (COMMERCIAL_KINDS.includes(f.project_kind) && f.size_sqft !== null && f.size_sqft < COMMERCIAL_MIN_SQFT) {
    realProject = "fail";
    reasons.push(`commercial space of ${f.size_sqft} sq ft is below our ~${COMMERCIAL_MIN_SQFT} sq ft minimum`);
  } else if (f.intent === "design_and_execution") {
    realProject = "pass";
    if (COMMERCIAL_KINDS.includes(f.project_kind) && f.size_sqft !== null && f.size_sqft > COMMERCIAL_MAX_SQFT) {
      realProject = "unknown";
      reasons.push(`commercial space of ${f.size_sqft} sq ft is above our ~${COMMERCIAL_MAX_SQFT} sq ft cap — confirm`);
    } else if (f.project_kind === "other") {
      // services.md covers homes, offices, clinics, studios. Anything else
      // (school, warehouse, temple…) is a judgement call for a human.
      realProject = "unknown";
      reasons.push("space type isn't one services.md covers — confirm");
    }
  } else {
    realProject = "unknown";
    reasons.push(f.intent === "exploring" ? "caller is still exploring — no project yet" : "scope not confirmed (design + execution?)");
  }

  // 2. Service area.
  const serviceArea = checkServiceArea(f.area);
  if (serviceArea === "fail") reasons.push(`${f.area} is outside Pune / PCMC`);
  if (serviceArea === "unknown") reasons.push(f.area ? `not sure if ${f.area} is in our area` : "location not given");

  // 3. Realistic timeline.
  let timeline: Check = "pass";
  if (f.deadline_date) {
    const weeks = weeksBetween(callAt, f.deadline_date);
    if (weeks < -1) {
      // A deadline in the past is an extraction mistake ("by March" resolved
      // to last March), not a reason to decline. Let a human check.
      timeline = "unknown";
      reasons.push(`deadline ${f.deadline_date} is in the past — confirm the date`);
    } else if (weeks < MIN_WEEKS_TO_COMPLETE) {
      timeline = "fail";
      reasons.push(`needs completion in ~${Math.max(0, Math.round(weeks))} weeks; we need at least ${MIN_WEEKS_TO_COMPLETE}`);
    } else if (weeks < COMFORT_WEEKS) {
      timeline = "unknown";
      reasons.push(`tight deadline (~${Math.round(weeks)} weeks) — confirm it's workable`);
    }
  }
  if (timeline === "pass" && f.site_available_in_weeks !== null && f.site_available_in_weeks > COMFORT_WEEKS) {
    timeline = "unknown";
    reasons.push(`site not available for ~${f.site_available_in_weeks} weeks`);
  }

  // 4. Budget — only judged when volunteered; never blocks when unclear.
  let budget: Check = "pass";
  const floor = budgetFloorInr(f);
  if (f.budget_max_inr !== null && floor !== null && f.budget_max_inr < floor * CLEARLY_BELOW_RATIO) {
    budget = "fail";
    reasons.push("volunteered budget is clearly below any project of this scope");
  } else if (f.budget_max_inr !== null && floor !== null && f.budget_max_inr < floor) {
    notes.push("volunteered budget may be tight for this scope");
  }

  // 5. Decision-maker — never blocks unless explicitly not authorised.
  let decisionMaker: Check = "pass";
  if (f.decision_maker === "not_authorised") {
    decisionMaker = "fail";
    reasons.push("caller is not able to move the project forward");
  } else if (f.decision_maker === "research_only") {
    notes.push("caller is researching for the owners — confirm owners attend the consultation");
  } else if (f.decision_maker === "unknown") {
    notes.push("decision-maker not confirmed");
  }

  const checks = {
    real_project: realProject,
    service_area: serviceArea,
    timeline,
    budget,
    decision_maker: decisionMaker,
  };

  // qualified.md: fails any one → don't forward. Unclear on 1–3 → ask (and if
  // still unclear after the call, the front desk follows up). Unclear on 4–5 →
  // treat as qualified and note it.
  let score: LeadScore;
  if (Object.values(checks).includes("fail")) score = "not_fit";
  else if ([realProject, serviceArea, timeline].includes("unknown")) score = "unclear";
  else score = "qualified";

  return { score, checks, reasons: score === "qualified" ? [] : reasons, notes };
}

// ---------------------------------------------------------------------------
// Price guardrail (pricing.md: "What the agent must never say")
// ---------------------------------------------------------------------------

const PRICE_PATTERNS: RegExp[] = [
  /₹\s*[\d,.]+/,
  /\brs\.?\s*[\d,.]+/i,
  /\b(rupees?|rupaye|rupaiye)\b/i,
  /रुपय|रुपये|रुपए/,
  /\b(lakh|lakhs|lac|lacs|crore|crores)\b/i,
  /लाख|हज़ार|हजार|करोड़|करोड/,
  /\b\d[\d,.]*\s*(k|thousand|hundred)\b/i,
  /\b(thousand|hazaar|hazar|hajar)\b/i, // not "hundred": "hundred percent sure" is common
  /\b(sau|so)\s+(rupaye|rupees?|rs)\b|\b\w+\s+sau\b|सौ|शे\s*रुपय/i, // "paanch sau", "पाँच सौ", "पाचशे रुपये"
  /(\bper|\ba|\beach|\/)\s*(sq\.?\s*ft|sqft|square\s*f(?:oo|ee)t)\b/i,
  /\bpsf\b/i,
  /\b(rates?|prices?|pricing|charges?)\s+(start|starts|begin|begins)\b/i,
  /\b(cost|costs|come to|comes to)\s+(around|about|roughly|approximately|approx)\b/i,
  /\bit'?ll\s+cost\b/i,
  /\b(typically|usually|generally)\s+(costs?|comes?\s+to|runs?|is\s+around)\b/i,
];

/**
 * Returns the price-like phrases found in the agent's own words. Run it on the
 * agent's turns only — callers are free to mention money. Deliberately strict:
 * repeating a caller's number back also counts.
 */
export function findPriceMentions(agentText: string): string[] {
  const hits: string[] = [];
  for (const re of PRICE_PATTERNS) {
    const m = agentText.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}
