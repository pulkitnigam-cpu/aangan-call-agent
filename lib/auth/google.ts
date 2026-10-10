import { randomBytes } from "node:crypto";
import type postgres from "postgres";

// Google OAuth 2.0 / OpenID Connect, authorization-code flow.
// No sign-up: Google proves who you are; our designers table (or
// DASHBOARD_ADMIN_EMAILS) decides whether you're allowed in.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function redirectUri(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) throw new Error("APP_BASE_URL must be set");
  return `${base.replace(/\/$/, "")}/api/auth/callback`;
}

export const randomToken = () => randomBytes(24).toString("base64url");

export function buildAuthUrl(state: string, nonce: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID must be set");
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export interface GoogleIdentity {
  email: string;
  name: string;
}

/**
 * Checks the ID token's claims. The token came straight from Google's token
 * endpoint over TLS in exchange for our client secret, so per OpenID Connect
 * Core §3.1.3.7 its signature need not be re-verified; the claims still must be.
 */
export function validateIdToken(idToken: string, expectedNonce: string, now = new Date()): GoogleIdentity {
  const [, body] = idToken.split(".");
  if (!body) throw new Error("malformed id_token");
  const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  if (!["accounts.google.com", "https://accounts.google.com"].includes(String(c.iss))) throw new Error("bad issuer");
  if (c.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error("bad audience");
  if (typeof c.exp !== "number" || c.exp * 1000 < now.getTime()) throw new Error("expired");
  if (c.nonce !== expectedNonce) throw new Error("bad nonce");
  if (c.email_verified !== true || typeof c.email !== "string") throw new Error("email not verified");
  return { email: c.email.toLowerCase(), name: typeof c.name === "string" ? c.name : c.email };
}

export async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !json.id_token) throw new Error(`token exchange failed: ${json.error ?? res.status}`);
  return json.id_token;
}

export function adminEmails(): string[] {
  return (process.env.DASHBOARD_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Who this Google account is to us, or null if they're not allowed in. */
export async function authorize(
  sql: postgres.Sql,
  email: string,
): Promise<{ role: "designer" | "admin"; designerId: string | null; name: string | null } | null> {
  const [d] = await sql<{ id: string; name: string }[]>`
    select id, name from designers where email = ${email.toLowerCase()} and active
  `;
  if (d) return { role: "designer", designerId: d.id, name: d.name };
  if (adminEmails().includes(email.toLowerCase())) return { role: "admin", designerId: null, name: null };
  return null;
}
