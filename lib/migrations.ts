import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type postgres from "postgres";

// Applies db/migrations/*.sql in order, once each, under a lock so two runs
// can't collide. Used by `npm run db:migrate` and POST /api/admin/migrate.

const MIGRATION_LOCK_ID = 7_242_001;

export async function runMigrations(sql: postgres.Sql, root: string): Promise<{ file: string; applied: boolean }[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const dir = path.join(root, "db", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const results: { file: string; applied: boolean }[] = [];
  for (const file of files) {
    const body = await readFile(path.join(dir, file), "utf8");
    const applied = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
      const [done] = await tx`select 1 from schema_migrations where name = ${file}`;
      if (done) return false;
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
      return true;
    });
    results.push({ file, applied });
  }
  return results;
}

export async function runSeed(sql: postgres.Sql, root: string): Promise<number> {
  await sql.unsafe(await readFile(path.join(root, "db", "seed.sql"), "utf8"));
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from designers`;
  return n;
}
