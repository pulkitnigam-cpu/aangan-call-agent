// What happens to a call after it ends, and to a lead after that.
//
// Principles (from the 7 Oct workflow review):
//  1. Keep every promise. Routing follows what the CALLER WAS TOLD; if the
//     rules disagree, a human reviews it. Nothing is silently dropped.
//  2. One person owns each lead at a time: a designer, or the front desk.
//  3. Nobody is woken at night: out-of-hours cards are silent and deadlines
//     roll to the next morning (lib/hours.ts).
//  4. Every webhook is safe to receive twice.

import type postgres from "postgres";
import { buildCallerContext } from "./caller-context";
import { computeCallCostInr } from "./cost";
import { checkFit, type FitAnswer, type PromisedOutcome } from "./fit";
import type { ExtractedLead } from "./gemini";
import { callbackDue, describeDue, escalationDue, frontDeskDue, isBusinessHours } from "./hours";
import { upsertContactAndDeal, updateDealStage } from "./hubspot";
import { normalizePhone } from "./phone";
import { findPriceMentions, scoreLead, type LeadFacts, type ScoreResult } from "./policy";
import { answerQuestion, identifyAsker, type Classifier } from "./bot";
import { pickDesigner } from "./routing";
import type { TelegramUpdate } from "./schemas";
import {
  acceptedKeyboard, answerCallback, editMessage, esc, fmtPhone, fmtTime, frontDeskChat, frontDeskKeyboard,
  leadCardText, NOT_FIT_REASONS, notFitReasonKeyboard, sendDocument, sendFrontDesk, sendLeadCard, sendMessage, sendNikhil, transcriptFile,
} from "./telegram";
import type { Designer, Lead, LeadScore, LeadStatus } from "./types";
import type { CallEndedEvent, CallStartedEvent } from "./voice/types";

type Sql = postgres.Sql;
const MIN = 60_000;
const DEDUPE_WINDOW_DAYS = 30;
const MAX_REASSIGNS = 2;
const DROPPED_GRACE_MIN = 15; // T17: callers often ring straight back after a drop
const STALE_CALL_MIN = 30; // in_progress with no post-call → Vani failed mid-call

async function logEvent(sql: Sql, leadId: string, type: string, actor: string, data?: unknown) {
  await sql`
    insert into lead_events (lead_id, type, actor, data)
    values (${leadId}, ${type}, ${actor}, ${data === undefined ? null : sql.json(data as postgres.JSONValue)})
  `;
}

/**
 * Sends the lead's latest call transcript as a .txt file, threaded under the
 * card it belongs to. If the caller declined recording, says so instead.
 */
async function sendTranscript(sql: Sql, chatId: string | null | undefined, lead: Lead, replyTo: number | null) {
  // Always silent: the card itself is the alert; the file follows quietly.
  if (!chatId) return;
  const [call] = await sql<{ started_at: Date; duration_sec: number | null; transcript: string | null; recording_consent: boolean | null }[]>`
    select started_at, duration_sec, transcript, recording_consent from calls
    where lead_id = ${lead.id} or id = ${lead.call_id}
    order by started_at desc limit 1
  `;
  if (!call) return;
  if (!call.transcript) {
    // Only worth saying when the caller declined; front-desk /log calls simply have none.
    if (call.recording_consent === false) {
      await sendMessage(chatId, "🔇 The caller declined recording, so there's no transcript — the details above are all we kept.", { silent: true });
    }
    return;
  }
  const f = transcriptFile(lead, { started_at: call.started_at, duration_sec: call.duration_sec, transcript: call.transcript });
  await sendDocument(chatId, f.filename, f.content, { caption: "📝 Full call transcript", replyTo, silent: true });
}

// ---------------------------------------------------------------------------
// Call start: context and promises for the agent
// ---------------------------------------------------------------------------

export interface CallVariables {
  caller_context: string;
  is_business_hours: "yes" | "no";
  callback_promise: string;
  front_desk_promise: string;
  escalation_promise: string;
}

export async function handleCallStarted(sql: Sql, input: CallStartedEvent, now: Date): Promise<CallVariables> {
  const phone = normalizePhone(input.callerPhone);
  // Recorded now so a call that never gets a post-call (Vani failure) is still followed up.
  await sql`
    insert into calls (vani_call_id, caller_phone, started_at, status)
    values (${input.providerCallId}, ${phone ?? (input.callerPhone || "unknown")}, ${now}, 'in_progress')
    on conflict (vani_call_id) do nothing
  `;
  return {
    caller_context: await buildCallerContext(sql, phone, now),
    is_business_hours: isBusinessHours(now) ? "yes" : "no",
    callback_promise: describeDue(now, callbackDue(now)),
    front_desk_promise: describeDue(now, frontDeskDue(now)),
    escalation_promise: describeDue(now, escalationDue(now)),
  };
}

/** Vaani's call_ended: record when and how it ended. call_postprocessing follows with the details. */
export async function handleCallFinished(sql: Sql, providerCallId: string, durationSec: number, now: Date): Promise<void> {
  await sql`
    update calls set ended_at = coalesce(ended_at, ${now}), duration_sec = greatest(coalesce(duration_sec, 0), ${durationSec})
    where vani_call_id = ${providerCallId} and processed_at is null
  `;
}

