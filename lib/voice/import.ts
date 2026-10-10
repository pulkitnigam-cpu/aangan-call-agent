// Pulls a finished browser test call from Vaani's API and runs it through the
// exact same handler as the webhook (lead, routing, Telegram, HubSpot, report).
// Used by the test-call page and by `npm run report` (catches any stragglers).

import type { Sql } from "postgres";
import { extractFromTranscript } from "../gemini";
import { handleCallEnded, releaseCallClaim } from "../leads";
import { fetchFinishedCall } from "./vaani-api";
import { parseVaaniWebhook } from "./vani";

export type ImportResult = { state: "unknown" } | { state: "waiting" } | { state: "done"; leadId: string | null; kind: string };

export async function importWebCall(sql: Sql, callId: string, now: Date): Promise<ImportResult> {
  const [call] = await sql<{ started_at: Date; ended_at: Date | null; duration_sec: number | null; processed_at: Date | null; lead_id: string | null }[]>`
    select started_at, ended_at, duration_sec, processed_at, lead_id from calls where vani_call_id = ${callId}
  `;
  if (!call) return { state: "unknown" };
  if (call.processed_at) return { state: "done", leadId: call.lead_id, kind: "already" };

  const endedAt = call.ended_at ?? now;
  const durationSec = call.duration_sec ?? Math.max(0, Math.round((endedAt.getTime() - call.started_at.getTime()) / 1000));
  const payload = await fetchFinishedCall(callId, durationSec, endedAt);
  if (!payload) return { state: "waiting" };

  const evt = parseVaaniWebhook(payload);
  if (evt.kind !== "postprocessed") return { state: "waiting" };
  try {
    const r = await handleCallEnded(sql, evt.event, { extract: extractFromTranscript }, now);
    return { state: "done", leadId: r.kind === "lead" ? r.leadId : null, kind: r.kind };
  } catch (err) {
    await releaseCallClaim(sql, callId).catch(() => {});
    throw err;
  }
}

/** Every browser call that ended at least a minute ago and isn't processed yet. */
export async function importPendingWebCalls(sql: Sql, now: Date): Promise<{ callId: string; state: string }[]> {
  const rows = await sql<{ vani_call_id: string }[]>`
    select vani_call_id from calls
    where vani_call_id like 'webrtc-%' and processed_at is null and started_at < ${new Date(now.getTime() - 60_000)}
    order by started_at limit 20
  `;
  const out: { callId: string; state: string }[] = [];
  for (const r of rows) out.push({ callId: r.vani_call_id, state: (await importWebCall(sql, r.vani_call_id, now)).state });
  return out;
}
