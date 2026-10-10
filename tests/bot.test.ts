import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import { heuristicIntent, IntentSchema } from "../lib/bot";
import { handleCallEnded, handleTelegramUpdate } from "../lib/leads";
import { CHAT, endedCall, fakeTelegram, startTestDb } from "./helpers";

const DAY = "2026-10-07T15:00:00+05:30";
const at = (iso: string) => new Date(iso);

describe("understanding questions without Gemini (commands + keyword fallback)", () => {
  const cases: [string, string, string?][] = [
    ["/today", "summary"],
    ["/pending", "waiting"],
    ["/lead Priya", "lead"],
    ["how many qualified leads this week?", "summary"],
    ["who is waiting for a call?", "waiting"],
    ["show Priya's lead", "lead"],
    ["what did the system cost this month?", "cost"],
    ["aaj kitne leads aaye?", "summary"],
    ["write me a poem", "unsupported"],
  ];
  for (const [q, intent] of cases) {
    it(`"${q}" → ${intent}`, () => assert.equal(heuristicIntent(q).intent, intent));
  }
  it("reads periods and names", () => {
    assert.equal(heuristicIntent("leads today").period, "today");
    assert.equal(heuristicIntent("cost this month").period, "month");
    assert.equal(heuristicIntent("show Priya's lead").query, "Priya");
  });
  it("a classifier's JSON can't escape the fixed lookups", () => {
    const i = IntentSchema.parse({ intent: "run_sql", period: "forever", query: "x".repeat(500), filter: "drop table" });
    assert.deepEqual([i.intent, i.period, i.filter, i.query!.length], ["unsupported", "week", null, 60]);
  });
});

describe("the bot answers from the database, scoped to who's asking", () => {
  let env: Awaited<ReturnType<typeof startTestDb>>;
  let tg: ReturnType<typeof fakeTelegram>;
  beforeAll(async () => { env = await startTestDb(); });
  afterAll(async () => { await env.stop(); });
  beforeEach(async () => {
    await env.reset();
    tg = fakeTelegram();
    await handleCallEnded(env.sql, endedCall(DAY, { name: "Priya" }, { callerPhone: "9811111111" }), {}, at(DAY)); // Baner → Rohan
    await handleCallEnded(env.sql, endedCall(DAY, { name: "Meghna", area: "Kharadi" }, { callerPhone: "9822222222" }), {}, at(DAY)); // → Meera
    tg.sent.length = 0;
  });
  afterEach(() => tg.restore());

  const ask = async (chat: string, text: string, classify?: Parameters<typeof handleTelegramUpdate>[3]) => {
    await handleTelegramUpdate(env.sql, { message: { chat: { id: Number(chat) }, text } }, at("2026-10-07T15:30:00+05:30"), classify);
    return String(tg.sent.at(-1)?.body.text ?? "");
  };

  it("Nikhil gets studio-wide numbers that match the database", async () => {
    const a = await ask(CHAT.nikhil, "/today");
    assert.match(a, /Studio · today/);
    assert.match(a, /Leads: <b>2<\/b>/);
    assert.match(a, /Waiting for a call now: <b>2<\/b>/);
  });

  it("a designer sees only their own leads", async () => {
    assert.match(await ask(CHAT.rohan, "/today"), /Your leads · today[\s\S]*Leads: <b>1<\/b>/);
    assert.match(await ask(CHAT.rohan, "/lead Priya"), /Priya/);
    assert.match(await ask(CHAT.rohan, "/lead Meghna"), /No lead matching “Meghna” among your leads/);
    assert.match(await ask(CHAT.rohan, "/pending"), /Priya/);
    assert.doesNotMatch(await ask(CHAT.rohan, "/pending"), /Meghna/);
  });

  it("cost and team numbers are for Nikhil and the front desk only", async () => {
    assert.match(await ask(CHAT.rohan, "/cost"), /for Nikhil and the front desk/);
    assert.match(await ask(CHAT.rohan, "/designers"), /for Nikhil and the front desk/);
    assert.match(await ask(CHAT.nikhil, "/cost"), /System cost[\s\S]*Total: <b>₹/);
    assert.match(await ask(CHAT.frontDesk, "/designers"), /Rohan Joshi/);
  });

  it("a stranger gets no answer at all", async () => {
    await ask("424242", "how many leads today?");
    assert.equal(tg.sent.length, 0);
  });

  it("uses Gemini to classify, logs its cost, and still answers from data", async () => {
    const classify = async () => ({ intent: IntentSchema.parse({ intent: "waiting" }), inputTokens: 1000, outputTokens: 50 });
    const a = await ask(CHAT.nikhil, "kaun kaun abhi call ka wait kar raha hai?", { classify });
    assert.match(a, /Waiting for a call \(2\)/);
    const [u] = await env.sql<{ n: number; cost: string }[]>`select count(*)::int n, sum(cost_inr)::text cost from ai_usage`;
    assert.equal(u.n, 1);
    assert.ok(Number(u.cost) > 0);
  });

  it("falls back to keywords if Gemini fails", async () => {
    const classify = async () => { throw new Error("quota"); };
    assert.match(await ask(CHAT.nikhil, "who is waiting for a call?", { classify }), /Waiting for a call/);
  });

  it("off-topic questions get the help text, never an invented answer", async () => {
    const classify = async () => ({ intent: IntentSchema.parse({ intent: "unsupported" }), inputTokens: 10, outputTokens: 5 });
    assert.match(await ask(CHAT.nikhil, "what's the per sq ft rate?", { classify }), /I can only answer questions about leads/);
  });
});