/** The agent's callback_times tool: the only callback times it may promise right now. */
export function callbackTimes(now: Date): Omit<CallVariables, "caller_context"> {
  return {
    is_business_hours: isBusinessHours(now) ? "yes" : "no",
    callback_promise: describeDue(now, callbackDue(now)),
    front_desk_promise: describeDue(now, frontDeskDue(now)),
    escalation_promise: describeDue(now, escalationDue(now)),
  };
}

// ---------------------------------------------------------------------------
// During the call: the agent's check_fit tool
// ---------------------------------------------------------------------------

export async function handleCheckFit(
  sql: Sql,
  providerCallId: string | null,
  args: Record<string, unknown>,
  now: Date,
): Promise<FitAnswer> {
  const answer = checkFit(args, now);
  if (providerCallId) {
    await sql`
      insert into calls (vani_call_id, caller_phone, started_at, status, live_check)
      values (${providerCallId}, 'unknown', ${now}, 'in_progress', ${sql.json(answer as unknown as postgres.JSONValue)})
      on conflict (vani_call_id) do update set live_check = excluded.live_check
    `;
  }
  return answer;
}

// ---------------------------------------------------------------------------
// After the call
// ---------------------------------------------------------------------------

/** Where a new-project lead goes, given what the caller was told and what the rules say. */
export function decideRoute(
  promised: PromisedOutcome,
  rules: ScoreResult,
): { route: "designer" | "front_desk" | "none"; review: string | null } {
  const why = rules.reasons.length ? ` (${rules.reasons.join("; ")})` : "";
  switch (promised) {
    case "designer_callback":
      return {
        route: "designer",
        review: rules.score === "qualified" ? null : `Caller was promised a designer callback, but the rules say ${rules.score}${why}. Keep the promise; judge fit on the call.`,
      };
    case "front_desk_callback":
    case "escalated":
      return {
        route: "front_desk",
        review: rules.score === "qualified" ? "The rules say this lead qualifies — consider passing it to a designer." : null,
      };
    case "declined":
      return rules.score === "not_fit"
        ? { route: "none", review: null }
        : { route: "front_desk", review: `The agent declined this caller, but the rules say ${rules.score}${why}. Call back and check.` };
    case "none":
      return { route: rules.score === "qualified" ? "designer" : rules.score === "unclear" ? "front_desk" : "none", review: null };
  }
}

function facts(e: ExtractedLead): LeadFacts {
  const { intent, project_kind, scope_kind, room_count, bhk, area, size_sqft, budget_max_inr, deadline_date, site_available_in_weeks, decision_maker } = e;
  return { intent, project_kind, scope_kind, room_count, bhk, area, size_sqft, budget_max_inr, deadline_date, site_available_in_weeks, decision_maker };
}

function leadFields(e: ExtractedLead, rules: ScoreResult) {
  return {
    name: e.name,
    area: e.area,
    property_type: e.project_kind === "home" ? "home" : ["office", "clinic", "studio"].includes(e.project_kind) ? "office" : null,
    size_sqft: e.size_sqft,
    bhk: e.bhk,
    scope: e.scope,
    budget: e.budget_text,
    timeline: e.timeline,
    source: e.source,
    summary: e.summary || null,
    intent: e.intent,
    project_kind: e.project_kind,
    scope_kind: e.scope_kind,
    room_count: e.room_count,
    current_state: e.current_state,
    site_available_in_weeks: e.site_available_in_weeks,
    deadline_date: e.deadline_date,
    budget_max_inr: e.budget_max_inr,
    decision_maker: e.decision_maker,
    rented: e.rented,
    consultation_preference: e.consultation_preference,
    priority: e.priority,
    open_questions: e.open_questions,
    score: rules.score,
    agent_score: e.score,
    score_reasons: rules.reasons,
    handoff_notes: rules.notes,
  };
}

export interface PostCallDeps {
  extract?: (transcript: string, callDate: Date) => Promise<{ extraction: ExtractedLead; inputTokens: number; outputTokens: number }>;
}

export type PostCallResult =
  | { kind: "duplicate" }
  | { kind: "dropped" | "failed" }
  | { kind: "existing_client" | "vendor" | "spam"; escalated?: boolean }
  | { kind: "lead"; leadId: string; route: "designer" | "front_desk" | "none"; merged: boolean; review: string | null };

