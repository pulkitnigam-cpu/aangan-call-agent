// End-to-end workflow tests against a real Postgres (PGlite) with a fake
// Telegram. Each test is a situation from the 7 Oct review.

import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, afterEach, describe, it } from "vitest";
import { handleCalendlyBooking, handleCallEnded, handleCallStarted, handleCheckFit, handleTelegramUpdate, sweep } from "../lib/leads";
import type { Lead } from "../lib/types";
import { CHAT, endedCall, fakeTelegram, startTestDb } from "./helpers";

const DAY = "2026-10-07T15:00:00+05:30"; // Wed 3pm, studio open
const NIGHT = "2026-10-07T23:00:00+05:30"; // Wed 11pm
const at = (iso: string) => new Date(iso);
const plusMin = (iso: string, m: number) => new Date(at(iso).getTime() + m * 60_000);

let env: Awaited<ReturnType<typeof startTestDb>>;
let tg: ReturnType<typeof fakeTelegram>;

beforeAll(async () => {
  env = await startTestDb();
});
afterAll(async () => {
  await env.stop();
});
beforeEach(async () => {
  await env.reset();
  tg = fakeTelegram();
});
afterEach(() => tg.restore());

const leadById = async (id: string) => (await env.sql<Lead[]>`select * from leads where id = ${id}`)[0];
const tap = (data: string, fromChat: string, now: Date) =>
  handleTelegramUpdate(env.sql, { callback_query: { id: "cq", from: { id: Number(fromChat), first_name: "T" }, data, message: { chat: { id: Number(fromChat) }, message_id: 1 } } }, now);

describe("routing a new enquiry", () => {
  it("in hours: goes to the designer who covers the area, with sound, due in 2 hours", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    assert.equal(r.kind, "lead");
    const lead = await leadById((r as { leadId: string }).leadId);
    assert.equal(lead.status, "assigned");
    const card = tg.messagesTo(CHAT.rohan); // Baner → Rohan
    assert.equal(card.length, 1);
    assert.equal(card[0].body.disable_notification, false);
    assert.equal(lead.due_at!.toISOString(), plusMin(DAY, 120).toISOString());
    assert.match(String(card[0].body.text), /Priya/);
  });

  it("at night: card is silent and the deadline is noon next day", async () => {
    const r = await handleCallEnded(env.sql, endedCall(NIGHT), {}, at(NIGHT));
    const lead = await leadById((r as { leadId: string }).leadId);
    assert.equal(tg.messagesTo(CHAT.rohan)[0].body.disable_notification, true);
    assert.equal(lead.due_at!.toISOString(), at("2026-10-08T12:00:00+05:30").toISOString());
  });

  it("a retried webhook is processed once", async () => {
    const call = endedCall(DAY);
    await handleCallEnded(env.sql, call, {}, at(DAY));
    const again = await handleCallEnded(env.sql, call, {}, at(DAY));
    assert.equal(again.kind, "duplicate");
    assert.equal(tg.messagesTo(CHAT.rohan).length, 1);
  });

  it("records call cost from Vani minutes and Gemini tokens", async () => {
    await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    const [c] = await env.sql<{ cost_inr: string }[]>`select cost_inr from calls`;
    assert.equal(c.cost_inr, "24.10"); // 4 min × ₹6 + 1.5k in × ₹0.04 + 0.5k out × ₹0.08
  });
});

