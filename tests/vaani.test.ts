// Vaani Voice integration, tested with the payloads from docs.vaanivoice.ai.

import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import { callbackTimes, handleCallEnded, handleCallFinished, handleCallStarted } from "../lib/leads";
import { signVaani, verifyVaaniTool, verifyVaaniWebhook } from "../lib/security";
import { parseToolCall, parseTranscript, parseVaaniWebhook, toExtraction } from "../lib/voice/vani";
import { CHAT, fakeTelegram, startTestDb } from "./helpers";

// From https://docs.vaanivoice.ai/guides/webhook-setup (call_postprocessing example), adapted to an Aangan call.
const POSTPROCESSING = {
  event: "call_postprocessing",
  call_id: "inbound-1791620000-ab12cd34",
  timestamp: "2026-10-07T09:34:22.278854+00:00",
  data: {
    room_name: "inbound-1791620000-ab12cd34",
    call_id: "inbound-1791620000-ab12cd34",
    call_duration: 255150.02, // milliseconds in this event
    end_reason: "Call ended",
    summary: "Priya wants a full redesign of her 2BHK in Baner by March.",
    entities: {
      name: "Priya",
      area: "Baner",
      project_kind: "home",
      scope_kind: "full_home",
      intent: "design_and_execution",
      bhk: "2",
      size_sqft: "950",
      deadline_date: "2027-03-31",
      decision_maker: "self",
      budget_max_inr: "null",
      rented: "No",
      recording_consent: "Yes",
      open_questions: "Do you do false ceilings?; Is the consultation free?",
      callback_phone: "N/A",
    },
    dispositions: { category: "new_project", promised_outcome: "designer_callback", lead_score: "qualified", language: "en" },
    recording_url: "https://api.vaanivoice.ai/api/stream/inbound-1791620000-ab12cd34",
    transcript:
      "[15:00:14] AGENT: Hi, this is Aangan Studio's assistant. I'm an AI, and this call is recorded to help our designers. Is that okay?\n\n[15:00:19] USER: Yes, fine.\n\n[15:00:31] AGENT: How can I help?\n\n[15:00:33] USER: I have a 2BHK in Baner,\nabout 950 square feet.",
  },
};

describe("Vaani payloads", () => {
  it("call_started / call_ended (durations in seconds) / call_postprocessing (milliseconds)", () => {
    const s = parseVaaniWebhook({ event: "call_started", room_name: "room_123abc", status: "dialing", phone_number: "+919812345678" });
    assert.deepEqual(s, { kind: "started", event: { providerCallId: "room_123abc", callerPhone: "+919812345678" } });
    const e = parseVaaniWebhook({ event: "call_ended", room_name: "room_123abc", call_duration: 42.5, end_reason: "AGENT_REQUESTED_DISCONNECT" });
    assert.deepEqual(e, { kind: "ended", providerCallId: "room_123abc", durationSec: 43, endReason: "AGENT_REQUESTED_DISCONNECT" });
    const p = parseVaaniWebhook(POSTPROCESSING);
    assert.equal(p.kind, "postprocessed");
    if (p.kind !== "postprocessed") return;
    assert.equal(p.event.durationSec, 255);
    assert.equal(p.event.status, "completed");
    assert.equal(p.event.providerCallId, "inbound-1791620000-ab12cd34");
  });

  it("maps Vaani's string entities and dispositions onto our validated fields", () => {
    const x = toExtraction(POSTPROCESSING.data);
    assert.equal(x.bhk, 2);
    assert.equal(x.size_sqft, 950);
    assert.equal(x.budget_max_inr, null); // "null" string → null
    assert.equal(x.rented, false); // "No"
    assert.equal(x.recording_consent, true); // "Yes"
    assert.equal(x.callback_phone, null); // "N/A"
    assert.deepEqual(x.open_questions, ["Do you do false ceilings?", "Is the consultation free?"]);
    assert.equal(x.score, "qualified"); // from the lead_score disposition
    assert.equal(x.promised_outcome, "designer_callback");
    assert.match(x.summary, /Priya/); // Vaani's summary used when no summary entity
  });

  it("parses Vaani's timestamped transcript, joining wrapped lines", () => {
    const t = parseTranscript(POSTPROCESSING.data.transcript);
    assert.deepEqual(t.map((x) => x.role), ["agent", "caller", "agent", "caller"]);
    assert.equal(t[3].text, "I have a 2BHK in Baner, about 950 square feet.");
  });

  it("a call where nobody spoke is 'dropped'; unknown events are ignored", () => {
    const p = parseVaaniWebhook({ ...POSTPROCESSING, data: { ...POSTPROCESSING.data, transcript: "[15:00:14] AGENT: Hello? Hello?" } });
    assert.equal(p.kind === "postprocessed" && p.event.status, "dropped");
    assert.deepEqual(parseVaaniWebhook({ event: "call_ringing", room_name: "r" }), { kind: "ignored", name: "call_ringing" });
  });

  it("tool calls: flat JSON or wrapped args", () => {
    assert.equal(parseToolCall({ area: "Baner" }).args.area, "Baner");
    assert.equal(parseToolCall({ call_id: "c1", args: { area: "Wakad" } }).args.area, "Wakad");
    assert.equal(parseToolCall({ call_id: "c1", args: {} }).providerCallId, "c1");
  });
});

