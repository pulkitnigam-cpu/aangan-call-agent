// Creates (or updates) the Aangan agent in your Vaani Voice workspace from
// this repo's files, so the live agent always matches the guardrails.
//
//   npm run vaani:setup              # dry run: prints exactly what would be sent
//   npm run vaani:setup -- --apply   # creates/updates the agent
//
// Env: VANI_API_KEY (required), VANI_AGENT_ID (set after the first run to update
// instead of create), VANI_LLM_MODEL (default below — check the dashboard's list),
// VANI_INBOUND_NUMBER (E.164, optional — the number callers are forwarded to).
//
// What it sets (docs.vaanivoice.ai/api-reference):
//   persona   — system prompt = agent/system-prompt.md + services.md + qualified.md
//               (pricing.md NEVER), consent greeting, Gemini as the brain,
//               auto language detection (English/Hindi/Marathi), previous-call memory
//   training  — strict guardrails
//   analysis  — data points = agent/extraction-schema.json fields; dispositions =
//               category / promised_outcome / lead_score / language
//   deployment— inbound number, if VANI_INBOUND_NUMBER is set
// Tools (check_fit, callback_times) and the webhook are added in the dashboard
// with the cURLs printed at the end — Vaani's API doesn't document their shape.

import { config } from "dotenv";
import { readFileSync } from "node:fs";

config({ path: [".env.local", ".env"], quiet: true });

const API = "https://api.vaanivoice.ai";
const APPLY = process.argv.includes("--apply");
const key = process.env.VANI_API_KEY;
if (!key) throw new Error("Set VANI_API_KEY in .env.local");

// --- the prompt: our rules + Nikhil's two knowledge files, word for word ----
const promptBody = readFileSync("agent/system-prompt.md", "utf8").split("\n---\n").slice(1).join("\n---\n").trim();
const services = readFileSync("knowledge/services.md", "utf8").trim();
const qualified = readFileSync("knowledge/qualified.md", "utf8").trim();
const SYSTEM_PROMPT = `${promptBody}

## Studio facts — your ONLY source of truth

Everything you say about the studio must come from these two documents or from the rules above.
If something isn't covered here, say the designer will answer it, and note the question.

<services.md>
${services}
</services.md>

<qualified.md>
${qualified}
</qualified.md>`;

if (readFileSync("knowledge/pricing.md", "utf8").split("\n").some((line) => line.length > 30 && SYSTEM_PROMPT.includes(line))) {
  throw new Error("pricing.md content found in the prompt — refusing (the Cut).");
}

const GREETING = "Hi, this is Aangan Studio's assistant. I'm an AI, and this call is recorded to help our designers. Is that okay?";

// --- extraction: every field of agent/extraction-schema.json -----------------
type SchemaProp = { enum?: (string | null)[]; type?: string | string[]; description?: string };
const schema = JSON.parse(readFileSync("agent/extraction-schema.json", "utf8")) as { properties: Record<string, SchemaProp> };
const DISPOSITION_FIELDS = new Set(["category", "promised_outcome", "score", "language"]);

const dataPoints = Object.entries(schema.properties)
  .filter(([name]) => !DISPOSITION_FIELDS.has(name) && name !== "summary")
  .map(([name, p]) => ({
    name,
    prompt: `${p.description ?? `Extract ${name.replace(/_/g, " ")}.`} Use null if the caller did not say it. Never guess.`,
    ...(p.enum ? { values: p.enum.filter((v) => v !== null) } : {}),
    nullable: true,
  }))
  .concat([
    {
      name: "qualification_reason",
      prompt: "One short sentence: why this lead is qualified, not a fit, or unclear, naming the criterion (e.g. 'Outside service area: site in Nashik'). null if not a new project.",
      nullable: true,
    },
  ]);

const tags = (values: string[], descriptions: Record<string, string> = {}) =>
  Object.fromEntries(values.map((v) => [v, descriptions[v] ?? v.replace(/_/g, " ")]));

const dispositions = [
  {
    name: "category",
    type: "string",
    prompt: "What kind of call was this?",
    list_of_tags: tags(["new_project", "existing_client", "vendor", "spam"], {
      new_project: "a new interior design enquiry",
      existing_client: "someone with a project already running with the studio",
      vendor: "supplier, job seeker or sales call",
      spam: "wrong number or spam",
    }),
  },
  {
    name: "promised_outcome",
    type: "string",
    prompt: "What did the agent TELL the caller would happen next, at the end of the call?",
    list_of_tags: tags(["designer_callback", "front_desk_callback", "declined", "escalated", "none"], {
      designer_callback: "a designer will call them back",
      front_desk_callback: "the team / front desk will call them back",
      declined: "politely told it is not a fit",
      escalated: "a senior person will call (existing client issue)",
      none: "call ended before any close",
    }),
  },
  {
    name: "lead_score",
    type: "string",
    prompt:
      "For a new-project call, apply the studio's five criteria. Real project: wants design AND execution for a home, office, clinic or studio (not advice-only, self-execution, furniture-only, Vastu-only, structural-only, restaurant/hotel/retail/gym, offices over ~3,000 sq ft or a tiny pod). Service area: site in Pune city or PCMC. Timeline: completion needed at least ~8 weeks away (or flexible). Budget: only fails if the caller volunteered a figure obviously far too low for the scope; not mentioned = pass. Decision-maker: never blocks unless they clearly cannot move forward. Any criterion clearly failed = not_fit. Location, scope or timeline still unknown after the call = unclear. Otherwise qualified. For calls that are not new projects, answer unclear.",
    list_of_tags: tags(["qualified", "not_fit", "unclear"], {
      qualified: "all five criteria pass or only budget/decision-maker are uncertain",
      not_fit: "at least one criterion clearly fails",
      unclear: "location, scope (design+execution) or timeline still unknown",
    }),
  },
  { name: "language", type: "string", prompt: "Main language the caller used.", list_of_tags: tags(["en", "hi", "mr", "mixed"]) },
];

