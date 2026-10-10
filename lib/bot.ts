// The Telegram data bot: plain questions, safe answers.
//
//   "how many qualified leads this week?"  "who's waiting for a call?"
//   "show Priya's lead"  "what did the system cost this month?"
//
// Strict by design: Gemini only CLASSIFIES the question into one of a fixed
// set of lookups (validated with zod). The answer is built by code from the
// database — the LLM never writes an answer, so it can't invent a number.
// Who sees what: Nikhil, the front desk group and admins see everything;
// a designer sees only their own leads; anyone else gets nothing.

import type postgres from "postgres";
import { z } from "zod";
import { tokenCostInr } from "./cost";
import { fmtMinutes } from "./format";
import { esc, fmtPhone, fmtTime, frontDeskChat, leadCardText, nikhilChat } from "./telegram";
import type { Lead } from "./types";

type Sql = postgres.Sql;

export type Asker =
  | { kind: "all"; actor: "nikhil" | "frontdesk" }
  | { kind: "designer"; designerId: string; name: string };

export async function identifyAsker(sql: Sql, chatId: string): Promise<Asker | null> {
  if (chatId && chatId === nikhilChat()) return { kind: "all", actor: "nikhil" };
  if (chatId && chatId === frontDeskChat()) return { kind: "all", actor: "frontdesk" };
  const [d] = await sql<{ id: string; name: string }[]>`select id, name from designers where telegram_chat_id = ${chatId} and active`;
  return d ? { kind: "designer", designerId: d.id, name: d.name } : null;
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

export const INTENTS = ["summary", "waiting", "lead", "list", "cost", "designers", "help", "unsupported"] as const;
export const PERIODS = ["today", "week", "month", "quarter"] as const;
export const FILTERS = ["qualified", "unclear", "not_fit", "visit_booked", "won", "lost"] as const;

export const IntentSchema = z.object({
  intent: z.enum(INTENTS).catch("unsupported"),
  period: z.enum(PERIODS).catch("week"),
  query: z
    .preprocess((v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : null), z.string().nullable())
    .catch(null),
  filter: z.enum(FILTERS).nullable().catch(null),
});
export type Intent = z.infer<typeof IntentSchema>;

/** Keyword fallback, used for /commands and whenever Gemini is unavailable. */
export function heuristicIntent(text: string): Intent {
  const t = text.toLowerCase().trim();
  const period: Intent["period"] = /today|aaj/.test(t) ? "today" : /month|mahina|30/.test(t) ? "month" : /quarter|90/.test(t) ? "quarter" : "week";
  const filter: Intent["filter"] =
    /not.?fit/.test(t) ? "not_fit" : /unclear/.test(t) ? "unclear" : /visit/.test(t) ? "visit_booked" : /\bwon\b|closed/.test(t) ? "won" : /\blost\b/.test(t) ? "lost" : /qualified/.test(t) ? "qualified" : null;

  const original = text.trim(); // keep the caller's capitalisation for names
  const cmd = original.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/);
  if (cmd) {
    const c = cmd[1].toLowerCase();
    const rest = cmd[2];
    if (c === "today" || c === "week" || c === "month") return { intent: "summary", period: c, query: null, filter: null };
    if (c === "pending" || c === "waiting") return { intent: "waiting", period, query: null, filter: null };
    if (c === "lead") return { intent: "lead", period, query: rest.trim() || null, filter: null };
    if (c === "cost") return { intent: "cost", period: rest.toLowerCase().includes("today") ? "today" : rest.toLowerCase().includes("week") ? "week" : "month", query: null, filter: null };
    if (c === "designers" || c === "team") return { intent: "designers", period, query: null, filter: null };
    if (c === "leads" || c === "list") return { intent: "list", period, query: null, filter };
    return { intent: "help", period, query: null, filter: null };
  }
  if (/help|what can you/.test(t)) return { intent: "help", period, query: null, filter: null };
  if (/cost|spend|kharcha|₹|rupee/.test(t)) return { intent: "cost", period, query: null, filter: null };
  if (/waiting|pending|to call|call back|callback due|overdue|late/.test(t)) return { intent: "waiting", period, query: null, filter: null };
  if (/designer|team|who.*(best|most)/.test(t)) return { intent: "designers", period, query: null, filter: null };
  const lead = original.match(/(?:lead|show|about|find|details?)\s+(?:for\s+|of\s+)?([a-z][a-z .']{1,40}?)(?:'s)?(?:\s+lead)?\??$/i) ?? t.match(/(\+?\d[\d\s-]{7,})/);
  if (lead) return { intent: "lead", period, query: lead[1].trim(), filter: null };
  if (/list|which|show/.test(t)) return { intent: "list", period, query: null, filter };
  if (/how many|count|numbers|summary|stats|kitne|leads|calls/.test(t)) return { intent: "summary", period, query: null, filter };
  return { intent: "unsupported", period, query: null, filter: null };
}

export type Classifier = (text: string) => Promise<{ intent: Intent; inputTokens: number; outputTokens: number }>;

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

function since(period: Intent["period"], now: Date): Date {
  if (period === "today") {
    const ist = new Date(now.getTime() + 330 * 60_000);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000);
  }
  return new Date(now.getTime() - { week: 7, month: 30, quarter: 90 }[period] * 86_400_000);
}
const PERIOD_LABEL = { today: "today", week: "last 7 days", month: "last 30 days", quarter: "last 90 days" } as const;