describe("keeping promises (agent and rules disagree)", () => {
  it("promised a designer but the rules say not a fit → designer still calls, flagged for review", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY, { area: "Nashik" }), {}, at(DAY));
    const lead = await leadById((r as { leadId: string }).leadId);
    assert.equal(lead.owner, "designer");
    assert.equal(lead.needs_review, true);
    assert.match(lead.review_reason!, /promised a designer callback/);
    assert.equal(tg.sent.filter((s) => s.method === "sendMessage").length, 1);
  });

  it("agent declined but the rules say qualified → front desk calls back to check", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY, { promised_outcome: "declined" }), {}, at(DAY));
    const lead = await leadById((r as { leadId: string }).leadId);
    assert.equal(lead.owner, "front_desk");
    assert.match(lead.review_reason!, /agent declined/);
    assert.equal(tg.messagesTo(CHAT.frontDesk).length, 1);
  });

  it("declined and the rules agree → closed quietly", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY, { area: "Nashik", promised_outcome: "declined" }), {}, at(DAY));
    const lead = await leadById((r as { leadId: string }).leadId);
    assert.equal(lead.status, "not_fit");
    assert.equal(tg.sent.length, 0);
  });

  it("uses the live check_fit result when the extraction missed the close", async () => {
    const call = endedCall(DAY, { promised_outcome: "none", area: "Wakad" });
    const fit = await handleCheckFit(env.sql, call.providerCallId, { intent: "design_and_execution", area: "Wakad", project_kind: "home", scope_kind: "full_home" }, at(DAY));
    assert.equal(fit.outcome, "designer_callback");
    assert.match(fit.say, /within 2 hours/);
    const r = await handleCallEnded(env.sql, call, {}, at(DAY));
    assert.equal((r as { route: string }).route, "designer");
  });
});

describe("guardrails after the call", () => {
  it("recording declined → no transcript or raw payload kept", async () => {
    await handleCallEnded(env.sql, endedCall(DAY, { recording_consent: false }), {}, at(DAY));
    const [c] = await env.sql`select transcript, raw_payload, recording_consent from calls`;
    assert.equal(c.transcript, null);
    assert.deepEqual(c.raw_payload, { redacted: "recording consent declined" });
    assert.equal(c.recording_consent, false);
  });

  it("price said by the agent → stored and Nikhil alerted", async () => {
    const call = endedCall(DAY, {}, { turns: [{ role: "agent", text: "It's usually around 2,000 a sq ft." }, { role: "caller", text: "ok" }] });
    await handleCallEnded(env.sql, call, {}, at(DAY));
    const [c] = await env.sql<{ price_mentions: string[] }[]>`select price_mentions from calls`;
    assert.ok(c.price_mentions.length > 0);
    assert.match(String(tg.messagesTo(CHAT.nikhil)[0]?.body.text), /Price guardrail/);
  });

  it("a caller quoting their own budget doesn't trip the guardrail", async () => {
    const call = endedCall(DAY, {}, { turns: [{ role: "caller", text: "My budget is 12 lakh." }, { role: "agent", text: "Thank you, noted." }] });
    await handleCallEnded(env.sql, call, {}, at(DAY));
    assert.equal(tg.messagesTo(CHAT.nikhil).length, 0);
  });
});

describe("other kinds of call", () => {
  it("existing client complaint → front desk and Nikhil, senior callback in 15 min (T09)", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY, { category: "existing_client", escalate: true, escalation_reason: "Designer hasn't replied in 5 days" }), {}, at(DAY));
    assert.deepEqual(r, { kind: "existing_client", escalated: true });
    assert.equal(tg.messagesTo(CHAT.nikhil).length, 1);
    assert.match(String(tg.messagesTo(CHAT.frontDesk)[0].body.text), /senior person/);
  });

  it("extraction failed → a human looks at it, nothing lost", async () => {
    const call = endedCall(DAY, {}, { extraction: null });
    const r = await handleCallEnded(env.sql, call, { extract: async () => { throw new Error("Gemini down"); } }, at(DAY));
    const lead = await leadById((r as { leadId: string }).leadId);
    assert.equal(lead.owner, "front_desk");
    assert.match(lead.review_reason!, /Gemini down/);
  });

  it("withheld caller ID → uses the number the caller gave", async () => {
    const call = endedCall(DAY, { callback_phone: "98765 43210" }, { callerPhone: "" });
    const r = await handleCallEnded(env.sql, call, {}, at(DAY));
    assert.equal((await leadById((r as { leadId: string }).leadId)).phone, "+919876543210");
  });
});

