import { after } from "next/server";
import { getSql } from "@/lib/db";
import { sweep } from "@/lib/leads";
import { importWebCall } from "@/lib/voice/import";
import { WEB_CALL_ID } from "@/lib/voice/vaani-api";

// GET /api/test-call/status?room=… — the page polls this after hanging up.
// Each poll tries to pull the finished call from Vaani and process it.
export async function GET(request: Request) {
  const room = new URL(request.url).searchParams.get("room") ?? "";
  if (!WEB_CALL_ID.test(room)) return Response.json({ error: "bad request" }, { status: 400 });
  const sql = getSql();
  try {
    const r = await importWebCall(sql, room, new Date());
    if (r.state === "done" && r.kind !== "already") after(() => sweep(sql, new Date()).catch((e) => console.error("[sweep]", e)));
    return Response.json(r);
  } catch (err) {
    console.error(`[test-call status ${room}]`, err);
    return Response.json({ state: "waiting" });
  }
}