export const HELP = [
  "<b>Ask me in plain words</b>, e.g.",
  "• how many qualified leads this week?",
  "• who is waiting for a call?",
  "• show Priya's lead",
  "• what did the system cost this month?",
  "",
  "Or: /today /week /month /pending /lead &lt;name&gt; /cost /designers",
].join("\n");

export async function answerQuestion(sql: Sql, asker: Asker, text: string, classify: Classifier | undefined, now: Date): Promise<string> {
  let intent: Intent;
  if (text.trim().startsWith("/") || !classify) {
    intent = heuristicIntent(text);
  } else {
    try {
      const r = await classify(text);
      intent = r.intent;
      await sql`
        insert into ai_usage (kind, actor, input_tokens, output_tokens, cost_inr)
        values ('bot_question', ${asker.kind === "all" ? asker.actor : asker.designerId}, ${r.inputTokens}, ${r.outputTokens},
                ${tokenCostInr({ inputTokens: r.inputTokens, outputTokens: r.outputTokens })})
      `;
    } catch (err) {
      console.error("[bot] classifier failed; using keywords", err instanceof Error ? err.message : err);
      intent = heuristicIntent(text);
    }
  }

  const mine = asker.kind === "designer" ? sql`and l.designer_id = ${asker.designerId}` : sql``;
  const from = since(intent.period, now);
  const when = PERIOD_LABEL[intent.period];

  switch (intent.intent) {
    case "help":
      return HELP;
    case "unsupported":
      return `I can only answer questions about leads, callbacks, visits and costs.\n\n${HELP}`;

    case "summary": {
      const [s] = await sql<{ leads: number; qualified: number; unclear: number; not_fit: number; visits: number; won: number; waiting: number; median: number | null }[]>`
        select count(*)::int as leads,
          count(*) filter (where l.score = 'qualified')::int as qualified,
          count(*) filter (where l.score = 'unclear')::int as unclear,
          count(*) filter (where l.score = 'not_fit')::int as not_fit,
          count(*) filter (where l.status in ('visit_booked', 'visit_done', 'won'))::int as visits,
          count(*) filter (where l.status = 'won')::int as won,
          count(*) filter (where l.status = 'assigned' and l.first_action_at is null)::int as waiting,
          percentile_cont(0.5) within group (order by extract(epoch from (l.first_action_at - greatest(l.assigned_at, l.due_at - interval '2 hours'))) / 60)
            filter (where l.first_action_at is not null) as median
        from leads l where l.created_at >= ${from} ${mine}
      `;
      const [c] = asker.kind === "all"
        ? await sql<{ calls: number }[]>`select count(*)::int as calls from calls where started_at >= ${from}`
        : [{ calls: -1 }];
      const head = asker.kind === "designer" ? `<b>Your leads · ${when}</b>` : `<b>Studio · ${when}</b>`;
      const lines = [
        head,
        c.calls >= 0 ? `📞 Calls: <b>${c.calls}</b>` : null,
        `🧾 Leads: <b>${s.leads}</b>${asker.kind === "all" ? ` (✅ ${s.qualified} qualified · ❔ ${s.unclear} unclear · ✖️ ${s.not_fit} not a fit)` : ""}`,
        `📅 Visits booked: <b>${s.visits}</b>${s.won ? ` · 🏆 won ${s.won}` : ""}`,
        `⏱ Median callback: <b>${fmtMinutes(s.median === null ? null : Math.round(Number(s.median)))}</b>`,
        `⏳ Waiting for a call now: <b>${s.waiting}</b>`,
      ];
      return lines.filter(Boolean).join("\n");
    }

    case "waiting": {
      const rows = await sql<(Lead & { designer_name: string | null })[]>`
        select l.*, d.name as designer_name from leads l left join designers d on d.id = l.designer_id
        where l.status = 'assigned' and l.first_action_at is null ${mine}
        order by l.due_at asc limit 10
      `;
      if (!rows.length) return "Nobody is waiting for a call. 🎉";
      return [
        `<b>Waiting for a call (${rows.length})</b>`,
        ...rows.map((l) => {
          const late = l.due_at && l.due_at < now;
          return `${late ? "🔴 late" : "🟢"} <b>${esc(l.name ?? "Unnamed")}</b> · ${esc(fmtPhone(l.phone))} · by ${fmtTime(l.due_at)}${asker.kind === "all" && l.designer_name ? ` · ${esc(l.designer_name)}` : ""}`;
        }),
      ].join("\n");
    }

    case "lead": {
      const q = (intent.query ?? "").trim();
      if (q.length < 2) return "Whose lead? e.g. <code>/lead Priya</code> or <code>/lead 98123 45678</code>";
      const digits = q.replace(/\D/g, "");
      const rows = await sql<Lead[]>`
        select l.* from leads l
        where (${digits.length >= 6 ? sql`l.phone like ${`%${digits.slice(-10)}%`}` : sql`l.name ilike ${`%${q.replace(/[%_]/g, "")}%`}`}) ${mine}
        order by coalesce(l.last_call_at, l.created_at) desc limit 5
      `;
      if (!rows.length) return asker.kind === "designer" ? `No lead matching “${esc(q)}” among your leads.` : `No lead matching “${esc(q)}”.`;
      if (rows.length > 1) {
        return [`<b>${rows.length} matches</b> — be more specific:`, ...rows.map((l) => `• ${esc(l.name ?? "Unnamed")} · ${esc(l.area ?? "—")} · ${esc(fmtPhone(l.phone))}`)].join("\n");
      }
      return leadCardText(rows[0], `📇 <b>Lead</b> · ${esc(rows[0].status.replace("_", " "))}`);
    }

    case "list": {
      const f = intent.filter;
      const cond = !f ? sql``
        : ["qualified", "unclear", "not_fit"].includes(f) ? sql`and l.score = ${f}`
        : sql`and l.status = ${f}`;
      const rows = await sql<Lead[]>`
        select l.* from leads l where l.created_at >= ${from} ${mine} ${cond}
        order by l.created_at desc limit 10
      `;
      if (!rows.length) return `No ${f ? f.replace("_", " ") + " " : ""}leads in the ${when}.`;
      return [
        `<b>${f ? f.replace("_", " ") : "Recent"} leads · ${when}</b>`,
        ...rows.map((l) => `• <b>${esc(l.name ?? "Unnamed")}</b> · ${esc(l.area ?? "—")} · ${esc(l.status.replace("_", " "))}`),
      ].join("\n");
    }

    case "cost": {
      if (asker.kind !== "all") return "Cost figures are for Nikhil and the front desk.";
      const [c] = await sql<{ calls_cost: string; bot_cost: string; calls: number; minutes: number; qualified: number }[]>`
        select coalesce((select sum(cost_inr) from calls where started_at >= ${from}), 0)::text as calls_cost,
               coalesce((select sum(cost_inr) from ai_usage where at >= ${from}), 0)::text as bot_cost,
               (select count(*)::int from calls where started_at >= ${from} and handled_by = 'ai') as calls,
               coalesce((select sum(ceil(duration_sec / 60.0))::int from calls where started_at >= ${from} and handled_by = 'ai'), 0) as minutes,
               (select count(*)::int from leads where created_at >= ${from} and score = 'qualified') as qualified
      `;
      const total = Number(c.calls_cost) + Number(c.bot_cost);
      return [
        `<b>System cost · ${when}</b>`,
        `💰 Total: <b>₹${total.toFixed(2)}</b>`,
        `📞 ${c.calls} AI calls · ${c.minutes} min`,
        `🧾 Per qualified lead: <b>${c.qualified ? `₹${(total / c.qualified).toFixed(2)}` : "—"}</b>`,
        `🤖 Bot questions: ₹${Number(c.bot_cost).toFixed(2)}`,
      ].join("\n");
    }

    case "designers": {
      if (asker.kind !== "all") return "Team numbers are for Nikhil and the front desk. Try “my numbers this week”.";
      const rows = await sql<{ name: string; leads: number; waiting: number; on_time: number | null }[]>`
        select d.name, count(l.id)::int as leads,
          count(l.id) filter (where l.status = 'assigned' and l.first_action_at is null)::int as waiting,
          round(100.0 * count(l.id) filter (where l.first_action_at <= l.due_at)
            / nullif(count(l.id) filter (where l.first_action_at is not null or l.due_at < ${now}), 0)) as on_time
        from designers d left join leads l on l.designer_id = d.id and l.created_at >= ${from}
        where d.active group by d.name order by leads desc
      `;
      return [`<b>Designers · ${when}</b>`, ...rows.map((r) => `• <b>${esc(r.name)}</b>: ${r.leads} leads · ${r.on_time === null ? "—" : `${r.on_time}%`} on time${r.waiting ? ` · ${r.waiting} waiting` : ""}`)].join("\n");
    }
  }
}
