import { after } from "next/server";
import { getSql } from "@/lib/db";
import { extractFromTranscript } from "@/lib/gemini";
import { handleCallEnded, handleCallFinished, handleCallStarted, releaseCallClaim, sweep } from "@/lib/leads";
import { verifyVaaniWebhook } from "@/lib/security";
import { parseVaaniWebhook } from "@/lib/voice/vani";

// POST /api/voice/webhook?token=… — every Vaani Voice call event (Settings → Webhooks).
export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyVaaniWebhook(raw, request.headers, request.url)) return Response.json({ error: "unauthorised" }, { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const evt = parseVaaniWebhook(body);
  const sql = getSql();
  const now = new Date();

  switch (evt.kind) {
    case "started":
      await handleCallStarted(sql, evt.event, now);
      return Response.json({ ok: true });
    case "ended":
      await handleCallFinished(sql, evt.providerCallId, evt.durationSec, now);
      return Response.json({ ok: true });
    case "postprocessed":
      try {
        const result = await handleCallEnded(sql, evt.event, { extract: extractFromTranscript }, now);
        after(() => sweep(sql, new Date()).catch((err) => console.error("[sweep after call]", err)));
        return Response.json({ ok: true, result });
      } catch (err) {
        console.error(`[voice webhook ${evt.event.providerCallId}] failed`, err);
        await releaseCallClaim(sql, evt.event.providerCallId).catch(() => {});
        return Response.json({ ok: false }, { status: 500 }); // let Vaani retry
      }
    case "ignored":
      return Response.json({ ok: true, ignored: evt.name });
  }
}
