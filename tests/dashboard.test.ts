import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import { getDashboardData, getLeadDetail, parseRange } from "../lib/dashboard";
import { handleCallEnded, handleTelegramUpdate } from "../lib/leads";
import { CHAT, endedCall, fakeTelegram, startTestDb } from "./helpers";

const DAY = "2026-10-07T15:00:00+05:30";
const at = (iso: string) => new Date(iso);
const plusMin = (iso: string, m: number) => new Date(at(iso).getTime() + m * 60_000);

let env: Awaited<ReturnType<typeof startTestDb>>;
let tg: ReturnType<typeof fakeTelegram>;
beforeAll(async () => { env = await startTestDb(); });
afterAll(async () => { await env.stop(); });
beforeEach(async () => { await env.reset(); tg = fakeTelegram(); });
afterEach(() => tg.restore());

const tap = (data: string, chat: string, now: Date) =>
  handleTelegramUpdate(env.sql, { callback_query: { id: "q", from: { id: Number(chat) }, data, message: { chat: { id: Number(chat) }, message_id: 1 } } }, now);
const designerId = async (chat: string) => (await env.sql<{ id: string }[]>`select id from designers where telegram_chat_id = ${chat}`)[0].id;

describe("designer dashboard data", () => {
  it("counts a designer's own leads, callback speed and funnel — and nobody else's", async () => {
    // Two Baner leads for Rohan (one called fast, one late), one Kothrud lead for Ananya.
    const a = await handleCallEnded(env.sql, endedCall(DAY, { name: "A" }, { callerPhone: "9811111111" }), {}, at(DAY));
    const b = await handleCallEnded(env.sql, endedCall(DAY, { name: "B" }, { callerPhone: "9822222222" }), {}, at(DAY));
    await handleCallEnded(env.sql, endedCall(DAY, { name: "C", area: "Kothrud" }, { callerPhone: "9833333333" }), {}, at(DAY));
    const idA = (a as { leadId: string }).leadId;
    const idB = (b as { leadId: string }).leadId;
    const rohan = await designerId(CHAT.rohan);
    // A: called after 20 min, then visit booked. B: never called.
    await tap(`a:${idA}`, CHAT.rohan, plusMin(DAY, 5));
    await tap(`c:${idA}`, CHAT.rohan, plusMin(DAY, 20));
    await tap(`v:${idA}`, CHAT.rohan, plusMin(DAY, 25));
    // B was given to Rohan too, unless rotation sent it elsewhere; force it for the test.
    await env.sql`update leads set designer_id = ${rohan} where id = ${idB}`;

    const now = plusMin(DAY, 180); // B's 2-hour deadline has passed
    const d = await getDashboardData(env.sql, { designerId: rohan }, 30, now);
    assert.equal(d.kpis.leads, 2);
    assert.equal(d.kpis.visits, 1);
    assert.equal(d.kpis.medianCallbackMin, 20);
    assert.equal(d.kpis.onTimePct, 50); // A on time, B late
    assert.deepEqual(d.funnel.map((s) => s.count), [2, 1, 1, 0]);
    assert.deepEqual(d.speed.map((s) => s.count), [1, 0, 0, 1]);
    assert.ok(d.leads.every((l) => l.name !== "C"), "Ananya's lead must not appear");
    assert.equal(d.cost, null, "designers don't see tool cost");
    assert.equal(d.daily.at(-1)!.leads, 2);
  });

  it("admin scope sees all designers, the tool's cost and the designer list", async () => {
    await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY));
    const d = await getDashboardData(env.sql, { designerId: null }, 7, plusMin(DAY, 10));
    assert.equal(d.kpis.leads, 1);
    assert.ok(d.cost && d.cost.totalInr > 0);
    assert.equal(d.cost.perQualifiedInr, d.cost.totalInr);
    assert.equal(d.designers.length, 3);
  });

  it("a designer can't open another designer's lead", async () => {
    const r = await handleCallEnded(env.sql, endedCall(DAY), {}, at(DAY)); // Baner → Rohan
    const id = (r as { leadId: string }).leadId;
    assert.ok(await getLeadDetail(env.sql, id, { designerId: await designerId(CHAT.rohan) }));
    assert.equal(await getLeadDetail(env.sql, id, { designerId: await designerId(CHAT.meera) }), null);
    assert.equal(await getLeadDetail(env.sql, "not-a-uuid", { designerId: null }), null);
    const detail = (await getLeadDetail(env.sql, id, { designerId: null }))!;
    assert.ok(detail.events.length >= 2);
    assert.equal(detail.calls.length, 1);
  });

  it("range defaults to 30 days and only accepts 7/30/90", () => {
    assert.equal(parseRange(undefined), 30);
    assert.equal(parseRange("7"), 7);
    assert.equal(parseRange("365"), 30);
  });
});

describe("night leads called early", () => {
  it("a same-night callback counts as 0 minutes, never negative", async () => {
    const NIGHT = "2026-10-10T20:51:00+05:30"; // after hours → clock starts 10am next day
    const r = await handleCallEnded(env.sql, endedCall(NIGHT, { name: "Rahul" }, { callerPhone: "9844444444" }), {}, at(NIGHT));
    const id = (r as { leadId: string }).leadId;
    const [{ designer_id }] = await env.sql<{ designer_id: string }[]>`select designer_id from leads where id = ${id}`;
    await tap(`c:${id}`, (await env.sql<{ telegram_chat_id: string }[]>`select telegram_chat_id from designers where id = ${designer_id}`)[0].telegram_chat_id, plusMin(NIGHT, 2));
    const d = await getDashboardData(env.sql, { designerId: null }, 7, plusMin(NIGHT, 10));
    assert.equal(d.kpis.medianCallbackMin, 0);
    assert.equal(d.speed[0].count, 1); // "< 30 min"
  });
});
