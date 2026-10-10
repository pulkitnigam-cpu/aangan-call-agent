import { connection } from "next/server";
import { getSql } from "@/lib/db";
import { qaCall } from "@/lib/qa";
import { verifyCron } from "@/lib/security";

// GET /api/admin/report[?since=2026-10-10] — every AI-handled call with its
// transcript, what was extracted, how it was scored (rules vs Vaani's own vs the
// agent's promise), where the lead went, and the automatic guardrail check.
// Used by `npm run report` to write docs/sample-calls-report.md.
// Requires "Authorization: Bearer <CRON_SECRET>".

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export async function GET(request: Request) {
  await connection();
  if (!verifyCron(request.headers)) return Response.json({ error: "unauthorised" }, { status: 401 });
  const sinceParam = new URL(request.url).searchParams.get("since");
  const since = sinceParam && !Number.isNaN(Date.parse(sinceParam)) ? new Date(sinceParam) : new Date(0);

  const rows = await getSql()`
    select c.id, c.vani_call_id, c.started_at, c.duration_sec, c.status, c.category, c.language, c.recording_consent,
           c.promised_outcome, c.price_mentions, c.cost_inr::text as cost_inr, c.transcript, c.raw_payload, c.escalate, c.escalation_reason,
           l.id as lead_id, l.name, l.area, l.bhk, l.size_sqft, l.scope, l.scope_kind, l.intent, l.project_kind, l.timeline,
           l.deadline_date, l.budget, l.decision_maker, l.source, l.score, l.agent_score, l.score_reasons, l.handoff_notes,
           l.status as lead_status, l.owner, l.needs_review, l.review_reason, l.open_questions, d.name as designer
    from calls c
    left join leads l on l.id = c.lead_id
    left join designers d on d.id = l.designer_id
    where c.handled_by = 'ai' and c.started_at >= ${since}
    order by c.started_at
  `;

  const calls = rows.map((r) => {
    const data = obj(obj(r.raw_payload).data);
    const vaani = { ...obj(data.entities), ...obj(data.dispositions) };
    const lead = r.lead_id
      ? { name: r.name, area: r.area, bhk: r.bhk, size_sqft: r.size_sqft, scope: r.scope, scope_kind: r.scope_kind, timeline: r.timeline, deadline_date: r.deadline_date, score: r.score }
      : null;
    return {
      callId: r.vani_call_id,
      startedAt: r.started_at,
      durationSec: r.duration_sec,
      status: r.status,
      category: r.category,
      language: r.language,
      recordingConsent: r.recording_consent,
      promisedOutcome: r.promised_outcome,
      costInr: Number(r.cost_inr),
      escalate: r.escalate,
      lead: lead && {
        ...lead,
        deadline_date: r.deadline_date ? new Date(r.deadline_date).toISOString().slice(0, 10) : null,
        intent: r.intent, project_kind: r.project_kind, budget: r.budget, decision_maker: r.decision_maker, source: r.source,
        rulesScore: r.score, agentScore: r.agent_score, vaaniScore: (vaani.lead_score as string) ?? null,
        vaaniReason: (vaani.qualification_reason as string) ?? null,
        reasons: r.score_reasons, notes: r.handoff_notes, openQuestions: r.open_questions,
        routedTo: r.designer ? `designer: ${r.designer}` : r.owner === "front_desk" ? (r.lead_status === "not_fit" ? "closed (not a fit)" : "front desk") : "—",
        needsReview: r.needs_review, reviewReason: r.review_reason,
      },
      qa: qaCall(r.transcript, { duration_sec: r.duration_sec, promised_outcome: r.promised_outcome, category: r.category }, lead),
      transcript: r.transcript,
    };
  });

  const newProjects = calls.filter((c) => c.category === "new_project" && c.lead);
  const count = (f: (c: (typeof calls)[number]) => boolean) => calls.filter(f).length;
  const summary = {
    calls: calls.length,
    completed: count((c) => c.status === "completed"),
    dropped: count((c) => c.status !== "completed"),
    byCategory: Object.fromEntries(["new_project", "existing_client", "vendor", "spam"].map((k) => [k, count((c) => c.category === k)])),
    byScore: Object.fromEntries(["qualified", "unclear", "not_fit"].map((k) => [k, newProjects.filter((c) => c.lead!.rulesScore === k).length])),
    guardrailsPassed: count((c) => c.qa.passed),
    aiDisclosed: count((c) => c.qa.aiDisclosed),
    consentAsked: count((c) => c.qa.consentAsked),
    priceLeaks: count((c) => c.qa.priceMentions.length > 0),
    overCap: count((c) => c.qa.underCap === false),
    promiseMatchesRules: `${newProjects.filter((c) => c.qa.promiseMatchesRules === true).length}/${newProjects.filter((c) => c.qa.promiseMatchesRules !== null).length}`,
    rulesVsVaani: `${newProjects.filter((c) => c.lead!.vaaniScore && c.lead!.vaaniScore === c.lead!.rulesScore).length}/${newProjects.filter((c) => c.lead!.vaaniScore).length}`,
    avgMustHaves: newProjects.length ? Math.round((newProjects.reduce((a, c) => a + c.qa.mustHavesCaptured, 0) / newProjects.length) * 10) / 10 : null,
    avgDurationSec: calls.length ? Math.round(calls.reduce((a, c) => a + (c.durationSec ?? 0), 0) / calls.length) : null,
    totalCostInr: Math.round(calls.reduce((a, c) => a + c.costInr, 0) * 100) / 100,
  };
  return Response.json({ generatedAt: new Date().toISOString(), since: since.toISOString(), summary, calls });
}
