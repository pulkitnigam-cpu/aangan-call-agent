import { after } from "next/server";
import { getSql } from "@/lib/db";
import { classifyQuestion } from "@/lib/gemini";
import { handleTelegramUpdate, sweep } from "@/lib/leads";
import { TelegramUpdateSchema } from "@/lib/schemas";
import { verifyTelegram } from "@/lib/security";

// POST /api/telegram/webhook — button taps and commands from designers and the front desk.
export async function POST(request: Request) {
  if (!verifyTelegram(request.headers)) return Response.json({ error: "bad secret" }, { status: 401 });
  const sql = getSql();
  try {
    const update = TelegramUpdateSchema.safeParse(await request.json());
    if (update.success) await handleTelegramUpdate(sql, update.data, new Date(), { classify: classifyQuestion });
  } catch (err) {
    console.error("[telegram] update failed", err);
  }
  after(() => sweep(sql, new Date()).catch((err) => console.error("[sweep after telegram]", err)));
  return Response.json({ ok: true }); // always 200: Telegram retries otherwise, and taps aren't worth retrying
}
