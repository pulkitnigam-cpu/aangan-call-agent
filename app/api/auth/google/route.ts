import { cookies } from "next/headers";
import { buildAuthUrl, randomToken } from "@/lib/auth/google";
import { cookieOptions } from "@/lib/auth/session";

// GET /api/auth/google — starts "Sign in with Google". There is no sign-up.
export async function GET() {
  const state = randomToken();
  const nonce = randomToken();
  (await cookies()).set("aangan_oauth", `${state}.${nonce}`, cookieOptions(600));
  return Response.redirect(buildAuthUrl(state, nonce), 302);
}
