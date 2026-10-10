import { connection } from "next/server";
import { getSql } from "@/lib/db";
import { sweep } from "@/lib/leads";
import { verifyCron } from "@/lib/security";

// GET /api/cron/sweep — reassigns, reminds, escalates, follows up dropped calls.
// Called every 5 min by .github/workflows/sweep.yml (Vercel Hobby crons can
// only run once a day), and opportunistically after webhooks.
export async function GET(request: Request) {
  await connection();
  if (!verifyCron(request.headers)) return Response.json({ error: "unauthorised" }, { status: 401 });
  return Response.json({ ok: true, result: await sweep(getSql(), new Date()) });
}
