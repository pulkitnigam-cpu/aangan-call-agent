// Vaani's REST API, for calls we start ourselves from the browser test page
// (no webhook needed): start a WebRTC session, then pull the finished call.
//   POST /api/trigger-call/        { agent_id, medium: "webrtc" } → { token, room_name, connection_url }
//   GET  /api/call_details/{id}    → { transcription, entity, summary, call_eval_tag }
//   GET  /api/transcript/{id}      → { transcript } (404 until ready)
// The result is shaped like a call_postprocessing webhook, so the same parser
// and handler run for both paths.

import { requireEnv } from "../env";

const API = "https://api.vaanivoice.ai";
type Obj = Record<string, unknown>;

async function vaani(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Obj }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "X-API-Key": requireEnv("VANI_API_KEY"), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  let json: Obj = {};
  try {
    json = (await res.json()) as Obj;
  } catch {}
  return { status: res.status, json };
}

export const WEB_CALL_ID = /^webrtc-\d+-[0-9a-f]+$/;

export async function startWebCall(): Promise<{ token: string; url: string; room: string }> {
  const { status, json } = await vaani("POST", "/api/trigger-call/", {
    agent_id: requireEnv("VANI_AGENT_ID"),
    medium: "webrtc",
    primary_language: "en",
    secondary_language: "hi",
  });
  const room = String(json.room_name ?? "");
  if (status !== 200 || !json.token || !WEB_CALL_ID.test(room)) throw new Error(`Vaani trigger-call → ${status}`);
  return { token: String(json.token), url: String(json.connection_url), room };
}

// Until post-processing finishes, the fields hold an "unavailable" message.
const notReady = (v: unknown) => typeof v !== "string" || !/\b(AGENT|USER)\s*:/i.test(v);

/** The finished call as a call_postprocessing payload, or null if Vaani isn't done yet. */
export async function fetchFinishedCall(callId: string, durationSec: number, endedAt: Date): Promise<Obj | null> {
  const details = await vaani("GET", `/api/call_details/${encodeURIComponent(callId)}`);
  let transcript = details.json.transcription;
  if (notReady(transcript)) {
    const t = await vaani("GET", `/api/transcript/${encodeURIComponent(callId)}`);
    transcript = t.json.transcript;
  }
  if (notReady(transcript)) return null;
  const entity = details.json.entity && typeof details.json.entity === "object" ? (details.json.entity as Obj) : {};
  const summary = typeof details.json.summary === "string" && !/not (yet )?available/i.test(details.json.summary) ? details.json.summary : "";
  return {
    event: "call_postprocessing",
    call_id: callId,
    timestamp: endedAt.toISOString(),
    source: "vaani_api", // pulled by us, not pushed by a webhook
    data: { call_id: callId, room_name: callId, call_duration: durationSec * 1000, summary, entities: entity, transcript, call_eval_tag: details.json.call_eval_tag ?? null },
  };
}
