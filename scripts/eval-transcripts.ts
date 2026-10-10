// Runs all 40 September 2026 enquiries (knowledge/sep-2026-enquiries.txt, the
// text of Nikhil's PDF) through the REAL pipeline — Gemini extraction, then
// Nikhil's rules (lib/policy.ts) — and compares with the labelled expected
// outcome (tests/fixtures/sep-2026-enquiries.ts).
//
//   npm run eval              # needs GEMINI_API_KEY in .env.local
//
// Prints a table and writes docs/eval-report.md: expected vs predicted score,
// missing must-have fields for qualified leads, and any price-like phrase the
// studio side said (in these transcripts that's the human front desk — the AI
// agent's own calls are checked the same way after every call).

import { config } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractFromTranscript, type ExtractedLead } from "../lib/gemini";
import { findPriceMentions, scoreLead } from "../lib/policy";
import { ENQUIRIES } from "../tests/fixtures/sep-2026-enquiries";

config({ path: [".env.local", ".env"], quiet: true });
if (!process.env.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY in .env.local");

interface Enquiry {
  id: string;
  channel: string;
  header: string;
  body: string;
}

function parseEnquiries(text: string): Enquiry[] {
  const lines = text.split("\n");
  const out: Enquiry[] = [];
  let cur: Enquiry | null = null;
  for (const line of lines) {
    const h = line.match(/^((?:T|W|F)\d{2}) · (Phone|WhatsApp|Web Form) · (.*)$/);
    if (h) {
      if (cur) out.push(cur);
      cur = { id: h[1], channel: h[2], header: line, body: "" };
    } else if (cur && !/^SECTION \d/.test(line)) {
      cur.body += `${line}\n`;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const STUDIO_LINE = /^(Front Desk|\d{1,2} Sept, [\d:apm]+ — Front Desk):/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function extractWithRetry(transcript: string, at: Date) {
  for (let i = 0; ; i++) {
    try {
      return await extractFromTranscript(transcript, at);
    } catch (err) {
      if (i >= 3) throw err;
      await sleep(4000 * (i + 1)); // rate limits on free keys
    }
  }
}

const mustHaves = (e: ExtractedLead) =>
  [
    ["name", e.name],
    ["area", e.area],
    ["size or BHK", e.size_sqft ?? e.bhk],
    ["scope", e.scope ?? (e.scope_kind !== "unknown" ? e.scope_kind : null)],
    ["timeline", e.timeline ?? e.deadline_date],
  ]
    .filter(([, v]) => v === null || v === undefined || v === "")
    .map(([k]) => k as string);

async function main() {
  const text = readFileSync("knowledge/sep-2026-enquiries.txt", "utf8");
  const enquiries = parseEnquiries(text);
  if (enquiries.length !== 40) throw new Error(`expected 40 enquiries, found ${enquiries.length}`);
  const expected = new Map(ENQUIRIES.map((e) => [e.id, e]));

  type Row = {
    id: string;
    channel: string;
    expected: string;
    predicted: string;
    gemini: string;
    match: boolean;
    missing: string[];
    priceSaid: string[];
    note: string;
  };
  const rows: Row[] = [];
  let tokens = 0;
  const started = Date.now();

  const queue = [...enquiries];
  const worker = async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      const fx = expected.get(q.id)!;
      const at = new Date(fx.at);
      // A turn can wrap onto several lines; join continuation lines into their turn first.
      const turns: string[] = [];
      for (const line of q.body.split("\n")) {
        if (/^([A-Z][\w ]{1,20}|\d{1,2} Sept, [\d:apm]+ — [\w ]+):/.test(line) || !turns.length) turns.push(line);
        else turns[turns.length - 1] += ` ${line}`;
      }
      const studioSaid = turns.filter((t) => STUDIO_LINE.test(t)).join("\n");
      const priceSaid = findPriceMentions(studioSaid);
      const content = `Channel: ${q.channel}\n${q.header}\n\n${q.body.trim()}`;

      if (fx.expected === "missed_call") {
        rows.push({ id: q.id, channel: q.channel, expected: "missed call", predicted: "missed call", gemini: "—", match: true, missing: [], priceSaid, note: "no conversation; system follows up" });
        continue;
      }
      const r = await extractWithRetry(content, at);
      tokens += r.inputTokens + r.outputTokens;
      const e = r.extraction;
      if (fx.expected === "existing_client_escalate") {
        const ok = e.category === "existing_client";
        rows.push({ id: q.id, channel: q.channel, expected: "existing client (escalate)", predicted: `${e.category}${e.escalate ? " (escalate)" : ""}`, gemini: e.score ?? "—", match: ok && e.escalate, missing: [], priceSaid, note: e.escalation_reason ?? "" });
        continue;
      }
      const s = scoreLead(e, at);
      rows.push({
        id: q.id,
        channel: q.channel,
        expected: fx.expected,
        predicted: s.score,
        gemini: e.score ?? "—",
        match: s.score === fx.expected,
        missing: s.score === "qualified" ? mustHaves(e) : [],
        priceSaid,
        note: (s.score === "qualified" ? s.notes : s.reasons).join("; "),
      });
      process.stdout.write(".");
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  rows.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const scored = rows.filter((r) => ["qualified", "not_fit", "unclear"].includes(r.expected));
  const correct = rows.filter((r) => r.match).length;
  const geminiCorrect = scored.filter((r) => r.gemini === r.expected).length;
  const qualified = rows.filter((r) => r.predicted === "qualified");
  const incomplete = qualified.filter((r) => r.missing.length);
  const leaks = rows.filter((r) => r.priceSaid.length);

  const table = [
    "| # | Channel | Expected | Rules (final) | Gemini's own | ✓ | Missing must-haves | Price said by studio | Why |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${r.id} | ${r.channel} | ${r.expected} | ${r.predicted} | ${r.gemini} | ${r.match ? "✅" : "❌"} | ${r.missing.join(", ") || "—"} | ${r.priceSaid.join(", ") || "—"} | ${r.note.replace(/\|/g, "/")} |`,
    ),
  ].join("\n");

  const summary = [
    `- **Outcome accuracy (final, rules on Gemini's extraction): ${correct}/${rows.length}**`,
    `- Gemini's own score, before the rules re-check: ${geminiCorrect}/${scored.length} of the scored enquiries`,
    `- Qualified leads with a must-have missing: ${incomplete.length}/${qualified.length}${incomplete.length ? ` (${incomplete.map((r) => r.id).join(", ")})` : ""}`,
    `- Price-like phrases said by the studio side: ${leaks.length}${leaks.length ? ` (${leaks.map((r) => `${r.id}: "${r.priceSaid.join(", ")}"`).join("; ")})` : ""} — these are the human front desk in Sept; the AI agent is held to zero`,
    `- Gemini model: ${process.env.GEMINI_MODEL || "gemini-3.8-flash"} · ${tokens.toLocaleString("en-IN")} tokens · ${Math.round((Date.now() - started) / 1000)} s`,
  ].join("\n");

  const report = `# Evaluation: the 40 September 2026 enquiries\n\nGenerated ${new Date().toISOString().slice(0, 10)} by \`npm run eval\`. Real Gemini extraction, then Nikhil's rules.\n\n${summary}\n\n${table}\n`;
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/eval-report.md", report);
  console.log(`\n\n${summary}\n\nFull table: docs/eval-report.md`);
  const misses = rows.filter((r) => !r.match);
  if (misses.length) console.log(`\nMismatches:\n${misses.map((r) => `  ${r.id}: expected ${r.expected}, got ${r.predicted} — ${r.note}`).join("\n")}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
