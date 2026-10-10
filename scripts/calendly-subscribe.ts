// Subscribes the app to Calendly bookings (invitee.created / invitee.canceled).
//
//   npm run calendly:subscribe
//
// Needs CALENDLY_TOKEN (personal access token), CALENDLY_WEBHOOK_SIGNING_KEY
// (any random string; Calendly signs payloads with it) and APP_BASE_URL.
// Calendly webhooks need a paid plan. On a free plan this exits cleanly: the
// designer's "Visit booked" button in Telegram records bookings instead.

import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const API = "https://api.calendly.com";
const token = process.env.CALENDLY_TOKEN;
const signingKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
const base = process.env.APP_BASE_URL;

async function calendly(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

async function main() {
  if (!token || !signingKey || !base?.startsWith("https://")) {
    throw new Error("Set CALENDLY_TOKEN, CALENDLY_WEBHOOK_SIGNING_KEY and APP_BASE_URL (https)");
  }
  const me = await calendly("GET", "/users/me");
  if (me.status !== 200) throw new Error(`Calendly token rejected (${me.status})`);
  const organization = me.json.resource.current_organization as string;
  const url = `${base.replace(/\/+$/, "")}/api/calendly/webhook`;

  const r = await calendly("POST", "/webhook_subscriptions", {
    url,
    events: ["invitee.created", "invitee.canceled"],
    organization,
    scope: "organization",
    signing_key: signingKey,
  });
  if (r.status === 201) console.log(`subscribed → ${url}`);
  else if (r.status === 409) console.log(`already subscribed → ${url}`);
  else if (r.status === 403) console.log("This Calendly plan doesn't include webhooks — skipping. The Telegram 'Visit booked' button covers bookings.");
  else throw new Error(`Calendly ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
