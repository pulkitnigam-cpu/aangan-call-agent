import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { stageFor, updateDealStage, upsertContactAndDeal } from "../lib/hubspot";
import type { Lead } from "../lib/types";

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
let calls: Call[];
let script: ((c: Call) => { status: number; body?: unknown } | undefined)[];
const original = globalThis.fetch;

beforeEach(() => {
  calls = [];
  script = [];
  Object.assign(process.env, {
    HUBSPOT_TOKEN: "test",
    HUBSPOT_PIPELINE_ID: "pl1",
    HUBSPOT_STAGE_NEW: "s_new",
    HUBSPOT_STAGE_QUALIFIED: "s_q",
    HUBSPOT_STAGE_VISIT_BOOKED: "s_vb",
    HUBSPOT_STAGE_VISIT_DONE: "s_vd",
    HUBSPOT_STAGE_WON: "s_won",
    HUBSPOT_STAGE_LOST: "s_lost",
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const c: Call = { method: init?.method ?? "GET", path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = script.shift()?.(c) ?? { status: 200, body: { id: `id${calls.length}`, results: [] } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "retry-after": "0" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

const lead = (over: Partial<Lead> = {}): Lead =>
  ({
    id: "L1", phone: "+919812345678", name: "Priya", area: "Baner", size_sqft: 950, budget: null, timeline: "by March",
    summary: "2BHK Baner", score: "qualified", status: "assigned", owner: "designer", score_reasons: [],
    hubspot_contact_id: null, hubspot_deal_id: null, assigned_at: null, due_at: null, first_action_at: null,
    ...over,
  }) as Lead;

describe("HubSpot", () => {
  it("maps statuses to pipeline stages", () => {
    assert.equal(stageFor("assigned", "qualified"), "s_q");
    assert.equal(stageFor("new", "unclear"), "s_new");
    assert.equal(stageFor("visit_booked", "qualified"), "s_vb");
    assert.equal(stageFor("not_fit", "not_fit"), "s_lost");
    assert.equal(stageFor("won", "qualified"), "s_won");
  });

  it("new lead → finds no contact, creates one, creates the deal linked to it", async () => {
    script = [() => ({ status: 200, body: { results: [] } }), () => ({ status: 201, body: { id: "C9" } }), () => ({ status: 201, body: { id: "D7" } })];
    const ids = await upsertContactAndDeal(lead(), 24.1, "Rohan Joshi");
    assert.deepEqual(ids, { contactId: "C9", dealId: "D7" });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /crm/v3/objects/contacts/search", "POST /crm/v3/objects/contacts", "POST /crm/v3/objects/deals"]);
    const deal = calls[2].body as { properties: Record<string, string>; associations: { to: { id: string } }[] };
    assert.equal(deal.properties.pipeline, "pl1");
    assert.equal(deal.properties.dealstage, "s_q");
    assert.equal(deal.properties.cost_per_call_inr, "24.10");
    assert.equal(deal.properties.assigned_designer, "Rohan Joshi");
    assert.equal(deal.associations[0].to.id, "C9");
  });

  it("returning caller → reuses the contact found by phone", async () => {
    script = [() => ({ status: 200, body: { results: [{ id: "C1" }] } }), () => ({ status: 200, body: {} }), () => ({ status: 201, body: { id: "D2" } })];
    const ids = await upsertContactAndDeal(lead(), 10);
    assert.equal(ids.contactId, "C1");
    assert.equal(calls[1].method, "PATCH");
  });

  it("unclear front-desk lead → also creates a high-priority task", async () => {
    script = [() => ({ status: 200, body: { results: [] } }), () => ({ status: 201, body: { id: "C3" } }), () => ({ status: 201, body: { id: "D3" } })];
    await upsertContactAndDeal(lead({ score: "unclear", owner: "front_desk", status: "new" }), 5);
    const task = calls.find((c) => c.path === "/crm/v3/objects/tasks");
    assert.ok(task);
    assert.equal((task.body as { properties: Record<string, string> }).properties.hs_task_priority, "HIGH");
  });

  it("retries on rate limit, then succeeds", async () => {
    script = [() => ({ status: 429, body: {} }), () => ({ status: 200, body: { results: [] } })];
    const ok = await upsertContactAndDeal(lead(), 1);
    assert.ok(ok.dealId);
    assert.equal(calls[0].path, calls[1].path);
  });

  it("button tap → moves the deal and records response time", async () => {
    const assigned = new Date("2026-10-07T09:30:00Z");
    await updateDealStage(lead({ hubspot_deal_id: "D5", assigned_at: assigned, due_at: new Date(assigned.getTime() + 7200_000), first_action_at: new Date(assigned.getTime() + 25 * 60_000) }), "called");
    assert.equal(calls[0].method, "PATCH");
    assert.deepEqual(calls[0].body, { properties: { dealstage: "s_q", response_time_min: "25" } });
  });

  it("without a token, nothing is sent", async () => {
    delete process.env.HUBSPOT_TOKEN;
    assert.deepEqual(await upsertContactAndDeal(lead(), 1), { contactId: null, dealId: null });
    assert.equal(calls.length, 0);
  });
});