const persona = {
  identity: {
    system_prompt: SYSTEM_PROMPT,
    personality: { tone: "warm", style: "calm, brief, professional" },
    greeting_message: { agent_message: GREETING, agent_speech_delay: 1, interruptible: true, let_user_speak_first: false },
  },
  senses_capabilities: {
    language: "en",
    auto_detect: true, // English, Hindi, Marathi — match the caller
    brain: {
      llm: {
        primary: {
          provider: "google",
          model: process.env.VANI_LLM_MODEL || "gemini-3.5-flash", // the model in Vaani's own docs example; check the dashboard list
          parameters: { temperature: 0.3, top_p: 1, max_tokens: 400 }, // low temperature: stick to the rules
        },
      },
    },
  },
  memories: { use_previous_call_contexts: true, max_history_calls: 5 },
  metadata: { project: "aangan-call-agent", source: "scripts/vaani-setup.ts" },
};

// 4-minute cap (decided 10 Oct). The agent wraps up at ~3; this is the hard stop. No promised time in the message.
const experience = {
  settings: {
    call_settings: {
      max_call_duration: 4,
      max_duration_enabled: true,
      max_duration_action: "hang_up",
      max_duration_hangup_message: "We've reached the time limit for this call. Our team will call you back about anything we missed. Thank you, goodbye.",
      enable_voicemail_detection: false,
    },
  },
};

const training = { know_how: { guardrails: { level: "strict", sexual: true, violence: true, threatning: true } } };
const analysis = {
  evaluations: { dispositions: { enabled: true, prompt_based: dispositions } },
  extraction: {
    data_collection: { enabled: true, data_points: dataPoints },
    collect_concerns: { enabled: true, prompt: "Note any complaint or unresolved issue the caller raised." },
  },
};
const deployment = process.env.VANI_INBOUND_NUMBER
  ? { deployment: { phone: { call_type: { Inbound: process.env.VANI_INBOUND_NUMBER } } } }
  : null;

async function vaani(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "X-API-Key": key!, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vaani ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  console.log(`System prompt: ${SYSTEM_PROMPT.length} chars (rules + services.md + qualified.md; pricing.md excluded)`);
  console.log(`Data points: ${dataPoints.length} · dispositions: ${dispositions.map((d) => d.name).join(", ")}`);
  console.log("Call cap: 4 min (hard stop; the agent wraps up at ~3)");
  console.log(`LLM: google / ${persona.senses_capabilities.brain.llm.primary.model} · memory on · guardrails strict`);
  console.log(`Inbound number: ${process.env.VANI_INBOUND_NUMBER ?? "(not set — assign in the dashboard later)"}`);

  if (!APPLY) {
    console.log("\nDry run. Nothing was sent. Re-run with --apply to create/update the agent.");
    return;
  }

  let agentId = process.env.VANI_AGENT_ID;
  if (!agentId) {
    const created = await vaani("POST", "/api/create-agent", { agent_display_name: "Aangan Studio receptionist", config: {} });
    agentId = created.agent_id as string;
    console.log(`\nCreated agent ${agentId}. Add VANI_AGENT_ID=${agentId} to .env.local so later runs update it.`);
  } else {
    console.log(`\nUpdating agent ${agentId}`);
  }
  await vaani("PATCH", `/api/agent/${agentId}/persona`, persona);
  console.log("persona   ✓");
  await vaani("PATCH", `/api/agent/${agentId}/training`, training);
  console.log("training  ✓");
  await vaani("PATCH", `/api/agent/${agentId}/experience`, experience);
  console.log("experience ✓ (4-min cap)");
  await vaani("PATCH", `/api/agent/${agentId}/analysis`, analysis);
  console.log("analysis  ✓");
  if (deployment) {
    await vaani("PATCH", `/api/agent/${agentId}/deployment`, deployment);
    console.log("deployment ✓");
  }

  const base = process.env.APP_BASE_URL ?? "https://<your-app>.vercel.app";
  console.log(`
FOR SAMPLE CALLS (now): open the agent in the Vaani dashboard, click Publish if it asks,
and place a test call to your own phone. The agent qualifies leads by itself; check
Call History → the call → dispositions (lead_score, promised_outcome) and the
qualification_reason data point.

ONCE THE BACKEND IS DEPLOYED (optional extras), in the Vaani dashboard:

1. Settings → Webhooks → add:
   ${base}/api/voice/webhook?token=<VANI_WEBHOOK_TOKEN>

2. Agent → Persona → Tools → add two custom tools (paste the cURL; header value = VANI_TOOL_SECRET):

   check_fit — "Call before closing every new-project call, with what you collected. Say the 'say' line it returns."
   curl -X POST ${base}/api/voice/check-fit -H "Content-Type: application/json" -H "X-Aangan-Tool-Key: <VANI_TOOL_SECRET>" \\
     -d '{"intent":"","project_kind":"","scope_kind":"","room_count":null,"bhk":null,"area":"","size_sqft":null,"budget_max_inr":null,"deadline_date":"","site_available_in_weeks":null,"decision_maker":""}'

   callback_times — "Call once early in every call. Use its phrases for any callback time."
   curl -X POST ${base}/api/voice/callback-times -H "X-Aangan-Tool-Key: <VANI_TOOL_SECRET>"

3. Settings → Telephony → provision or connect a number; assign it as this agent's Inbound number
   (or set VANI_INBOUND_NUMBER and re-run with --apply), then forward the studio line to it.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
