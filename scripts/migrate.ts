// Applies db/migrations/*.sql in filename order, once each, and optionally
// db/seed.sql. Usage:
//   npm run db:migrate
//   npm run db:seed
//
// Uses DATABASE_URL_UNPOOLED when set (a direct connection is safer for DDL),
// otherwise DATABASE_URL. (In production the same code runs inside Vercel via
// POST /api/admin/migrate, so the database password never leaves Vercel.)
import { config } from "dotenv";
import path from "node:path";
import postgres from "postgres";
import { runMigrations, runSeed } from "../lib/migrations";

config({ path: [".env.local", ".env"], quiet: true });

const root = path.resolve(__dirname, "..");
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (and optionally DATABASE_URL_UNPOOLED) in .env.local or .env");
  process.exit(1);
}
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, { prepare: false, ssl: isLocal ? false : "require", max: 1, onnotice: () => {} });

async function main() {
  if (process.argv[2] === "seed") {
    console.log(`seeded designers (total ${await runSeed(sql, root)})`);
    return;
  }
  for (const r of await runMigrations(sql, root)) console.log(`${r.applied ? "apply" : "skip "}  ${r.file}`);
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