describe("Vaani security (fails closed)", () => {
  const url = (t?: string) => `https://app.example/api/voice/webhook${t ? `?token=${t}` : ""}`;
  it("accepts the secret URL token, rejects anything else", () => {
    process.env.VANI_WEBHOOK_TOKEN = "t".repeat(32);
    assert.equal(verifyVaaniWebhook("{}", new Headers(), url("t".repeat(32))), true);
    assert.equal(verifyVaaniWebhook("{}", new Headers(), url("wrong-token-wrong-token-xx")), false);
    assert.equal(verifyVaaniWebhook("{}", new Headers(), url()), false);
    process.env.VANI_WEBHOOK_TOKEN = "short";
    assert.equal(verifyVaaniWebhook("{}", new Headers(), url("short")), false, "weak tokens refused");
  });
  it("accepts Vaani's documented HMAC signature with a fresh timestamp", () => {
    process.env.VANI_WEBHOOK_SECRET = "sec";
    const now = new Date("2026-10-07T09:30:00Z");
    const ts = Math.floor(now.getTime() / 1000);
    const body = JSON.stringify(POSTPROCESSING);
    const h = (sig: string, t: number) => new Headers({ "x-vaani-signature": sig, "x-vaani-timestamp": String(t) });
    assert.equal(verifyVaaniWebhook(body, h(signVaani(body, "sec", ts), ts), url(), now), true);
    assert.equal(verifyVaaniWebhook(body, h(signVaani(body, "sec", ts - 600), ts - 600), url(), now), false, "replay");
    assert.equal(verifyVaaniWebhook(body + " ", h(signVaani(body, "sec", ts), ts), url(), now), false, "tampered");
  });
  it("tool calls need the secret header", () => {
    process.env.VANI_TOOL_SECRET = "k".repeat(32);
    assert.equal(verifyVaaniTool(new Headers({ "x-aangan-tool-key": "k".repeat(32) })), true);
    assert.equal(verifyVaaniTool(new Headers({ "x-aangan-tool-key": "nope" })), false);
    assert.equal(verifyVaaniTool(new Headers()), false);
  });
  it("callback_times gives the agent only real promises", () => {
    assert.equal(callbackTimes(new Date("2026-10-07T15:00:00+05:30")).callback_promise, "within 2 hours");
    assert.equal(callbackTimes(new Date("2026-10-07T23:00:00+05:30")).callback_promise, "by 12 noon tomorrow");
  });
});

describe("Vaani call, end to end", () => {
  let env: Awaited<ReturnType<typeof startTestDb>>;
  let tg: ReturnType<typeof fakeTelegram>;
  beforeAll(async () => { env = await startTestDb(); });
  afterAll(async () => { await env.stop(); });
  beforeEach(async () => { await env.reset(); tg = fakeTelegram(); });
  afterEach(() => tg.restore());

  it("call_started → call_ended → call_postprocessing: one lead, the caller's number from call_started, to the right designer", async () => {
    const id = POSTPROCESSING.call_id;
    await handleCallStarted(env.sql, { providerCallId: id, callerPhone: "+919812345678" }, new Date("2026-10-07T15:00:00+05:30"));
    await handleCallFinished(env.sql, id, 255, new Date("2026-10-07T15:04:15+05:30"));
    const p = parseVaaniWebhook(POSTPROCESSING);
    if (p.kind !== "postprocessed") throw new Error("expected postprocessed");
    const r = await handleCallEnded(env.sql, p.event, {}, new Date("2026-10-07T15:04:30+05:30"));
    assert.equal(r.kind, "lead");
    const [lead] = await env.sql`select phone, name, status, open_questions from leads`;
    assert.equal(lead.phone, "+919812345678", "number kept from call_started");
    assert.equal(lead.status, "assigned");
    assert.deepEqual(lead.open_questions, ["Do you do false ceilings?", "Is the consultation free?"]);
    assert.equal(tg.messagesTo(CHAT.rohan).length, 1); // Baner → Rohan
    const again = await handleCallEnded(env.sql, p.event, {}, new Date("2026-10-07T15:05:00+05:30"));
    assert.equal(again.kind, "duplicate", "Vaani retries are harmless");
  });
});

