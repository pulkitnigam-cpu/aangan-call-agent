import { connection } from "next/server";
import postgres from "postgres";
import { runMigrations } from "@/lib/migrations";
import { verifyCron } from "@/lib/security";

// POST /api/admin/migrate — creates/updates the tables from inside Vercel, using
// the database connection Vercel already holds (no password leaves Vercel).
// GET  /api/admin/migrate — diagnostics: which DB variables exist and whether it connects.
// Both require "Authorization: Bearer <CRON_SECRET>".

const url = () => process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

function client() {
  const u = url();
  if (!u) throw new Error("No DATABASE_URL / DATABASE_URL_UNPOOLED in this deployment");
  return postgres(u, { prepare: false, ssl: "require", max: 1, onnotice: () => {} });
}

export async function GET(request: Request) {
  await connection();
  if (!verifyCron(request.headers)) return Response.json({ error: "unauthorised" }, { status: 401 });
  const present = Object.keys(process.env).filter((k) => /^(DATABASE|POSTGRES|PG|NEON|STORAGE)_?/.test(k)).sort();
  if (!url()) return Response.json({ connected: false, present, error: "no DATABASE_URL variable" });
  const sql = client();
  try {
    const [r] = await sql<{ db: string; tables: number }[]>`
      select current_database() as db, (select count(*)::int from information_schema.tables where table_schema = 'public') as tables`;
    return Response.json({ connected: true, present, database: r.db, publicTables: r.tables });
  } catch (err) {
    return Response.json({ connected: false, present, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function POST(request: Request) {
  await connection();
  if (!verifyCron(request.headers)) return Response.json({ error: "unauthorised" }, { status: 401 });
  const sql = client();
  try {
    return Response.json({ ok: true, migrations: await runMigrations(sql, process.cwd()) });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, { status: 500 });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
