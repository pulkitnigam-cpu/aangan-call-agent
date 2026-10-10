import { getSql } from "@/lib/db";
import { parseCalendlyWebhook } from "@/lib/calendly";
import { handleCalendlyBooking } from "@/lib/leads";
import { verifyCalendly } from "@/lib/security";

// POST /api/calendly/webhook — a site visit was booked (or cancelled).
export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyCalendly(raw, request.headers)) return Response.json({ error: "bad signature" }, { status: 401 });

  const booking = parseCalendlyWebhook(JSON.parse(raw || "{}"));
  if (!booking) return Response.json({ ok: true, result: "ignored" });
  return Response.json({ ok: true, result: await handleCalendlyBooking(getSql(), booking, new Date()) });
}
