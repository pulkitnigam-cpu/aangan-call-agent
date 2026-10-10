import { connection } from "next/server";
import { getSql } from "@/lib/db";

// GET /api/health — confirms the app is up and the database is reachable.
export async function GET() {
  await connection(); // always run at request time, never prerender at build
  try {
    const sql = getSql();
    const [row] = await sql<{ designers: number }[]>`
      select count(*)::int as designers from designers where active
    `;
    return Response.json({ ok: true, db: "up", activeDesigners: row.designers });
  } catch (err) {
    // Details go to the server log only: DB errors can include hostnames.
    console.error("[health] database check failed", err);
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