describe("browser test calls (no caller number)", () => {
  let env: Awaited<ReturnType<typeof startTestDb>>;
  let tg: ReturnType<typeof fakeTelegram>;
  beforeAll(async () => { env = await startTestDb(); });
  afterAll(async () => { await env.stop(); });
  beforeEach(async () => { await env.reset(); tg = fakeTelegram(); });
  afterEach(() => tg.restore());

  it("a qualified web-test call reaches the designer without a review flag", async () => {
    const id = "webrtc-test-001";
    await handleCallStarted(env.sql, { providerCallId: id, callerPhone: "" }, new Date("2026-10-07T15:00:00+05:30"));
    const p = parseVaaniWebhook({ ...POSTPROCESSING, call_id: id, data: { ...POSTPROCESSING.data, call_id: id, room_name: id } });
    if (p.kind !== "postprocessed") throw new Error("expected postprocessed");
    const r = await handleCallEnded(env.sql, p.event, {}, new Date("2026-10-07T15:04:30+05:30"));
    assert.equal(r.kind === "lead" && r.route, "designer");
    assert.equal(tg.messagesTo(CHAT.rohan).length, 1);
    const [lead] = await env.sql`select phone, needs_review, review_reason from leads`;
    assert.equal(lead.phone, "unknown");
    assert.equal(lead.needs_review, false);
  });
});

describe("browser test calls pulled from Vaani's API (no webhook)", () => {
  let env: Awaited<ReturnType<typeof startTestDb>>;
  let tg: ReturnType<typeof fakeTelegram>;
  let details: Record<string, unknown>;
  beforeAll(async () => { env = await startTestDb(); });
  afterAll(async () => { await env.stop(); });
  beforeEach(async () => {
    await env.reset();
    tg = fakeTelegram();
    process.env.VANI_API_KEY = "test-key";
    const tgFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://api.vaanivoice.ai/api/call_details/")) return new Response(JSON.stringify(details));
      if (u.startsWith("https://api.vaanivoice.ai/api/transcript/")) return new Response(JSON.stringify({ transcript: "not found" }), { status: 404 });
      return tgFetch(url, init);
    }) as typeof fetch;
  });
  afterEach(() => tg.restore());

  it("waits while Vaani is still processing, then makes the lead and reaches the designer once", async () => {
    const { importWebCall } = await import("../lib/voice/import");
    const id = "webrtc-1791644542-d03c98c1";
    await handleCallStarted(env.sql, { providerCallId: id, callerPhone: "" }, new Date("2026-10-10T15:00:00+05:30"));
    await handleCallFinished(env.sql, id, 200, new Date("2026-10-10T15:03:20+05:30"));

    details = { transcription: "Transcription not available yet", entity: "not available", summary: "not available", call_eval_tag: null };
    assert.equal((await importWebCall(env.sql, id, new Date("2026-10-10T15:03:30+05:30"))).state, "waiting");

    details = { transcription: POSTPROCESSING.data.transcript, entity: { ...POSTPROCESSING.data.entities, ...POSTPROCESSING.data.dispositions }, summary: POSTPROCESSING.data.summary, call_eval_tag: null };
    const r = await importWebCall(env.sql, id, new Date("2026-10-10T15:04:00+05:30"));
    assert.equal(r.state, "done");
    assert.equal(tg.messagesTo(CHAT.rohan).length, 1); // Baner → Rohan
    const [call] = await env.sql`select duration_sec, transcript is not null as has_t from calls where vani_call_id = ${id}`;
    assert.equal(call.duration_sec, 200);
    assert.equal(call.has_t, true);
    assert.equal((await importWebCall(env.sql, id, new Date("2026-10-10T15:05:00+05:30"))).state, "done"); // idempotent
    assert.equal(tg.messagesTo(CHAT.rohan).length, 1);
    assert.equal((await importWebCall(env.sql, "webrtc-1-abc", new Date())).state, "unknown");
  });
});

describe("call length when Vaani sends no duration", () => {
  it("falls back to the transcript's timestamps (and handles midnight)", async () => {
    const { transcriptSpanSec } = await import("../lib/voice/vani");
    const p = parseVaaniWebhook({ ...POSTPROCESSING, data: { ...POSTPROCESSING.data, call_duration: undefined } });
    assert.equal(p.kind === "postprocessed" && p.event.durationSec, 19); // 15:00:14 → 15:00:33
    assert.equal(transcriptSpanSec("[23:59:50] AGENT: hi\n[00:00:10] USER: hello"), 20);
    assert.equal(transcriptSpanSec("AGENT: no stamps"), 0);
    const e = parseVaaniWebhook({ event: "call_ended", room_name: "r1", duration_ms: 95_000 });
    assert.equal(e.kind === "ended" && e.durationSec, 95);
  });
});
