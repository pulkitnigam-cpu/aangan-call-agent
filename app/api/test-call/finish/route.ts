import { z } from "zod";
import { getSql } from "@/lib/db";
import { handleCallFinished } from "@/lib/leads";
import { WEB_CALL_ID } from "@/lib/voice/vaani-api";

// POST /api/test-call/finish { room, durationSec } — the page hung up.
const Body = z.object({ room: z.string().regex(WEB_CALL_ID), durationSec: z.number().int().min(0).max(900) });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  await handleCallFinished(getSql(), parsed.data.room, parsed.data.durationSec, new Date());
  return Response.json({ ok: true });
}
