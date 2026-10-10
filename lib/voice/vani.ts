// Adapter for Vaani Voice (https://docs.vaanivoice.ai) — the only file that
// knows Vaani's payload shapes. Everything after it uses lib/voice/types.ts.
//
// Vaani sends ONE webhook (Settings → Webhooks) with an `event` field:
//   call_started         { event, room_name, status, phone_number }
//   call_ended           { event, room_name, call_duration (SECONDS), end_reason }
//   call_postprocessing  { event, call_id, timestamp, data: { room_name, call_id,
//                          call_duration (MILLISECONDS), end_reason, summary,
//                          entities, dispositions, recording_url, transcript } }
// (plus transfer/ringing events we don't need). The room name is the call id.
//
// `entities` and `dispositions` are whatever we configure in the agent's
// Analysis section — scripts/vaani-setup.ts configures them with exactly the
// field names of agent/extraction-schema.json, so they map 1:1 here.

import { parseExtraction } from "../gemini";
import type { CallEndedEvent, CallStartedEvent, ToolCallEvent, Turn } from "./types";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

export type VaaniEvent =
  | { kind: "started"; event: CallStartedEvent }
  | { kind: "ended"; providerCallId: string; durationSec: number; endReason: string }
  | { kind: "postprocessed"; event: CallEndedEvent }
  | { kind: "ignored"; name: string };

/** Turns Vaani's "[13:33:14] AGENT: …\n\n[13:33:19] USER: …" into turns. */
export function parseTranscript(t: unknown): Turn[] {
  if (typeof t !== "string") return [];
  const turns: Turn[] = [];
  for (const block of t.split(/\n+/)) {
    const m = block.match(/^\s*(?:\[[^\]]*\]\s*)?(AGENT|USER|ASSISTANT|BOT|CALLER|CUSTOMER)\s*:\s*([\s\S]*)$/i);
    if (m) turns.push({ role: /AGENT|ASSISTANT|BOT/i.test(m[1]) ? "agent" : "caller", text: m[2].trim() });
    else if (block.trim() && turns.length) turns[turns.length - 1].text += ` ${block.trim()}`; // wrapped line
  }
  return turns.filter((x) => x.text);
}

// Vaani's extractor returns strings; turn "null", "N/A", "Yes"/"No", "a; b" into real values.
const NULLISH = new Set(["", "null", "none", "n/a", "na", "unknown", "not mentioned", "not provided", "-"]);
const BOOL_FIELDS = new Set(["recording_consent", "rented", "escalate", "priority"]);

function normaliseValue(key: string, v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (NULLISH.has(s.toLowerCase())) return key === "open_questions" ? [] : null;
  if (BOOL_FIELDS.has(key)) return /^(yes|true|y|1)$/i.test(s) ? true : /^(no|false|n|0)$/i.test(s) ? false : null;
  if (key === "open_questions") return s.split(/\s*[;|\n]\s*/).filter(Boolean);
  return s;
}

/** entities + dispositions (+ summary) → our extraction shape (validated by zod). */
export function toExtraction(data: Obj) {
  const merged: Obj = {};
  for (const [k, v] of Object.entries({ ...obj(data.entities), ...obj(data.dispositions) })) {
    merged[k.trim().toLowerCase()] = normaliseValue(k.trim().toLowerCase(), v);
  }
  if (merged.lead_score !== undefined && merged.score === undefined) merged.score = merged.lead_score;
  if (!merged.summary && typeof data.summary === "string") merged.summary = data.summary;
  return parseExtraction(merged);
}

export function parseVaaniWebhook(body: unknown): VaaniEvent {
  const b = obj(body);
  const name = str(b.event);
  const data = obj(b.data);

  if (name === "call_started") {
    const id = str(b.room_name || b.call_id);
    return id ? { kind: "started", event: { providerCallId: id, callerPhone: str(b.phone_number) } } : { kind: "ignored", name };
  }

  if (name === "call_ended") {
    const id = str(b.room_name || b.call_id);
    if (!id) return { kind: "ignored", name };
    return { kind: "ended", providerCallId: id, durationSec: Math.round(Number(b.call_duration) || 0), endReason: str(b.end_reason) };
  }

  if (name === "call_postprocessing") {
    const id = str(b.call_id || data.call_id || data.room_name);
    if (!id) return { kind: "ignored", name };
    const durationSec = Math.round((Number(data.call_duration) || 0) / 1000); // milliseconds here
    const finished = new Date(str(b.timestamp) || Date.now());
    const endedAt = Number.isNaN(finished.getTime()) ? new Date() : finished;
    const turns = parseTranscript(data.transcript);
    const hasFields = Object.keys(obj(data.entities)).length > 0 || Object.keys(obj(data.dispositions)).length > 0;
    const extraction = hasFields ? toExtraction(data) : null;
    return {
      kind: "postprocessed",
      event: {
        providerCallId: id,
        callerPhone: "", // not in this event; the stored call_started row has it
        startedAt: new Date(endedAt.getTime() - durationSec * 1000),
        endedAt,
        durationSec,
        // Vaani post-processes every finished call; "dropped" = nobody really spoke.
        status: turns.some((t) => t.role === "caller") ? "completed" : "dropped",
        recordingConsent: extraction?.recording_consent ?? null,
        turns,
        extraction,
        llmInputTokens: 0, // TODO(vani-docs): Vaani doesn't report token usage; cost uses minutes (+ our own Gemini calls)
        llmOutputTokens: 0,
        raw: body,
      },
    };
  }

  return { kind: "ignored", name };
}

/**
 * A custom-tool call from the agent. We define the tool's cURL in Vaani, so the
 * body is whatever JSON we wrote there: the arguments, flat, optionally with a
 * call id. Accept both flat and { args: {...} }.
 */
export function parseToolCall(body: unknown): ToolCallEvent {
  const b = obj(body);
  const args = Object.keys(obj(b.args)).length ? obj(b.args) : Object.keys(obj(b.arguments)).length ? obj(b.arguments) : b;
  const id = str(b.call_id || b.room_name);
  return { providerCallId: id || null, args };
}
