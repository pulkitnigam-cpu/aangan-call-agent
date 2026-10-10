import { z } from "zod";

// zod schemas for everything that arrives from outside: the LLM's extraction,
// the agent's check_fit arguments, Telegram updates, Calendly webhooks.
//
// LLM output is coerced, not rejected: a bad field becomes "unknown"/null
// (and so lands with a human) instead of failing the whole call.

const str = (max: number) =>
  z
    .preprocess((v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null), z.string().nullable())
    .catch(null);

const int = (min: number, max: number) =>
  z
    .preprocess((v) => {
      const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : v;
      return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
    }, z.number().int().min(min).max(max).nullable())
    .catch(null);

const bool = z.boolean().nullable().catch(null);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)))
  .nullable()
  .catch(null);
const onlyTrue = z.preprocess((v) => v === true, z.boolean());

export const INTENTS = ["design_and_execution", "advice_only", "self_execution", "furniture_only", "vastu_only", "structural_only", "exploring", "unknown"] as const;
export const PROJECT_KINDS = ["home", "office", "clinic", "studio", "restaurant", "hotel", "retail", "gym", "other", "unknown"] as const;
export const SCOPE_KINDS = ["full_home", "partial_home", "single_room", "commercial_fitout", "unknown"] as const;
export const DECISION_MAKERS = ["self", "authorised", "research_only", "not_authorised", "unknown"] as const;
export const OUTCOMES = ["designer_callback", "front_desk_callback", "declined", "escalated", "none"] as const;

/** The five-criteria facts (lib/policy.ts LeadFacts). */
export const FactsSchema = z.object({
  intent: z.enum(INTENTS).catch("unknown"),
  project_kind: z.enum(PROJECT_KINDS).catch("unknown"),
  scope_kind: z.enum(SCOPE_KINDS).catch("unknown"),
  room_count: int(1, 30),
  bhk: int(1, 10),
  area: str(120),
  size_sqft: int(50, 100_000),
  budget_max_inr: int(0, 1_000_000_000),
  deadline_date: isoDate,
  site_available_in_weeks: int(0, 520),
  decision_maker: z.enum(DECISION_MAKERS).catch("unknown"),
});

/** agent/extraction-schema.json, as zod. */
export const ExtractionSchema = FactsSchema.extend({
  category: z.enum(["new_project", "existing_client", "vendor", "spam"]).catch("new_project"),
  language: z.enum(["en", "hi", "mr", "mixed"]).catch("en"),
  recording_consent: bool,
  name: str(80),
  callback_phone: str(20),
  scope: str(300),
  current_state: str(200),
  timeline: str(200),
  budget_text: str(100),
  rented: bool,
  source: str(200),
  consultation_preference: str(200),
  escalate: onlyTrue,
  escalation_reason: str(300),
  priority: onlyTrue,
  open_questions: z
    .preprocess(
      (v) => (Array.isArray(v) ? v.filter((q) => typeof q === "string" && q.trim()).slice(0, 10).map((q: string) => q.slice(0, 200)) : []),
      z.array(z.string()),
    )
    .catch([]),
  promised_outcome: z.enum(OUTCOMES).catch("none"),
  score: z.union([z.null(), z.enum(["qualified", "not_fit", "unclear"])]).catch("unclear"),
  summary: str(600).transform((v) => v ?? ""),
});

const asObject = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

export const parseFacts = (v: unknown) => FactsSchema.parse(asObject(v));
export const parseExtractionObject = (v: unknown) => ExtractionSchema.parse(asObject(v));

// ---------------------------------------------------------------------------
// Webhook payloads (strict shape; anything else is ignored)
// ---------------------------------------------------------------------------

const TgChat = z.object({ id: z.number() });
const TgUser = z.object({ id: z.number(), first_name: z.string().optional() });

export const TelegramUpdateSchema = z.object({
  update_id: z.number().optional(),
  message: z
    .object({ chat: TgChat, from: TgUser.optional(), text: z.string().max(4096).optional() })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: TgUser,
      data: z.string().max(64).optional(),
      message: z.object({ chat: TgChat, message_id: z.number() }).optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

export const CalendlyWebhookSchema = z.object({
  event: z.string(),
  payload: z
    .object({
      uri: z.string().optional(),
      event: z.string().optional(),
      scheduled_event: z.union([z.string(), z.object({ uri: z.string().optional(), start_time: z.string().optional() })]).optional(),
      tracking: z.object({ utm_content: z.string().nullable().optional() }).nullable().optional(),
    })
    .optional(),
});