export async function handleCallEnded(sql: Sql, input: CallEndedEvent, deps: PostCallDeps, now: Date): Promise<PostCallResult> {
  // Claim the call exactly once, even if Vani retries the webhook.
  await sql`
    insert into calls (vani_call_id, caller_phone, started_at, status)
    values (${input.providerCallId}, ${normalizePhone(input.callerPhone) ?? (input.callerPhone || "unknown")}, ${input.startedAt}, 'in_progress')
    on conflict (vani_call_id) do nothing
  `;
  const [call] = await sql<{ id: string; live_check: FitAnswer | null; caller_phone: string }[]>`
    update calls set processed_at = ${now}
    where vani_call_id = ${input.providerCallId} and processed_at is null
    returning id, live_check, caller_phone
  `;
  if (!call) return { kind: "duplicate" };

  const callerSpoke = input.turns.some((t) => t.role === "caller");
  if (input.status !== "completed" || (!input.extraction && (!callerSpoke || (input.durationSec > 0 && input.durationSec < 20)))) {
    const status = input.status === "failed" ? "failed" : "dropped";
    await sql`
      update calls set status = ${status}, ended_at = ${input.endedAt}, duration_sec = greatest(coalesce(duration_sec, 0), ${input.durationSec}),
        caller_phone = coalesce(${normalizePhone(input.callerPhone)}, caller_phone)
      where id = ${call.id}
    `;
    return { kind: status }; // the sweep follows up unless they ring back
  }

  const agentText = input.turns.filter((t) => t.role === "agent").map((t) => t.text).join("\n");
  const transcript = input.turns.map((t) => `${t.role === "agent" ? "Agent" : "Caller"}: ${t.text}`).join("\n");

  let extraction = input.extraction;
  let inputTokens = input.llmInputTokens;
  let outputTokens = input.llmOutputTokens;
  let extractionError: string | null = null;
  if (!extraction && deps.extract) {
    try {
      const r = await deps.extract(transcript, input.startedAt);
      extraction = r.extraction;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
    } catch (err) {
      extractionError = err instanceof Error ? err.message : String(err);
      console.error(`[post-call ${input.providerCallId}] extraction failed`, err);
    }
  }

  // Vaani's post-processing event has no caller number; call_started stored it.
  const phone = normalizePhone(extraction?.callback_phone) ?? normalizePhone(input.callerPhone) ?? normalizePhone(call.caller_phone);
  const consent = extraction?.recording_consent ?? input.recordingConsent;
  const priceHits = findPriceMentions(agentText);
  const cost = computeCallCostInr({ durationSec: input.durationSec, inputTokens, outputTokens });
  const e = extraction;

  // Declined recording: keep only the structured fields, never the words.
  await sql`
    update calls set
      status = 'completed', ended_at = ${input.endedAt}, duration_sec = greatest(coalesce(duration_sec, 0), ${input.durationSec}),
      caller_phone = ${phone ?? (input.callerPhone || "unknown")},
      recording_consent = ${consent},
      transcript = ${consent === false ? null : transcript},
      raw_payload = ${sql.json((consent === false ? { redacted: "recording consent declined" } : input.raw) as postgres.JSONValue)},
      category = ${e?.category ?? null}, language = ${e?.language ?? null},
      escalate = ${e?.escalate ?? false}, escalation_reason = ${e?.escalation_reason ?? null},
      promised_outcome = ${e?.promised_outcome ?? call.live_check?.outcome ?? null},
      gemini_tokens = ${inputTokens + outputTokens}, llm_input_tokens = ${inputTokens}, llm_output_tokens = ${outputTokens},
      cost_inr = ${cost}, price_mentions = ${priceHits}
    where id = ${call.id}
  `;

  if (priceHits.length) {
    await sendNikhil(
      `⚠️ <b>Price guardrail</b>: the agent said <i>${esc(priceHits.join(", "))}</i> on a call with ${esc(fmtPhone(phone ?? input.callerPhone))} (${fmtTime(input.startedAt)}). Please review the call.`,
    );
  }

  const silent = !isBusinessHours(now);

  if (!e) {
    // We heard a real conversation but couldn't read it: a human takes it.
    const due = frontDeskDue(input.startedAt);
    const [lead] = await sql<Lead[]>`
      insert into leads (call_id, phone, score, status, owner, due_at, needs_review, review_reason, summary, last_call_at, created_at)
      values (${call.id}, ${phone ?? "unknown"}, 'unclear', 'new', 'front_desk', ${due}, true,
              ${`Couldn't read this call automatically (${extractionError ?? "no extraction"}). Check the recording and call back.`},
              ${null}, ${input.startedAt}, ${input.startedAt})
      returning *
    `;
    await sql`update calls set lead_id = ${lead.id} where id = ${call.id}`;
    await logEvent(sql, lead.id, "created", "system", { review: lead.review_reason });
    const fdMsg = await sendFrontDesk(leadCardText(lead, "🟡 <b>Call needs a human look</b>"), frontDeskKeyboard(lead.id), silent);
    await sendTranscript(sql, frontDeskChat(), lead, fdMsg);
    return { kind: "lead", leadId: lead.id, route: "front_desk", merged: false, review: lead.review_reason };
  }

  if (e.category === "vendor" || e.category === "spam") return { kind: e.category };

  if (e.category === "existing_client") {
    const due = e.escalate ? escalationDue(input.startedAt) : frontDeskDue(input.startedAt);
    const text = [
      e.escalate ? "🔴 <b>Existing client — needs a senior person</b>" : "🔵 <b>Existing client</b>",
      "",
      `<b>${esc(e.name ?? "Name not given")}</b> · ${esc(fmtPhone(phone ?? input.callerPhone))}`,
      e.area ? `<b>Area:</b> ${esc(e.area)}` : null,
      e.escalation_reason ? `<b>Issue:</b> ${esc(e.escalation_reason)}` : null,
      e.summary ? esc(e.summary) : null,
      "",
      `<b>Promised callback:</b> ${fmtTime(due)}`,
    ].filter((l) => l !== null).join("\n");
    await sendFrontDesk(text, undefined, silent);
    if (e.escalate) await sendNikhil(text);
    return { kind: "existing_client", escalated: e.escalate };
  }

  // New project.
  const rules = scoreLead(facts(e), input.startedAt);
  const promised: PromisedOutcome = e.promised_outcome !== "none" ? e.promised_outcome : call.live_check?.outcome ?? "none";
  const fields = leadFields(e, rules);
  let effectiveRules = rules; // becomes the merged-facts score for a repeat caller

  // Same caller, open enquiry: merge into it rather than start a second lead.
  const since = new Date(now.getTime() - DEDUPE_WINDOW_DAYS * 24 * 60 * MIN);
  const [existing] = phone
    ? await sql<Lead[]>`
        select * from leads
        where phone = ${phone} and status not in ('won', 'lost', 'not_fit')
          and coalesce(last_call_at, created_at) > ${since}
        order by created_at desc limit 1
      `
    : [];

  let lead: Lead;
  if (existing) {
    // New answers win; anything not said this time keeps its earlier value.
    const merged = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)),
    );
    const mergedFacts = { ...pickFacts(existing), ...Object.fromEntries(Object.entries(facts(e)).filter(([, v]) => v !== null && v !== "unknown")) } as LeadFacts;
    const reRules = scoreLead(mergedFacts, input.startedAt);
    effectiveRules = reRules;
    [lead] = await sql<Lead[]>`
      update leads set ${sql({ ...merged, score: reRules.score, score_reasons: reRules.reasons, handoff_notes: reRules.notes, last_call_at: input.startedAt, priority: existing.priority || e.priority })}
      where id = ${existing.id} returning *
    `;
    await sql`update calls set lead_id = ${lead.id} where id = ${call.id}`;
    await logEvent(sql, lead.id, "merged", "system", { call_id: call.id, promised });

    const designerActive = lead.designer_id && ["assigned", "called", "visit_booked"].includes(lead.status);
    if (designerActive) {
      // Already with a designer: tell them, and pull the deadline in if we just promised sooner.
      if (promised === "designer_callback" && !lead.first_action_at) {
        const due = callbackDue(input.startedAt);
        if (!lead.due_at || due < lead.due_at) [lead] = await sql<Lead[]>`update leads set due_at = ${due} where id = ${lead.id} returning *`;
      }
      const [designer] = await sql<Designer[]>`select * from designers where id = ${lead.designer_id}`;
      if (designer?.telegram_chat_id) {
        const againMsg = await sendMessage(designer.telegram_chat_id, leadCardText(lead, `📞 <b>${esc(lead.name ?? "This caller")} called again</b>`), {
          keyboard: lead.accepted_at ? acceptedKeyboard(lead, designer) : undefined,
          silent,
        });
        await sendTranscript(sql, designer.telegram_chat_id, lead, againMsg);
      }
      return { kind: "lead", leadId: lead.id, route: "designer", merged: true, review: null };
    }
  } else {
    [lead] = await sql<Lead[]>`
      insert into leads ${sql({ ...fields, call_id: call.id, phone: phone ?? "unknown", status: "new", last_call_at: input.startedAt, created_at: input.startedAt })}
      returning *
    `;
    await sql`update calls set lead_id = ${lead.id} where id = ${call.id}`;
    await logEvent(sql, lead.id, "created", "agent", { promised, rules: rules.score });
  }

  const { route, review } = decideRoute(promised, effectiveRules);
  // No number (e.g. a browser test call, or a withheld ID the caller didn't fill in):
  // still route normally — just flag it, so the lead isn't lost to the front desk.
  await routeLead(sql, lead, route, review, input.startedAt, now);

  const [current] = await sql<Lead[]>`select * from leads where id = ${lead.id}`;
  try {
    // HubSpot gets the lead's total AI cost across all its calls, and the designer's name.
    const [{ total, designer }] = await sql<{ total: string; designer: string | null }[]>`
      select coalesce((select sum(cost_inr) from calls where lead_id = ${lead.id}), ${cost})::text as total,
             (select name from designers where id = ${current.designer_id ?? null}) as designer
    `;
    const ids = await upsertContactAndDeal(current, Number(total), designer);
    if (ids.contactId || ids.dealId) {
      await sql`update leads set hubspot_contact_id = ${ids.contactId}, hubspot_deal_id = ${ids.dealId} where id = ${lead.id}`;
    }
  } catch (err) {
    console.error(`[post-call ${input.providerCallId}] HubSpot sync failed`, err); // never blocks the lead
  }
  return { kind: "lead", leadId: lead.id, route, merged: !!existing, review };
}

/**
 * If post-call processing crashes after claiming the call, release the claim
 * so Vani's retry processes it again. A duplicate card beats a lost lead.
 */
export async function releaseCallClaim(sql: Sql, providerCallId: string): Promise<void> {
  await sql`update calls set processed_at = null where vani_call_id = ${providerCallId}`;
}

function pickFacts(l: Lead): Partial<LeadFacts> {
  const out: Record<string, unknown> = {
    intent: l.intent, project_kind: l.project_kind, scope_kind: l.scope_kind, room_count: l.room_count, bhk: l.bhk,
    area: l.area, size_sqft: l.size_sqft, budget_max_inr: l.budget_max_inr === null ? null : Number(l.budget_max_inr),
    deadline_date: l.deadline_date ? l.deadline_date.toISOString().slice(0, 10) : null,
    site_available_in_weeks: l.site_available_in_weeks, decision_maker: l.decision_maker,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== undefined)) as Partial<LeadFacts>;
}

/** Hands a lead to a designer or the front desk (or closes it) and notifies them. */
async function routeLead(
  sql: Sql,
  lead: Lead,
  route: "designer" | "front_desk" | "none",
  review: string | null,
  callAt: Date,
  now: Date,
): Promise<void> {
  if (review) {
    await sql`update leads set needs_review = true, review_reason = ${review} where id = ${lead.id}`;
    lead = { ...lead, needs_review: true, review_reason: review };
  }
  const silent = !isBusinessHours(now);

  if (route === "none") {
    await sql`update leads set status = 'not_fit', owner = 'front_desk' where id = ${lead.id}`;
    await logEvent(sql, lead.id, "closed", "system", { reasons: lead.score_reasons });
    return;
  }

  if (route === "designer") {
    const designer = await pickDesigner(sql, lead.area, lead.declined_by, now);
    if (designer) {
      const due = lead.due_at && lead.due_at < callbackDue(callAt) ? lead.due_at : callbackDue(callAt);
      const [updated] = await sql<Lead[]>`
        update leads set owner = 'designer', designer_id = ${designer.id}, status = 'assigned',
          assigned_at = ${now}, accepted_at = null, due_at = ${due}
        where id = ${lead.id} returning *
      `;
      const header = updated.needs_review ? "🟠 <b>New lead — please review</b>" : lead.priority ? "⭐ <b>New lead — priority</b>" : "🟢 <b>New lead</b>";
      const messageId = await sendLeadCard(updated, designer, header, silent);
      if (messageId) await sql`update leads set designer_message_id = ${messageId} where id = ${lead.id}`;
      await sendTranscript(sql, designer.telegram_chat_id, updated, messageId);
      await logEvent(sql, lead.id, "assigned", "system", { designer_id: designer.id, due: due.toISOString() });
      return;
    }
    review = "No designer is available to take this lead.";
    await sql`update leads set needs_review = true, review_reason = ${review} where id = ${lead.id}`;
    lead = { ...lead, needs_review: true, review_reason: review };
    await sendNikhil(`⚠️ No designer available for a new lead (${esc(lead.name ?? fmtPhone(lead.phone))}). It's gone to the front desk.`);
  }

  // Front desk.
  const due = frontDeskDue(callAt);
  const [updated] = await sql<Lead[]>`
    update leads set owner = 'front_desk', designer_id = null, status = 'new', due_at = ${due}
    where id = ${lead.id} returning *
  `;
  const header = updated.needs_review ? "🟠 <b>Needs review — call back</b>" : "🟡 <b>Call back — details unclear</b>";
  const fdMsg = await sendFrontDesk(leadCardText(updated, header), frontDeskKeyboard(lead.id), silent);
  await sendTranscript(sql, frontDeskChat(), updated, fdMsg);
  await logEvent(sql, lead.id, "to_front_desk", "system", { review });
}

