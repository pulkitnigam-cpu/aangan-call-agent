// Builds the report on how the application behaved on the sample calls:
//
//   npm run report                    # all AI-handled calls
//   npm run report -- 2026-10-11      # only calls since a date
//
// Reads GET {APP_BASE_URL}/api/admin/report (Bearer CRON_SECRET) and writes
// docs/sample-calls-report.md (+ .json with everything, for your own analysis).

import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";

config({ path: [".env.local", ".env"], quiet: true });

const base = process.env.APP_BASE_URL;
const secret = process.env.CRON_SECRET;
if (!base?.startsWith("https://") || !secret) throw new Error("Set APP_BASE_URL (https) and CRON_SECRET in .env.local");

type Qa = {
  aiDisclosed: boolean; consentAsked: boolean; priceMentions: string[]; underCap: boolean | null;
  mustHaves: Record<string, boolean>; mustHavesCaptured: number; promiseMatchesRules: boolean | null; passed: boolean;
};
type Call = {
  callId: string; startedAt: string; durationSec: number | null; status: string; category: string | null; language: string | null;
  recordingConsent: boolean | null; promisedOutcome: string | null; costInr: number; escalate: boolean;
  lead: null | Record<string, unknown> & { rulesScore: string; vaaniScore: string | null; vaaniReason: string | null; routedTo: string; reasons: string[]; notes: string[]; openQuestions: string[]; reviewReason: string | null };
  qa: Qa; transcript: string | null;
};

