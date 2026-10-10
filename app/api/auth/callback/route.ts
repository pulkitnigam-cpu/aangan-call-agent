import { cookies } from "next/headers";
import { getSql } from "@/lib/db";
import { authorize, exchangeCode, validateIdToken } from "@/lib/auth/google";
import { cookieOptions, encodeSession, SESSION_COOKIE, SESSION_HOURS } from "@/lib/auth/session";

// GET /api/auth/callback — Google sends the user back here.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const [state, nonce] = (jar.get("aangan_oauth")?.value ?? "").split(".");
  jar.delete("aangan_oauth");
  const back = (error: string) => Response.redirect(new URL(`/login?error=${error}`, url), 302);

  if (!state || url.searchParams.get("state") !== state) return back("expired");
  const code = url.searchParams.get("code");
  if (!code) return back("cancelled");

  try {
    const identity = validateIdToken(await exchangeCode(code), nonce);
    const who = await authorize(getSql(), identity.email);
    if (!who) return back("not_allowed");
    jar.set(
      SESSION_COOKIE,
      encodeSession({ email: identity.email, name: who.name ?? identity.name, role: who.role, designerId: who.designerId }),
      cookieOptions(SESSION_HOURS * 3600),
    );
    return Response.redirect(new URL("/dashboard", url), 302);
  } catch (err) {
    console.error("[auth] sign-in failed", err instanceof Error ? err.message : err);
    return back("failed");
  }
}
