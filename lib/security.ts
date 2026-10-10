import { createHmac, timingSafeEqual } from "node:crypto";

// Every webhook proves it came from the real sender before we act on it.
// All checks fail closed: a missing secret means "reject", never "allow".

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Vaani Voice webhooks (Settings → Webhooks). Vaani documents HMAC signing
 * only for campaign webhooks:
 *   X-Vaani-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)>
 *   X-Vaani-Timestamp: <unix seconds>   (reject if > 5 min old)
 * The general call webhooks show no signature, so we ALSO accept a secret token
 * in the webhook URL we register: …/api/voice/webhook?token=<VANI_WEBHOOK_TOKEN>.
 * Either proof is enough; with neither, the request is rejected.
 */
export function verifyVaaniWebhook(rawBody: string, headers: Headers, url: string, now = new Date()): boolean {
  const sig = headers.get("x-vaani-signature");
  const ts = headers.get("x-vaani-timestamp");
  const secret = process.env.VANI_WEBHOOK_SECRET;
  if (sig && ts && secret) {
    const t = Number(ts);
    if (!Number.isFinite(t) || Math.abs(now.getTime() / 1000 - t) > 300) return false;
    return safeEqual(sig, `sha256=${hmacHex(secret, `${ts}.${rawBody}`)}`);
  }
  const expected = process.env.VANI_WEBHOOK_TOKEN;
  const given = new URL(url).searchParams.get("token");
  return !!expected && expected.length >= 24 && !!given && safeEqual(given, expected);
}

/** Test/helper: Vaani's documented signature for a body. */
export function signVaani(rawBody: string, secret: string, ts: number): string {
  return `sha256=${hmacHex(secret, `${ts}.${rawBody}`)}`;
}

/**
 * The agent's custom tools (check_fit, callback_times). We write the tool's
 * cURL in Vaani ourselves, including this header, so only our agent can call them.
 */
export function verifyVaaniTool(headers: Headers): boolean {
  const secret = process.env.VANI_TOOL_SECRET;
  const given = headers.get("x-aangan-tool-key");
  return !!secret && secret.length >= 24 && !!given && safeEqual(given, secret);
}

/** Telegram: the secret_token we registered with setWebhook, echoed in a header. */
export function verifyTelegram(headers: Headers): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const header = headers.get("x-telegram-bot-api-secret-token");
  return !!secret && !!header && safeEqual(header, secret);
}

/**
 * Calendly: header "Calendly-Webhook-Signature: t=<unix>,v1=<hex>", where
 * v1 = HMAC-SHA256(signing key, `${t}.${rawBody}`). Rejects anything older than
 * 3 minutes to stop replays.
 */
export function verifyCalendly(rawBody: string, headers: Headers, now = new Date()): boolean {
  const key = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  const header = headers.get("calendly-webhook-signature");
  if (!key || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t)) return false;
  if (Math.abs(now.getTime() / 1000 - t) > 180) return false;
  return safeEqual(parts.v1, hmacHex(key, `${t}.${rawBody}`));
}

export function signCalendly(rawBody: string, key: string, t: number): string {
  return `t=${t},v1=${hmacHex(key, `${t}.${rawBody}`)}`;
}

/** Cron: "Authorization: Bearer <CRON_SECRET>". */
export function verifyCron(headers: Headers): boolean {
  const secret = process.env.CRON_SECRET;
  const header = headers.get("authorization");
  return !!secret && !!header && safeEqual(header, `Bearer ${secret}`);
}
