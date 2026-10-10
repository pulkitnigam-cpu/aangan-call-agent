import { connection } from "next/server";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { verifyCron } from "@/lib/security";

// Manage designers without touching the database by hand.
//   GET  /api/admin/designers           → list
//   POST /api/admin/designers  {name, email?, telegram_chat_id?, areas?, calendly_link?, active?}
//        → adds, or updates the designer with the same email / Telegram chat
// Both require "Authorization: Bearer <CRON_SECRET>".

const Designer = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().optional(),
  telegram_chat_id: z.string().regex(/^-?\d{4,20}$/).optional(),
  areas: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(40).default([]),
  calendly_link: z.string().url().optional(),
  active: z.boolean().default(true),
});

export async function GET(request: Request) {
  await connection();
  if (!verifyCron(request.headers)) return Response.json({ error: "unauthorised" }, { status: 401 });
  const rows = await getSql()`select id, name, email, telegram_chat_id, areas, calendly_link, active from designers order by name`;
  return Response.json({ designers: rows });
}

export async function POST(request: Request) {
  await connection();
  if (!verifyCron(request.headers)) return Response.json({ error: "unauthorised" }, { status: 401 });
  const parsed = Designer.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const d = parsed.data;
  const sql = getSql();
  const [existing] = await sql<{ id: string }[]>`
    select id from designers
    where (${d.email ?? null}::text is not null and email = ${d.email ?? null})
       or (${d.telegram_chat_id ?? null}::text is not null and telegram_chat_id = ${d.telegram_chat_id ?? null})
    limit 1
  `;
  const values = { name: d.name, email: d.email ?? null, telegram_chat_id: d.telegram_chat_id ?? null, areas: d.areas, calendly_link: d.calendly_link ?? null, active: d.active };
  const [row] = existing
    ? await sql`update designers set ${sql(values)} where id = ${existing.id} returning id, name, email, telegram_chat_id, areas, active`
    : await sql`insert into designers ${sql(values)} returning id, name, email, telegram_chat_id, areas, active`;
  return Response.json({ ok: true, action: existing ? "updated" : "added", designer: row });
}
