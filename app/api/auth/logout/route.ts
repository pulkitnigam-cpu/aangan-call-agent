import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/session";

// POST /api/auth/logout
export async function POST(request: Request) {
  (await cookies()).delete(SESSION_COOKIE);
  return Response.redirect(new URL("/login", request.url), 303);
}