/**
 * Takes a lead off its current designer (they passed, or didn't accept in
 * time) and gives it to the next one. The UPDATE ... WHERE designer_id = old
 * is the claim: if two sweeps race, only one reassigns.
 */
export async function reassign(sql: Sql, lead: Lead, reason: "passed" | "timeout", now: Date): Promise<Lead | null> {
  if (!lead.designer_id) return null;
  const [claimed] = await sql<Lead[]>`
    update leads set declined_by = array_append(declined_by, designer_id), designer_id = null
    where id = ${lead.id} and designer_id = ${lead.designer_id} and accepted_at is null
    returning *
  `;
  if (!claimed) return null;
  await logEvent(sql, lead.id, reason, reason === "passed" ? lead.designer_id : "system", { designer_id: lead.designer_id });

  const designer = claimed.reassign_count < MAX_REASSIGNS ? await pickDesigner(sql, claimed.area, claimed.declined_by, now) : null;
  if (!designer) {
    const review = "No designer accepted this lead in time.";
    const [fd] = await sql<Lead[]>`
      update leads set owner = 'front_desk', status = 'new', needs_review = true, review_reason = ${review}
      where id = ${lead.id} returning *
    `;
    await sendFrontDesk(leadCardText(fd, "🔴 <b>No designer took this lead — please call back</b>"), frontDeskKeyboard(lead.id));
    await sendNikhil(`⚠️ No designer accepted ${esc(fd.name ?? fmtPhone(fd.phone))}'s lead. The caller was promised a call by ${fmtTime(fd.due_at)}; it's with the front desk now.`);
    await logEvent(sql, lead.id, "to_front_desk", "system", { review });
    return fd;
  }

  const [updated] = await sql<Lead[]>`
    update leads set designer_id = ${designer.id}, assigned_at = ${now}, accepted_at = null,
      reassign_count = reassign_count + 1, reminder_sent_at = null
    where id = ${lead.id} returning *
  `;
  const messageId = await sendLeadCard(updated, designer, "🟢 <b>New lead (reassigned)</b>", !isBusinessHours(now));
  if (messageId) await sql`update leads set designer_message_id = ${messageId} where id = ${lead.id}`;
  await sendTranscript(sql, designer.telegram_chat_id, updated, messageId);
  await logEvent(sql, lead.id, "assigned", "system", { designer_id: designer.id, reassigned: true });
  return updated;
}

