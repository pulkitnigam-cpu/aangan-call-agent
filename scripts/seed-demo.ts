// Demo data for the dashboard and Telegram bot: the real September 2026
// enquiries (names/areas/sizes from knowledge/Aangan_Sep 2026_Enquiries.pdf),
// replayed over the last 30 days with realistic callbacks and outcomes.
//
//   DEMO=1 npm run db:seed-demo
//
// Refuses to run unless DEMO=1, and never against a database that already has
// real (non-demo) calls. Deterministic, so screenshots are reproducible.

import { config } from "dotenv";
import postgres from "postgres";
import { callbackDue } from "../lib/hours";
import { areaMatches } from "../lib/policy";

config({ path: [".env.local", ".env"], quiet: true });

if (process.env.DEMO !== "1") {
  console.error("Refusing to seed demo data without DEMO=1.");
  process.exit(1);
}
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, { prepare: false, ssl: isLocal ? false : "require", max: 1, onnotice: () => {} });

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const DESIGNERS = [
  { name: "Ananya Kulkarni", email: process.env.DEMO_EMAIL_ANANYA ?? "ananya.demo@example.com", areas: ["kothrud", "warje", "bavdhan", "karve nagar", "erandwane", "deccan"] },
  { name: "Rohan Joshi", email: process.env.DEMO_EMAIL_ROHAN ?? "rohan.demo@example.com", areas: ["baner", "aundh", "wakad", "hinjewadi", "balewadi", "pimple saudagar", "pimple nilakh", "chinchwad"] },
  { name: "Meera Patil", email: process.env.DEMO_EMAIL_MEERA ?? "meera.demo@example.com", areas: ["kharadi", "viman nagar", "koregaon park", "kalyani nagar", "hadapsar", "magarpatta", "undri", "nibm", "kondhwa"] },
];

// [name, area, bhk, sqft, scope, source, kind]
const ENQUIRIES: [string, string, number | null, number | null, string, string, "home" | "office"][] = [
  ["Priya", "Kothrud, Dahanukar Colony", 3, 1400, "Kitchen, living room, both bedrooms", "Referral: Shruti Joshi", "home"],
  ["Rahul", "Wakad", 2, 950, "Modular kitchen, wardrobes, living, 2 bedrooms", "Instagram", "home"],
  ["Aarti Mehta", "Koregaon Park", 4, 2400, "Complete redesign incl. flooring", "Referral: Vikram Agarwal", "home"],
  ["Kunal Shah", "Baner", null, 800, "Office fitout: 20 workstations, cabin, meeting room", "Instagram", "office"],
  ["Nisha", "Baner", 2, null, "Living room, bedroom, kitchen (rented, no structural)", "Google", "home"],
  ["Anand Sharma", "Kalyani Nagar", null, 5500, "Villa, G+2, end-to-end", "Referral", "home"],
  ["Vikas", "Aundh", 3, 1100, "Kitchen, wardrobes, living room", "Instagram", "home"],
  ["Rohit (for parents)", "Hadapsar", 3, null, "Full home, new possession", "Instagram", "home"],
  ["Smita", "Undri", 2, 875, "Full home: kitchen, wardrobes, living", "Instagram", "home"],
  ["Girish Nair", "Viman Nagar", 3, null, "Full home", "Called before", "home"],
  ["Ritu Kapoor", "Pimple Saudagar", 3, 1050, "Kitchen, wardrobes, living room", "Instagram", "home"],
  ["Pooja", "Magarpatta, Cybercity", 2, 900, "Kitchen, both bedrooms, living", "Google", "home"],
  ["Kiran Mazumdar", "Viman Nagar", 4, 1800, "Full interiors", "Referral: Sonali Patel", "home"],
  ["Sunil Yadav", "Pimple Nilakh", 3, null, "Poora ghar (full home)", "Instagram", "home"],
  ["Chinmay Kulkarni", "Chinchwad", null, 1200, "Office: 30 workstations, 2 cabins, meeting room", "Google", "office"],
  ["Tanvi Kulkarni", "Koregaon Park", 3, null, "End-to-end design", "Referral: Ashok Bhosale", "home"],
  ["Pradeep Garg", "Aundh", 2, 850, "Full interiors", "Instagram", "home"],
  ["Neha Deshpande", "Aundh, Sunderban", 3, null, "Living + dining, maybe kitchen", "Instagram", "home"],
  ["Sumit Bhatt", "Kalyani Nagar", 2, 920, "Kitchen, 2 bedrooms, living, home-office corner", "Instagram", "home"],
  ["Laleh Contractor", "Baner", 3, 1100, "Master bedroom + living room", "Referral: Priya Wadia", "home"],
  ["Sheena Menon", "Hinjewadi Phase 1", null, 2200, "Office for 60: 55 workstations, 4 cabins", "Referral: Amey Joshi", "office"],
  ["Preethi Nair", "NIBM Road", 4, 1950, "Kitchen, 3 bedrooms, living, study", "Pune Mirror", "home"],
  ["Amol Patil", "Kondhwa", 3, 1150, "Full home, builder handover", "Builder referral", "home"],
  ["Siddharth Gupta", "Aundh", 3, 1300, "Full home + 2 home offices", "LinkedIn", "home"],
  ["Meghna", "Bavdhan", 2, 980, "Kitchen and living room", "Instagram", "home"],
  ["Arjun Rao", "Warje", 3, 1200, "Full home", "Google", "home"],
];