describe("repeat and dropped calls", () => {
  it("same caller again → one lead, same designer told 'called again' (T16)", async () => {
    const first = await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    const later = "2026-10-07T16:00:00+05:30";
    const second = await handleCallEnded(env.sql, endedCall(later, { timeline: "by March" }), {}, at(later));
    assert.equal((second as { merged: boolean }).merged, true);
    assert.equal((second as { leadId: string }).leadId, (first as { leadId: string }).leadId);
    const [{ n }] = await env.sql<{ n: number }[]>`select count(*)::int n from leads`;
    assert.equal(n, 1);
    assert.match(String(tg.messagesTo(CHAT.rohan)[1].body.text), /called again/);
    assert.equal((await leadById((first as { leadId: string }).leadId)).timeline, "by March");
  });

  it("dropped, then rang back within 15 min → no stray follow-up (T17)", async () => {
    await handleCallEnded(env.sql, endedCall(DAY, {}, { status: "dropped", durationSec: 12, extraction: null }), {}, at(DAY));
    await handleCallEnded(env.sql, endedCall(DAY, {}, { startedAt: plusMin(DAY, 2) }), {}, plusMin(DAY, 6));
    const s = await sweep(env.sql, plusMin(DAY, 20));
    assert.equal(s.droppedFollowups, 0);
    assert.equal(tg.messagesTo(CHAT.frontDesk).length, 0);
  });

  it("dropped and never rang back → front desk follow-up after 15 min, once", async () => {
    await handleCallEnded(env.sql, endedCall(DAY, {}, { status: "dropped", durationSec: 12, extraction: null }), {}, at(DAY));
    assert.equal((await sweep(env.sql, plusMin(DAY, 10))).droppedFollowups, 0);
    assert.equal((await sweep(env.sql, plusMin(DAY, 16))).droppedFollowups, 1);
    assert.equal((await sweep(env.sql, plusMin(DAY, 30))).droppedFollowups, 0);
    assert.match(String(tg.messagesTo(CHAT.frontDesk)[0].body.text), /Dropped call/);
  });

  it("call that started but never reported back (Vani failure) → followed up", async () => {
    await handleCallStarted(env.sql, { providerCallId: "lost-1", callerPhone: "9812345678" }, at(DAY));
    assert.equal((await sweep(env.sql, plusMin(DAY, 29))).staleCalls, 0); // may still be talking
    const s = await sweep(env.sql, plusMin(DAY, 31));
    assert.equal(s.staleCalls, 1);
    assert.equal(s.droppedFollowups, 1); // already past the 15-min grace, so same pass
    assert.equal((await sweep(env.sql, plusMin(DAY, 47))).droppedFollowups, 0);
  });
});

