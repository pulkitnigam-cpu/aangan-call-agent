import { createHmac, timingSafeEqual } from "node:crypto";

// A signed session cookie: base64url(JSON) + "." + HMAC-SHA256. No database
// table, no passwords — the only way in is Google sign-in (lib/auth/google.ts),
// and every page re-checks the person is still allowed (lib/auth/current-user.ts).

export const SESSION_COOKIE = "aangan_session";
export const SESSION_HOURS = 12;

export interface Session {
  email: string;
  name: string;
  role: "designer" | "admin";
  designerId: string | null;
  exp: number; // unix seconds
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ random characters)");
  return s;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function encodeSession(s: Omit<Session, "exp">, now = new Date()): string {
  const full: Session = { ...s, exp: Math.floor(now.getTime() / 1000) + SESSION_HOURS * 3600 };
  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Returns the session if the signature is valid and it hasn't expired; otherwise null. */
export function decodeSession(cookie: string | undefined, now = new Date()): Session | null {
  if (!cookie) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (typeof s.exp !== "number" || s.exp * 1000 < now.getTime()) return null;
    if (s.role !== "designer" && s.role !== "admin") return null;
    return s;
  } catch {
    return null;
  }
}

export const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: maxAgeSeconds,
});
