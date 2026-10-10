import { getSql } from "@/lib/db";
import { handleCallStarted } from "@/lib/leads";
import { startWebCall } from "@/lib/voice/vaani-api";

// POST /api/test-call/start — starts a browser call with the Aangan agent.
// The page is open (no sign-in, owner's decision), so a daily cap protects Vaani credits.
const DAILY_CAP = 40;

export async function POST() {
  const sql = getSql();
  const now = new Date();
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from calls where vani_call_id like 'webrtc-%' and started_at > ${new Date(now.getTime() - 86_400_000)}
  `;
  if (n >= DAILY_CAP) return Response.json({ error: "Daily test-call limit reached." }, { status: 429 });
  try {
    const call = await startWebCall();
    await handleCallStarted(sql, { providerCallId: call.room, callerPhone: "" }, now);
    return Response.json(call);
  } catch (err) {
    console.error("[test-call start]", err);
    return Response.json({ error: "Could not start the call. Try again." }, { status: 502 });
  }
}