describe("designer buttons", () => {
  async function assigned(): Promise<Lead> {
    const r = await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    return leadById((r as { leadId: string }).leadId);
  }

  it("only the assigned designer can act on a lead", async () => {
    const lead = await assigned();
    await tap(`a:${lead.id}`, CHAT.meera, at(DAY));
    assert.equal((await leadById(lead.id)).accepted_at, null);
    assert.match(String(tg.sent.at(-1)!.body.text), /isn't assigned to you/);
  });

  it("accept → buttons change to Called / Visit booked / Not a fit, with a Calendly link carrying the lead ID", async () => {
    const lead = await assigned();
    await tap(`a:${lead.id}`, CHAT.rohan, plusMin(DAY, 5));
    assert.ok((await leadById(lead.id)).accepted_at);
    const edit = tg.sent.find((s) => s.method === "editMessageText")!;
    const kb = JSON.stringify(edit.body.reply_markup);
    assert.match(kb, /Called/);
    assert.match(kb, new RegExp(`utm_content=${lead.id}`));
  });

  it("can't take → goes to another designer, never back to the one who passed", async () => {
    const lead = await assigned();
    await tap(`x:${lead.id}`, CHAT.rohan, plusMin(DAY, 5));
    const after1 = await leadById(lead.id);
    assert.notEqual(after1.designer_id, lead.designer_id);
    assert.deepEqual(after1.declined_by, [lead.designer_id]);
    assert.equal(after1.reassign_count, 1);
  });

  it("not a fit needs a reason, which the front desk sees", async () => {
    const lead = await assigned();
    await tap(`a:${lead.id}`, CHAT.rohan, plusMin(DAY, 5));
    await tap(`n:${lead.id}`, CHAT.rohan, plusMin(DAY, 20));
    assert.equal((await leadById(lead.id)).status, "assigned"); // not closed yet
    await tap(`r:${lead.id}:bu`, CHAT.rohan, plusMin(DAY, 21));
    const closed = await leadById(lead.id);
    assert.equal(closed.status, "not_fit");
    assert.equal(closed.not_fit_reason, "Budget");
    assert.match(String(tg.messagesTo(CHAT.frontDesk).at(-1)!.body.text), /not a fit: Budget/);
  });
});

describe("the sweep keeps the 2-hour promise", () => {
  it("not accepted in 30 min → reassigned; after 2 passes → front desk + Nikhil", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    const id = (r as { leadId: string }).leadId;
    assert.equal((await sweep(env.sql, plusMin(DAY, 29))).reassigned, 0);
    assert.equal((await sweep(env.sql, plusMin(DAY, 31))).reassigned, 1);
    assert.equal((await sweep(env.sql, plusMin(DAY, 62))).reassigned, 1);
    await sweep(env.sql, plusMin(DAY, 93));
    const lead = await leadById(id);
    assert.equal(lead.owner, "front_desk");
    assert.equal(lead.designer_id, null);
    assert.equal(lead.declined_by.length, 3);
    assert.ok(tg.messagesTo(CHAT.nikhil).some((m) => /No designer accepted/.test(String(m.body.text))));
  });

  it("accepted but not called → reminder at 1h to go, Nikhil alerted at 30 min to go", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    const id = (r as { leadId: string }).leadId;
    await tap(`a:${id}`, CHAT.rohan, plusMin(DAY, 5));
    assert.equal((await sweep(env.sql, plusMin(DAY, 59))).reminded, 0);
    assert.equal((await sweep(env.sql, plusMin(DAY, 61))).reminded, 1);
    assert.equal((await sweep(env.sql, plusMin(DAY, 70))).reminded, 0); // once only
    assert.equal((await sweep(env.sql, plusMin(DAY, 91))).escalated, 1);
    assert.equal(tg.messagesTo(CHAT.nikhil).length, 1);
  });

  it("calling back stops all of it", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    const id = (r as { leadId: string }).leadId;
    await tap(`a:${id}`, CHAT.rohan, plusMin(DAY, 5));
    await tap(`c:${id}`, CHAT.rohan, plusMin(DAY, 40));
    const s = await sweep(env.sql, plusMin(DAY, 115));
    assert.deepEqual([s.reassigned, s.reminded, s.escalated], [0, 0, 0]);
  });

  it("night lead: nobody is chased at night; the clock runs from the morning", async () => {
    const r = await handleCallEnded(env.sql, endedCall(NIGHT), {}, at(NIGHT));
    const id = (r as { leadId: string }).leadId;
    const s = await sweep(env.sql, at("2026-10-08T02:00:00+05:30"));
    assert.deepEqual([s.reassigned, s.reminded, s.escalated], [0, 0, 0]);
    assert.equal((await sweep(env.sql, at("2026-10-08T10:31:00+05:30"))).reassigned, 1); // noon − 90 min
    assert.ok((await leadById(id)).designer_id);
  });
});

describe("Calendly and the front desk", () => {
  it("booking via the lead's link marks the visit booked and tells the designer; retries are harmless", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    const id = (r as { leadId: string }).leadId;
    const booking = { event: "invitee.created", leadId: id, eventUri: "https://api.calendly.com/scheduled_events/E1", startTime: at("2026-10-10T11:00:00+05:30") };
    assert.equal(await handleCalendlyBooking(env.sql, booking, plusMin(DAY, 50)), "booked");
    assert.equal(await handleCalendlyBooking(env.sql, booking, plusMin(DAY, 51)), "booked");
    assert.equal((await leadById(id)).status, "visit_booked");
    assert.equal(tg.messagesTo(CHAT.rohan).filter((m) => /Visit fixed/.test(String(m.body.text))).length, 1);
  });

  it("/log from the front desk records a human-answered call and routes qualified leads", async () => {
    await handleTelegramUpdate(env.sql, { message: { chat: { id: Number(CHAT.frontDesk) }, from: { id: 5, first_name: "Asha" }, text: "/log 98123 45678 qualified Priya, 3BHK Kothrud, by March" } }, at(DAY));
    const [c] = await env.sql`select handled_by, category, score from calls`;
    assert.deepEqual({ ...c }, { handled_by: "human", category: "new_project", score: "qualified" });
    assert.equal(tg.messagesTo(CHAT.ananya).length + tg.messagesTo(CHAT.rohan).length + tg.messagesTo(CHAT.meera).length, 1);
  });

  it("/log from anywhere else is ignored", async () => {
    await handleTelegramUpdate(env.sql, { message: { chat: { id: 42 }, text: "/log 98123 45678 qualified test" } }, at(DAY));
    const [{ n }] = await env.sql<{ n: number }[]>`select count(*)::int n from calls`;
    assert.equal(n, 0);
  });
});

