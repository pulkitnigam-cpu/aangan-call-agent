import { getSql } from "@/lib/db";
import { handleCheckFit } from "@/lib/leads";
import { verifyVaaniTool } from "@/lib/security";
import { parseToolCall } from "@/lib/voice/vani";

// POST /api/voice/check-fit — the agent's live tool (a Vaani custom tool, cURL).
// Applies Nikhil's rubric to what the agent has collected; returns the exact closing line.
export async function POST(request: Request) {
  if (!verifyVaaniTool(request.headers)) return Response.json({ error: "unauthorised" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const { providerCallId, args } = parseToolCall(body);
  return Response.json(await handleCheckFit(getSql(), providerCallId, args, new Date()));
}
