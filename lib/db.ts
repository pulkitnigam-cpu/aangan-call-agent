import postgres from "postgres";
import { numberEnv, requireEnv } from "./env";

// One Postgres client for the whole app. Works with Neon or Supabase:
// set DATABASE_URL to the provider's *pooled* connection string.
//
// prepare: false — both Neon's and Supabase's poolers run in transaction
// mode, which doesn't support named prepared statements.

declare global {
  // Reuse the client across hot reloads in `next dev`.
  var __sql: postgres.Sql | undefined;
}

function createClient(): postgres.Sql {
  const url = requireEnv("DATABASE_URL");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return postgres(url, {
    prepare: false,
    ssl: isLocal ? false : "require",
    max: numberEnv("DB_POOL_MAX", 5), // serverless: keep each instance's footprint small
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

export function getSql(): postgres.Sql {
  if (!globalThis.__sql) globalThis.__sql = createClient();
  return globalThis.__sql;
}

/** Closes the shared client (tests, scripts). The next getSql() reconnects. */
export async function closeSql(): Promise<void> {
  const sql = globalThis.__sql;
  globalThis.__sql = undefined;
  if (sql) await sql.end({ timeout: 5 });
}
