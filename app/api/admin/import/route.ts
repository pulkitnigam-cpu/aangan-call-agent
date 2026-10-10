import { getSql } from "@/lib/db";
import { verifyCron } from "@/lib/security";
import { importPendingWebCalls } from "@/lib/voice/import";

// POST /api/admin/import (Bearer CRON_SECRET) — processes any browser test call
// that finished but wasn't pulled yet (e.g. the page was closed early).
export async function POST(request: Request) {
  if (!verifyCron(request.headers)) return Response.json({ error: "unauthorised" }, { status: 401 });
  return Response.json({ imported: await importPendingWebCalls(getSql(), new Date()) });
}