async function main() {
  const [{ real }] = await sql<{ real: number }[]>`select count(*)::int as real from calls where coalesce(raw_payload->>'demo', 'false') <> 'true'`;
  if (real > 0) throw new Error(`Database has ${real} real calls — not seeding demo data into it.`);

  await sql`delete from lead_events where lead_id in (select id from leads where call_id in (select id from calls where raw_payload->>'demo' = 'true'))`;
  await sql`delete from leads where call_id in (select id from calls where raw_payload->>'demo' = 'true')`;
  await sql`delete from calls where raw_payload->>'demo' = 'true'`;

  const designers: { id: string; name: string; areas: string[] }[] = [];
  for (const d of DESIGNERS) {
    const [row] = await sql<{ id: string }[]>`
      insert into designers (name, areas, email, calendly_link)
      values (${d.name}, ${d.areas}, ${d.email.toLowerCase()}, ${`https://calendly.com/aangan-${d.name.split(" ")[0].toLowerCase()}/site-visit`})
      on conflict (email) do update set areas = excluded.areas, active = true
      returning id
    `;
    designers.push({ id: row.id, name: d.name, areas: d.areas });
  }

  const now = new Date();
  let rr = 0;
  for (let i = 0; i < ENQUIRIES.length; i++) {
    const [name, area, bhk, sqft, scope, source, kind] = ENQUIRIES[i % ENQUIRIES.length];
    const daysAgo = i < 4 ? 0 : Math.floor(rand() * 29) + 1;
    const hour = pick([9, 10, 11, 12, 14, 15, 16, 17, 18, 20, 21, 22, 23]);
    const started = new Date(now.getTime() - daysAgo * 86_400_000);
    started.setUTCHours(hour - 5, Math.floor(rand() * 60), 0, 0); // IST hour
    if (started > now) started.setTime(now.getTime() - 20 * 60_000);
    const duration = 180 + Math.floor(rand() * 360);
    const roll = rand();
    const score = roll < 0.72 ? "qualified" : roll < 0.86 ? "unclear" : "not_fit";
    const phone = `+9198${String(10000000 + i * 7919).slice(0, 8)}`;
    const cost = Math.round((Math.ceil(duration / 60) * 6 + 0.25) * 100) / 100;

    const [call] = await sql<{ id: string }[]>`
      insert into calls (vani_call_id, caller_phone, started_at, ended_at, duration_sec, status, processed_at, category, score,
                         language, transcript, cost_inr, llm_input_tokens, llm_output_tokens, recording_consent, raw_payload, promised_outcome)
      values (${`demo-${i}`}, ${phone}, ${started}, ${new Date(started.getTime() + duration * 1000)}, ${duration}, 'completed', ${started},
              'new_project', ${score}, ${pick(["en", "en", "hi", "mr", "mixed"])},
              ${`Agent: Hi, this is Aangan Studio's assistant. I'm an AI, and this call is recorded to help our designers. Is that okay?\nCaller: Yes.\nCaller: ${scope} in ${area}.\nAgent: Thank you — one of our designers will call you back.`},
              ${cost}, 1800, 450, true, ${sql.json({ demo: true })},
              ${score === "qualified" ? "designer_callback" : score === "unclear" ? "front_desk_callback" : "declined"})
      returning id
    `;

    const local = designers.filter((d) => areaMatches(area, d.areas));
    const designer = score === "qualified" ? local[0] ?? designers[rr++ % designers.length] : null;
    const due = callbackDue(started);
    const assignedAt = designer ? started : null;
    const ageMin = (now.getTime() - started.getTime()) / 60_000;
    // Outcome: most are called on time; a few late; the newest may still be waiting.
    let first: Date | null = null;
    let status = score === "not_fit" ? "not_fit" : designer ? "assigned" : "new";
    if (designer && ageMin > 150) {
      const clock = Math.max(started.getTime(), due.getTime() - 2 * 3600_000);
      const mins = rand() < 0.85 ? 8 + Math.floor(rand() * 100) : 130 + Math.floor(rand() * 200);
      first = new Date(clock + mins * 60_000);
      const r = rand();
      status = r < 0.45 ? "visit_booked" : r < 0.6 ? "visit_done" : r < 0.72 ? "won" : r < 0.8 ? "lost" : "called";
    } else if (designer && ageMin > 40 && rand() < 0.5) {
      first = new Date(started.getTime() + 25 * 60_000);
      status = "called";
    }

    const [lead] = await sql<{ id: string }[]>`
      insert into leads (call_id, name, phone, area, property_type, bhk, size_sqft, scope, source, score, status, owner,
                         designer_id, assigned_at, accepted_at, due_at, first_action_at, summary, created_at, last_call_at,
                         intent, project_kind, scope_kind, decision_maker, timeline, priority)
      values (${call.id}, ${name}, ${phone}, ${area}, ${kind}, ${bhk}, ${sqft}, ${scope}, ${source}, ${score}, ${status},
              ${designer ? "designer" : "front_desk"}, ${designer?.id ?? null}, ${assignedAt}, ${first}, ${due}, ${first},
              ${`${bhk ? `${bhk}BHK ` : ""}${kind} in ${area}. ${scope}. Source: ${source}.`}, ${started}, ${started},
              'design_and_execution', ${kind}, ${kind === "office" ? "commercial_fitout" : "full_home"}, 'self',
              ${pick(["By March", "Within 4 months", "Flexible", "January start"])}, ${source.startsWith("Referral")})
      returning id
    `;
    await sql`update calls set lead_id = ${lead.id} where id = ${call.id}`;
    const ev = (type: string, at: Date | null) => (at ? sql`insert into lead_events (lead_id, type, actor, at) values (${lead.id}, ${type}, 'demo', ${at})` : null);
    await ev("created", started);
    if (designer) await ev("assigned", started);
    if (first) await ev("called", first);
    if (["visit_booked", "visit_done", "won"].includes(status) && first) await ev("visit_booked", new Date(first.getTime() + 10 * 60_000));
    if (status === "won" && first) await ev("won", new Date(first.getTime() + 9 * 86_400_000));
  }

  await sql`insert into ai_usage (kind, actor, input_tokens, output_tokens, cost_inr) select 'bot_question', 'demo', 900, 120, 0.05 from generate_series(1, 25)`;
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from leads`;
  console.log(`Demo data ready: ${n} leads across ${designers.length} designers.`);
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err.message ?? err);
    await sql.end();
    process.exit(1);
  });
