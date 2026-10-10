import type postgres from "postgres";
import { areaMatches } from "./policy";
import type { Designer } from "./types";

/**
 * Picks the designer for a lead: an active designer (with Telegram set up) who
 * covers the area, else anyone active; least recently assigned first, so work
 * rotates. Skips designers who already passed on or timed out on this lead.
 */
export async function pickDesigner(
  sql: postgres.Sql,
  area: string | null,
  exclude: string[],
  now: Date,
): Promise<Designer | null> {
  const candidates = await sql<Designer[]>`
    select * from designers
    where active and telegram_chat_id is not null
      and not (id = any(${exclude}::uuid[]))
    order by last_assigned_at asc nulls first, name asc
  `;
  if (candidates.length === 0) return null;

  const local = area ? candidates.filter((d) => areaMatches(area, d.areas)) : [];
  const chosen = local[0] ?? candidates[0];
  await sql`update designers set last_assigned_at = ${now} where id = ${chosen.id}`;
  return chosen;
}