const yes = (b: boolean | null) => (b === null ? "—" : b ? "✅" : "❌");
const ist = (d: string) => new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const dur = (s: number | null) => (s === null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
const cell = (v: unknown) => String(v ?? "—").replace(/\|/g, "/").replace(/\n/g, " ");

async function main() {
  const since = process.argv[2];
  const url = `${base!.replace(/\/+$/, "")}/api/admin/report${since ? `?since=${encodeURIComponent(since)}` : ""}`;
  // First pull any browser test call that finished but wasn't fetched from Vaani yet.
  const imp = await fetch(`${base!.replace(/\/+$/, "")}/api/admin/import`, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  if (imp.ok) {
    const { imported } = (await imp.json()) as { imported: { state: string }[] };
    if (imported.length) console.log(`pulled from Vaani: ${imported.filter((x) => x.state === "done").length}/${imported.length} pending calls`);
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`report endpoint → ${res.status}`);
  const { summary: s, calls, generatedAt } = (await res.json()) as { summary: Record<string, unknown>; calls: Call[]; generatedAt: string };

  const summary = [
    `| Measure | Result |`,
    `|---|---|`,
    `| Calls | ${s.calls} (${s.completed} completed, ${s.dropped} dropped/failed) |`,
    `| New projects → qualified / unclear / not a fit | ${(s.byScore as Record<string, number>).qualified} / ${(s.byScore as Record<string, number>).unclear} / ${(s.byScore as Record<string, number>).not_fit} |`,
    `| Other calls (existing client / vendor / spam) | ${(s.byCategory as Record<string, number>).existing_client} / ${(s.byCategory as Record<string, number>).vendor} / ${(s.byCategory as Record<string, number>).spam} |`,
    `| **All hard guardrails held** (AI disclosure, consent, no price, ≤ 4 min) | **${s.guardrailsPassed}/${s.calls}** |`,
    `| Said it's an AI at the start | ${s.aiDisclosed}/${s.calls} |`,
    `| Asked recording consent at the start | ${s.consentAsked}/${s.calls} |`,
    `| Calls where the agent said a price | **${s.priceLeaks}** (target 0) |`,
    `| Calls over the 4-minute cap | ${s.overCap} |`,
    `| What the caller was told matches Nikhil's rules | ${s.promiseMatchesRules} |`,
    `| Vaani's own score agrees with the rules | ${s.rulesVsVaani} |`,
    `| Must-haves captured per new-project call (of 5) | ${s.avgMustHaves ?? "—"} |`,
    `| Average call length | ${dur(s.avgDurationSec as number | null)} |`,
    `| AI cost for all calls | ₹${s.totalCostInr} |`,
  ].join("\n");

  const table = [
    "| # | When | Lang | Length | Type | Rules score | Vaani score | Told caller | Routed to | Must-haves | Guardrails | Why |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...calls.map((c, i) =>
      `| ${i + 1} | ${ist(c.startedAt)} | ${c.language ?? "—"} | ${dur(c.durationSec)} | ${c.category ?? c.status} | ${c.lead?.rulesScore ?? "—"} | ${c.lead?.vaaniScore ?? "—"} | ${c.promisedOutcome ?? "—"} | ${c.lead?.routedTo ?? "—"} | ${c.lead ? `${c.qa.mustHavesCaptured}/5` : "—"} | ${c.qa.passed ? "✅" : `❌${c.qa.priceMentions.length ? " price" : ""}${c.qa.underCap === false ? " >4min" : ""}${!c.qa.aiDisclosed ? " no-AI" : ""}${!c.qa.consentAsked ? " no-consent" : ""}`} | ${cell(c.lead?.vaaniReason ?? c.lead?.reasons?.join("; ") ?? "")} |`,
    ),
  ].join("\n");

  const details = calls
    .map((c, i) => {
      const l = c.lead;
      const facts = l
        ? `- **Caller:** ${cell(l.name)} · **Area:** ${cell(l.area)} · **Space:** ${cell(l.project_kind)} ${l.bhk ? `${l.bhk}BHK` : ""} ${l.size_sqft ? `${l.size_sqft} sq ft` : ""}\n- **Scope:** ${cell(l.scope)} (${cell(l.intent)}) · **Timeline:** ${cell(l.timeline)}${l.deadline_date ? ` (${l.deadline_date})` : ""} · **Decision:** ${cell(l.decision_maker)}\n- **Score:** rules **${l.rulesScore}** · Vaani ${cell(l.vaaniScore)} · agent ${cell(l.agentScore)} · told caller: ${cell(c.promisedOutcome)} · **routed to:** ${l.routedTo}\n${l.reasons?.length ? `- **Why:** ${l.reasons.join("; ")}\n` : ""}${l.notes?.length ? `- **Notes for designer:** ${l.notes.join("; ")}\n` : ""}${l.openQuestions?.length ? `- **Caller asked:** ${l.openQuestions.join("; ")}\n` : ""}${l.reviewReason ? `- **Review:** ${l.reviewReason}\n` : ""}`
        : `- ${c.category ?? c.status}${c.escalate ? " — escalated" : ""}\n`;
      const qa = `- **Guardrails:** AI disclosed ${yes(c.qa.aiDisclosed)} · consent asked ${yes(c.qa.consentAsked)} · no price ${yes(c.qa.priceMentions.length === 0)}${c.qa.priceMentions.length ? ` (said: ${c.qa.priceMentions.join(", ")})` : ""} · ≤ 4 min ${yes(c.qa.underCap)} · promise matches rules ${yes(c.qa.promiseMatchesRules)}`;
      return `### ${i + 1}. ${ist(c.startedAt)} · ${dur(c.durationSec)} · \`${c.callId}\`\n\n${facts}${qa}\n\n<details><summary>Transcript</summary>\n\n\`\`\`\n${c.transcript ?? (c.recordingConsent === false ? "(caller declined recording — no transcript kept)" : "(no transcript)")}\n\`\`\`\n\n</details>\n`;
    })
    .join("\n");

  const md = `# Sample calls report\n\nGenerated ${ist(generatedAt)} IST by \`npm run report\` from the live app.${since ? ` Calls since ${since}.` : ""}\n\n## Summary\n\n${summary}\n\n## All calls\n\n${table}\n\n## Each call\n\n${details}`;
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/sample-calls-report.md", md);
  writeFileSync("docs/sample-calls-report.json", JSON.stringify({ generatedAt, summary: s, calls }, null, 2));
  console.log(`${calls.length} calls → docs/sample-calls-report.md (+ .json)\n`);
  console.log(summary);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