// ---------------------------------------------------------------------------
// Telegram: designer buttons, front desk buttons, commands
// ---------------------------------------------------------------------------

const ACTION = /^([acvnrxf]):([0-9a-f-]{36})(?::(\w{2}))?$/;

export interface TelegramDeps {
  classify?: Classifier;
}

export async function handleTelegramUpdate(sql: Sql, update: TelegramUpdate, now: Date, deps: TelegramDeps = {}): Promise<void> {
  if (update.message?.text) {
    const { chat, text, from } = update.message;
    if (/^\/start\b/.test(text)) {
      await sendMessage(String(chat.id), `Your Telegram chat ID is <code>${chat.id}</code>. Send it to the studio admin to start receiving leads.`);
    } else if (/^\/log\b/.test(text) && String(chat.id) === frontDeskChat()) {
      await sendMessage(String(chat.id), await logHumanCall(sql, text, from?.first_name ?? "front desk", now));
    } else {
      // Anything else is a question for the data bot — answered only for known people.
      const asker = await identifyAsker(sql, String(chat.id));
      if (asker) await sendMessage(String(chat.id), await answerQuestion(sql, asker, text, deps.classify, now));
    }
    return;
  }

  const q = update.callback_query;
  if (!q?.data || !q.message) return;
  const m = q.data.match(ACTION);
  if (!m) return answerCallback(q.id);
  const [, action, leadId, reasonCode] = m;
  const chatId = String(q.message.chat.id);
  const messageId = q.message.message_id;

  const [lead] = await sql<Lead[]>`select * from leads where id = ${leadId}`;
  if (!lead) return answerCallback(q.id, "Lead not found.");

  // Front-desk button: anyone in the front-desk group may press it.
  if (action === "f") {
    if (chatId !== frontDeskChat()) return answerCallback(q.id, "Not allowed.");
    const [u] = await sql<Lead[]>`
      update leads set first_action_at = coalesce(first_action_at, ${now}),
        status = case when status = 'new' then 'called'::lead_status else status end
      where id = ${leadId} returning *
    `;
    await logEvent(sql, leadId, "called", "frontdesk", { by: q.from.first_name });
    await editMessage(chatId, messageId, `${leadCardText(u, "✅ <b>Called back</b>")}\n<i>by ${esc(q.from.first_name ?? "front desk")}, ${fmtTime(now)}</i>`);
    return answerCallback(q.id, "Marked as called.");
  }

  // Designer buttons: only the assigned designer.
  const [designer] = lead.designer_id ? await sql<Designer[]>`select * from designers where id = ${lead.designer_id}` : [];
  if (!designer || designer.telegram_chat_id !== String(q.from.id)) {
    return answerCallback(q.id, "This lead isn't assigned to you any more.");
  }

  const setStatus = async (status: LeadStatus, extra: { not_fit_reason?: string } = {}) => {
    const [u] = await sql<Lead[]>`
      update leads set status = ${status}, first_action_at = coalesce(first_action_at, ${now}),
        accepted_at = coalesce(accepted_at, ${now}), not_fit_reason = coalesce(${extra.not_fit_reason ?? null}, not_fit_reason)
      where id = ${leadId} returning *
    `;
    await logEvent(sql, leadId, status, designer.id, extra);
    try {
      await updateDealStage(u, status);
    } catch (err) {
      console.error("[telegram] HubSpot stage update failed", err);
    }
    return u;
  };

  switch (action) {
    case "a": {
      const [u] = await sql<Lead[]>`update leads set accepted_at = coalesce(accepted_at, ${now}) where id = ${leadId} returning *`;
      await logEvent(sql, leadId, "accepted", designer.id);
      await editMessage(chatId, messageId, leadCardText(u, "✅ <b>Accepted — call them back</b>"), acceptedKeyboard(u, designer));
      return answerCallback(q.id, "Accepted. Please call them back.");
    }
    case "x": {
      if (lead.accepted_at) return answerCallback(q.id, "You've already accepted this lead.");
      await reassign(sql, lead, "passed", now);
      await editMessage(chatId, messageId, `↪️ You passed on ${esc(lead.name ?? "this lead")}. It's gone to another designer.`);
      return answerCallback(q.id, "Passed on.");
    }
    case "c": {
      const u = await setStatus(lead.status === "assigned" ? "called" : lead.status);
      await editMessage(chatId, messageId, leadCardText(u, "📞 <b>Called</b>"), acceptedKeyboard(u, designer));
      return answerCallback(q.id, "Marked as called.");
    }
    case "v": {
      const u = await setStatus("visit_booked");
      await editMessage(chatId, messageId, leadCardText(u, "📅 <b>Visit booked</b>"), acceptedKeyboard(u, designer));
      return answerCallback(q.id, "Visit booked.");
    }
    case "n":
      await editMessage(chatId, messageId, `${leadCardText(lead, "🚫 <b>Not a fit — why?</b>")}`, notFitReasonKeyboard(leadId));
      return answerCallback(q.id, "Pick a reason.");
    case "r": {
      const reason = NOT_FIT_REASONS[reasonCode ?? ""];
      if (!reason) return answerCallback(q.id, "Pick a reason.");
      const u = await setStatus("not_fit", { not_fit_reason: reason });
      await editMessage(chatId, messageId, leadCardText(u, `🚫 <b>Not a fit</b> — ${esc(reason)}`));
      await sendFrontDesk(`ℹ️ ${esc(designer.name)} marked ${esc(u.name ?? fmtPhone(u.phone))} as not a fit: ${esc(reason)}.`, undefined, true);
      return answerCallback(q.id, "Closed.");
    }
  }
}

