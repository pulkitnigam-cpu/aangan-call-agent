import { NextResponse, type NextRequest } from "next/server";

// Optimistic gate: no session cookie → sign-in page. The real check (signature,
// expiry, still an active designer) runs on every page in lib/auth/current-user.ts.
export function proxy(request: NextRequest) {
  if (!request.cookies.has("aangan_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*"] };
