// HubSpot is Nikhil's dashboard: contacts, deals in a pipeline, and the
// numbers he used to count by hand (conversions, response time, cost per lead).
//
// Every lead becomes a contact (matched by phone) and a deal. Status changes
// move the deal's stage. Unclear leads also get a task for the front desk.
// Without HUBSPOT_TOKEN everything is a logged no-op, so dev and tests run offline.
// HubSpot failures never block a lead (callers catch and log).

import type { Lead, LeadStatus } from "./types";

const API = "https://api.hubapi.com";
const ASSOC_DEAL_TO_CONTACT = 3; // HUBSPOT_DEFINED association type ids
const ASSOC_TASK_TO_CONTACT = 204;

export const DEAL_PROPERTIES = [
  { name: "lead_score", label: "Lead score", type: "enumeration", fieldType: "select", options: ["qualified", "unclear", "not_fit"] },
  { name: "area", label: "Area", type: "string", fieldType: "text" },
  { name: "size_sqft", label: "Size (sq ft)", type: "number", fieldType: "number" },
  { name: "budget", label: "Budget (caller's words)", type: "string", fieldType: "text" },
  { name: "timeline", label: "Timeline", type: "string", fieldType: "text" },
  { name: "call_summary", label: "Call summary", type: "string", fieldType: "textarea" },
  { name: "assigned_designer", label: "Assigned designer", type: "string", fieldType: "text" },
  { name: "cost_per_call_inr", label: "AI cost for this lead (INR)", type: "number", fieldType: "number" },
  { name: "response_time_min", label: "Designer response time (min)", type: "number", fieldType: "number" },
  { name: "ai_handled", label: "Answered by AI", type: "bool", fieldType: "booleancheckbox" },
] as const;

const configured = () => !!process.env.HUBSPOT_TOKEN;

/** Status → pipeline stage id (from env, printed by scripts/hubspot-setup.ts). */
export function stageFor(status: LeadStatus, score: string): string | undefined {
  const env = process.env;
  switch (status) {
    case "visit_booked": return env.HUBSPOT_STAGE_VISIT_BOOKED;
    case "visit_done": return env.HUBSPOT_STAGE_VISIT_DONE;
    case "won": return env.HUBSPOT_STAGE_WON;
    case "lost":
    case "not_fit": return env.HUBSPOT_STAGE_LOST;
    case "assigned":
    case "called": return env.HUBSPOT_STAGE_QUALIFIED;
    case "new": return score === "qualified" ? env.HUBSPOT_STAGE_QUALIFIED : env.HUBSPOT_STAGE_NEW;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HubSpot API call with up to 3 retries on 429/5xx (exponential backoff). */
export async function hs<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt);
      continue;
    }
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`HubSpot ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
  }
}

function dealProps(lead: Lead, costInr: number, designerName: string | null) {
  const props: Record<string, string> = {
    dealname: `${lead.name ?? "Caller"} · ${lead.area ?? "area unknown"}`,
    lead_score: lead.score,
    area: lead.area ?? "",
    size_sqft: lead.size_sqft ? String(lead.size_sqft) : "",
    budget: lead.budget ?? "",
    timeline: lead.timeline ?? "",
    call_summary: lead.summary ?? "",
    assigned_designer: designerName ?? "",
    cost_per_call_inr: costInr.toFixed(2),
    ai_handled: "true",
  };
  if (lead.first_action_at && lead.assigned_at && lead.due_at) {
    const start = Math.max(lead.assigned_at.getTime(), lead.due_at.getTime() - 2 * 3600_000);
    props.response_time_min = String(Math.max(0, Math.round((lead.first_action_at.getTime() - start) / 60_000)));
  }
  const stage = stageFor(lead.status, lead.score);
  if (stage) props.dealstage = stage;
  return props;
}

async function upsertContact(lead: Lead): Promise<string> {
  const found = await hs<{ results: { id: string }[] }>("POST", "/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: lead.phone }] }],
    limit: 1,
  });
  const properties = { phone: lead.phone, ...(lead.name ? { firstname: lead.name } : {}) };
  if (found.results[0]) {
    await hs("PATCH", `/crm/v3/objects/contacts/${found.results[0].id}`, { properties });
    return found.results[0].id;
  }
  const created = await hs<{ id: string }>("POST", "/crm/v3/objects/contacts", { properties });
  return created.id;
}

/** Creates/updates the contact and deal for a lead. Returns the HubSpot ids. */
export async function upsertContactAndDeal(
  lead: Lead,
  costInr: number,
  designerName: string | null = null,
): Promise<{ contactId: string | null; dealId: string | null }> {
  if (!configured()) {
    console.log(`[hubspot:off] contact+deal for lead ${lead.id} (cost ₹${costInr})`);
    return { contactId: null, dealId: null };
  }
  const contactId = lead.hubspot_contact_id ?? (await upsertContact(lead));
  const properties = dealProps(lead, costInr, designerName);
  let dealId = lead.hubspot_deal_id;
  if (dealId) {
    await hs("PATCH", `/crm/v3/objects/deals/${dealId}`, { properties });
  } else {
    const created = await hs<{ id: string }>("POST", "/crm/v3/objects/deals", {
      properties: { ...properties, pipeline: process.env.HUBSPOT_PIPELINE_ID ?? "default" },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC_DEAL_TO_CONTACT }] }],
    });
    dealId = created.id;
  }
  if (lead.score === "unclear" && lead.owner === "front_desk" && !lead.hubspot_deal_id) {
    await hs("POST", "/crm/v3/objects/tasks", {
      properties: {
        hs_task_subject: `Call back: ${lead.name ?? lead.phone} (details unclear)`,
        hs_task_body: [lead.summary, ...lead.score_reasons].filter(Boolean).join("\n"),
        hs_task_status: "NOT_STARTED",
        hs_task_priority: "HIGH",
        hs_timestamp: (lead.due_at ?? new Date()).toISOString(),
      },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC_TASK_TO_CONTACT }] }],
    });
  }
  return { contactId, dealId };
}

/** Moves the deal when a designer taps a button or a visit is booked. */
export async function updateDealStage(lead: Lead, status: LeadStatus): Promise<void> {
  if (!configured() || !lead.hubspot_deal_id) {
    console.log(`[hubspot:off] deal ${lead.hubspot_deal_id ?? "-"} -> ${status}`);
    return;
  }
  const properties: Record<string, string> = {};
  const stage = stageFor(status, lead.score);
  if (stage) properties.dealstage = stage;
  if (lead.first_action_at && lead.assigned_at && lead.due_at) {
    const start = Math.max(lead.assigned_at.getTime(), lead.due_at.getTime() - 2 * 3600_000);
    properties.response_time_min = String(Math.max(0, Math.round((lead.first_action_at.getTime() - start) / 60_000)));
  }
  if (Object.keys(properties).length) await hs("PATCH", `/crm/v3/objects/deals/${lead.hubspot_deal_id}`, { properties });
}