// ---------------------------------------------------------------------------
// Front desk logs the calls it answers, so the dashboard counts every call
// ---------------------------------------------------------------------------

const LOG_OUTCOMES: Record<string, { category: "new_project" | "existing_client" | "vendor"; score: LeadScore | null }> = {
  qualified: { category: "new_project", score: "qualified" },
  unclear: { category: "new_project", score: "unclear" },
  notfit: { category: "new_project", score: "not_fit" },
  existing: { category: "existing_client", score: null },
  other: { category: "vendor", score: null },
};

export function parseLogCommand(text: string): { phone: string; outcome: keyof typeof LOG_OUTCOMES; note: string } | null {
  const m = text.trim().match(/^\/log(?:@\w+)?\s+(\+?[\d\s-]{8,16}?)\s+(qualified|unclear|notfit|not-fit|existing|other)\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const phone = normalizePhone(m[1]);
  if (!phone) return null;
  const outcome = m[2].toLowerCase().replace("-", "") as keyof typeof LOG_OUTCOMES;
  return { phone, outcome, note: m[3].trim().slice(0, 500) };
}

export async function logHumanCall(sql: Sql, text: string, by: string, now: Date): Promise<string> {
  const parsed = parseLogCommand(text);
  if (!parsed) {
    return "Usage: <code>/log &lt;phone&gt; &lt;qualified|unclear|notfit|existing|other&gt; &lt;note&gt;</code>\ne.g. <code>/log 98123 45678 qualified Priya, 3BHK Kothrud, full home, by March</code>";
  }
  const { phone, outcome, note } = parsed;
  const o = LOG_OUTCOMES[outcome];
  const [call] = await sql<{ id: string }[]>`
    insert into calls (handled_by, caller_phone, started_at, ended_at, status, processed_at, category, score)
    values ('human', ${phone}, ${now}, ${now}, 'completed', ${now}, ${o.category}, ${o.score})
    returning id
  `;
  if (!o.score) return `Logged ✓ (${outcome}) — ${esc(fmtPhone(phone))}`;

  const [lead] = await sql<Lead[]>`
    insert into leads (call_id, phone, score, status, owner, summary, last_call_at)
    values (${call.id}, ${phone}, ${o.score}, ${o.score === "not_fit" ? "not_fit" : "new"}, 'front_desk', ${note || null}, ${now})
    returning *
  `;
  await sql`update calls set lead_id = ${lead.id} where id = ${call.id}`;
  await logEvent(sql, lead.id, "created", `frontdesk:${by}`, { outcome });

  if (o.score === "qualified") {
    await routeLead(sql, lead, "designer", null, now, now);
    const [l] = await sql<Lead[]>`select * from leads where id = ${lead.id}`;
    return l.designer_id ? `Logged ✓ and sent to a designer — callback due ${fmtTime(l.due_at)}.` : "Logged ✓ — no designer available; it's with the front desk.";
  }
  if (o.score === "unclear") {
    await sql`update leads set due_at = ${frontDeskDue(now)} where id = ${lead.id}`;
  }
  return `Logged ✓ (${outcome}) — ${esc(fmtPhone(phone))}`;
}

// ---------------------------------------------------------------------------
// Calendly
// ---------------------------------------------------------------------------

export async function handleCalendlyBooking(
  sql: Sql,
  booking: { event: string; leadId: string | null; eventUri: string | null; startTime: Date | null },
  now: Date,
): Promise<"booked" | "cancelled" | "ignored"> {
  if (!booking.leadId) return "ignored";
  const [lead] = await sql<Lead[]>`select * from leads where id = ${booking.leadId}`;
  if (!lead) return "ignored";

  if (booking.event === "invitee.canceled") {
    if (lead.status === "visit_booked" && lead.calendly_event_uri === booking.eventUri) {
      await sql`update leads set status = 'called', calendly_event_uri = null where id = ${lead.id}`;
      await logEvent(sql, lead.id, "visit_cancelled", "calendly");
    }
    return "cancelled";
  }

  const [u] = await sql<Lead[]>`
    update leads set status = 'visit_booked', calendly_event_uri = ${booking.eventUri},
      first_action_at = coalesce(first_action_at, ${now}), accepted_at = coalesce(accepted_at, ${now})
    where id = ${lead.id} and (calendly_event_uri is distinct from ${booking.eventUri})
    returning *
  `;
  if (!u) return "booked"; // already recorded: Calendly retried
  await logEvent(sql, lead.id, "visit_booked", "calendly", { start: booking.startTime?.toISOString() });
  try {
    await updateDealStage(u, "visit_booked");
  } catch (err) {
    console.error("[calendly] HubSpot stage update failed", err);
  }
  const [designer] = u.designer_id ? await sql<Designer[]>`select * from designers where id = ${u.designer_id}` : [];
  if (designer?.telegram_chat_id) {
    await sendMessage(designer.telegram_chat_id, `📅 Visit fixed with <b>${esc(u.name ?? fmtPhone(u.phone))}</b>: ${fmtTime(booking.startTime)}.`);
  }
  return "booked";
}

// ---------------------------------------------------------------------------
// The sweep: runs every few minutes (GitHub Actions) and after webhooks
// ---------------------------------------------------------------------------

export interface SweepResult {
  reassigned: number;
  reminded: number;
  escalated: number;
  frontDeskReminded: number;
  droppedFollowups: number;
  staleCalls: number;
}

export async function sweep(sql: Sql, now: Date): Promise<SweepResult> {
  const r: SweepResult = { reassigned: 0, reminded: 0, escalated: 0, frontDeskReminded: 0, droppedFollowups: 0, staleCalls: 0 };
  const silent = !isBusinessHours(now);

  // 1. Not accepted in time → next designer. Each designer gets at least 30
  //    minutes; for a 2-hour promise the first one must accept within 30.
  const unaccepted = await sql<Lead[]>`
    select * from leads
    where owner = 'designer' and status = 'assigned' and accepted_at is null and first_action_at is null
      and designer_id is not null
      and greatest(assigned_at + interval '30 minutes', due_at - interval '90 minutes') <= ${now}
  `;
  for (const lead of unaccepted) if (await reassign(sql, lead, "timeout", now)) r.reassigned++;

  // 2. Accepted but not called with an hour to go → remind the designer.
  const toRemind = await sql<Lead[]>`
    update leads set reminder_sent_at = ${now}
    where owner = 'designer' and status = 'assigned' and accepted_at is not null and first_action_at is null
      and reminder_sent_at is null and due_at - interval '60 minutes' <= ${now}
    returning *
  `;
  for (const lead of toRemind) {
    const [d] = await sql<Designer[]>`select * from designers where id = ${lead.designer_id}`;
    if (d?.telegram_chat_id) {
      await sendMessage(d.telegram_chat_id, `⏰ Reminder: <b>${esc(lead.name ?? fmtPhone(lead.phone))}</b> was promised a call by ${fmtTime(lead.due_at)}. ${esc(fmtPhone(lead.phone))}`, { silent });
    }
    await logEvent(sql, lead.id, "reminded", "system");
    r.reminded++;
  }

  // 3. Still not called 30 minutes before the promise → Nikhil and the front desk.
  const atRisk = await sql<(Lead & { designer_name: string | null })[]>`
    with u as (
      update leads set escalated_at = ${now}
      where owner = 'designer' and status = 'assigned' and first_action_at is null
        and escalated_at is null and due_at - interval '30 minutes' <= ${now}
      returning *
    )
    select u.*, d.name as designer_name from u left join designers d on d.id = u.designer_id
  `;
  for (const lead of atRisk) {
    const text = `🔴 <b>Callback at risk</b>: ${esc(lead.name ?? "a caller")} (${esc(fmtPhone(lead.phone))}) was promised a call by ${fmtTime(lead.due_at)}. ${esc(lead.designer_name ?? "The designer")} hasn't called yet.`;
    await sendNikhil(text);
    await sendFrontDesk(text, frontDeskKeyboard(lead.id), silent);
    await logEvent(sql, lead.id, "escalated", "system");
    r.escalated++;
  }

  // 4. Front-desk leads due → remind the group once.
  const fdDue = await sql<Lead[]>`
    update leads set reminder_sent_at = ${now}
    where owner = 'front_desk' and status = 'new' and first_action_at is null
      and reminder_sent_at is null and due_at - interval '30 minutes' <= ${now}
    returning *
  `;
  for (const lead of fdDue) {
    await sendFrontDesk(leadCardText(lead, "⏰ <b>Call back due</b>"), frontDeskKeyboard(lead.id), silent);
    r.frontDeskReminded++;
  }

  // 5. Calls Vani never finished reporting → treat as failed.
  const stale = await sql`
    update calls set status = 'failed'
    where status = 'in_progress' and processed_at is null
      and started_at < ${new Date(now.getTime() - STALE_CALL_MIN * MIN)}
    returning id
  `;
  r.staleCalls = stale.length;

  // 6. Dropped/failed calls: follow up unless the caller rang back and got through (T17).
  const dropped = await sql<{ id: string; caller_phone: string; started_at: Date; superseded: boolean }[]>`
    with claimed as (
      update calls set followup_sent_at = ${now}
      where status in ('dropped', 'failed') and followup_sent_at is null
        and started_at <= ${new Date(now.getTime() - DROPPED_GRACE_MIN * MIN)}
      returning id, caller_phone, started_at
    )
    select c.*, exists (
      select 1 from calls later
      where later.caller_phone = c.caller_phone and later.started_at > c.started_at and later.status = 'completed'
    ) as superseded
    from claimed c
  `;
  for (const c of dropped) {
    if (c.superseded || c.caller_phone === "unknown") continue;
    await sendFrontDesk(
      `📵 <b>Dropped call</b> from ${esc(fmtPhone(c.caller_phone))} at ${fmtTime(c.started_at)} — no details captured. Please call back ${describeDue(now, frontDeskDue(now))}.`,
      undefined,
      silent,
    );
    r.droppedFollowups++;
  }

  return r;
}
