import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSql } from "../db";
import { authorize } from "./google";
import { decodeSession, SESSION_COOKIE, type Session } from "./session";

/**
 * The data-access-layer check every dashboard page runs. The proxy only looks
 * for a cookie; this verifies its signature and expiry, and re-checks the
 * database, so removing a designer (or marking them inactive) locks them out
 * immediately, not when their cookie expires.
 */
export async function getCurrentUser(): Promise<Session> {
  const session = decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  const still = await authorize(getSql(), session.email);
  if (!still) redirect("/login?error=not_allowed");
  return { ...session, role: still.role, designerId: still.designerId };
}
