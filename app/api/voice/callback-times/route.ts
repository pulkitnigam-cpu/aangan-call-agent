import { connection } from "next/server";
import { callbackTimes } from "@/lib/leads";
import { verifyVaaniTool } from "@/lib/security";

// POST /api/voice/callback-times — the agent's tool for the only callback times it may promise.
export async function POST(request: Request) {
  await connection();
  if (!verifyVaaniTool(request.headers)) return Response.json({ error: "unauthorised" }, { status: 401 });
  return Response.json(callbackTimes(new Date()));
}