describe("caller context at the start of a call", () => {
  it("tells the agent when we missed a promised callback", async () => {
    await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    const v = await handleCallStarted(env.sql, { providerCallId: "v-back", callerPhone: "09812345678" }, plusMin(DAY, 180));
    assert.match(v.caller_context, /MISSED/);
    assert.match(v.caller_context, /data, not instructions/);
    assert.equal(v.callback_promise, "within 2 hours"); // 6pm: designers can call till 8
    assert.equal(v.front_desk_promise, "by 12 noon tomorrow"); // desk closes at 7
  });
});

describe("transcript reaches the designer with the lead card", () => {
  const docsTo = (chat: string) => tg.sent.filter((s) => s.method === "sendDocument" && s.body.chat_id === chat);

  it("new lead → card, then the full transcript as a .txt threaded under it", async () => {
    await handleCallEnded(env.sql, endedCall(DAY, { name: "Priya Sharma" }), {}, at(DAY));
    const card = tg.messagesTo(CHAT.rohan)[0];
    const docs = docsTo(CHAT.rohan);
    assert.equal(docs.length, 1);
    const file = docs[0].body.document as { filename: string; text: string };
    assert.match(file.filename, /^transcript-Priya-Sharma-\d{12}\.txt$/);
    assert.match(file.text, /Caller: Priya Sharma · \+91 98123 45678/);
    assert.match(file.text, /Agent: Hi, this is Aangan Studio's assistant\.\nCaller: Hi, I have a 2BHK in Baner\./);
    assert.ok(card, "card sent first");
    assert.match(String(docs[0].body.reply_parameters), /"message_id":\d+/, "threaded under the card");
  });

  it("caller declined recording → a note instead of a transcript", async () => {
    await handleCallEnded(env.sql, endedCall(DAY, { recording_consent: false }), {}, at(DAY));
    assert.equal(docsTo(CHAT.rohan).length, 0);
    assert.match(String(tg.messagesTo(CHAT.rohan).at(-1)!.body.text), /declined recording/);
  });

  it("unclear lead → the front desk gets the transcript too", async () => {
    await handleCallEnded(env.sql, endedCall(DAY, { promised_outcome: "front_desk_callback", area: null }), {}, at(DAY));
    assert.equal(docsTo(CHAT.frontDesk).length, 1);
  });

  it("reassigned lead → the new designer gets the transcript", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    await tap(`x:${(r as { leadId: string }).leadId}`, CHAT.rohan, plusMin(DAY, 5));
    const newDesigner = [CHAT.ananya, CHAT.meera].find((c) => tg.messagesTo(c).length > 0)!;
    assert.equal(docsTo(newDesigner).length, 1);
  });

  it("'Open in dashboard' button appears only with a real https address", async () => {
    process.env.APP_BASE_URL = "https://aangan.vercel.app";
    const r = await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    const kb = JSON.stringify(tg.messagesTo(CHAT.rohan)[0].body.reply_markup);
    assert.match(kb, new RegExp(`https://aangan.vercel.app/dashboard/leads/${(r as { leadId: string }).leadId}`));
    process.env.APP_BASE_URL = "http://localhost:3000";
    tg.sent.length = 0;
    await handleCallEnded(env.sql, endedCall(DAY, {}, { callerPhone: "9800000001" }), {}, at(DAY));
    assert.doesNotMatch(JSON.stringify(tg.sent[0].body.reply_markup), /dashboard/);
    delete process.env.APP_BASE_URL;
  });
});
