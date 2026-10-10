// Applies db/migrations/*.sql in filename order, once each, and optionally
// db/seed.sql. Usage:
//   npm run db:migrate
//   npm run db:seed
//
// Uses DATABASE_URL_UNPOOLED when set (a direct connection is safer for DDL),
// otherwise DATABASE_URL.
import { config } from "dotenv";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

config({ path: [".env.local", ".env"], quiet: true });

const root = path.resolve(__dirname, "..");
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (and optionally DATABASE_URL_UNPOOLED) in .env.local or .env");
  process.exit(1);
}
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, { prepare: false, ssl: isLocal ? false : "require", max: 1, onnotice: () => {} });

// Any fixed number; stops two people migrating the same database at once.
const MIGRATION_LOCK_ID = 7_242_001;

async function migrate() {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const dir = path.join(root, "db", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  // Each file runs in its own transaction, under a transaction-scoped lock,
  // re-checking schema_migrations inside it so a concurrent run can't double-apply.
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
    console.log(`${applied ? "apply" : "skip "}  ${file}`);
  }
}

async function seed() {
  await sql.unsafe(await readFile(path.join(root, "db", "seed.sql"), "utf8"));
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from designers`;
  console.log(`seeded designers (total ${n})`);
}

const task = process.argv[2] === "seed" ? seed : migrate;
task()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
