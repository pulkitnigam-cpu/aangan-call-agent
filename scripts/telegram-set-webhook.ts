// Points the Telegram bot at the deployed app and sets its command menu.
//
//   npm run telegram:webhook
//
// Needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (32+ random chars) and
// APP_BASE_URL (the https Vercel address) in the environment / .env.local.

import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const base = process.env.APP_BASE_URL;
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN");
if (!secret || secret.length < 32) throw new Error("Set TELEGRAM_WEBHOOK_SECRET (32+ random characters)");
if (!base?.startsWith("https://")) throw new Error("Set APP_BASE_URL to the deployed https address");

async function tg(method: string, body?: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

async function main() {
  const url = `${base!.replace(/\/+$/, "")}/api/telegram/webhook`;
  await tg("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"] });
  console.log(`webhook → ${url}`);

  await tg("setMyCommands", {
    commands: [
      { command: "today", description: "Today's numbers" },
      { command: "week", description: "Last 7 days" },
      { command: "pending", description: "Who's waiting for a call" },
      { command: "lead", description: "Find a lead: /lead Priya" },
      { command: "cost", description: "What the system costs (Nikhil, front desk)" },
      { command: "designers", description: "Numbers per designer (Nikhil, front desk)" },
      { command: "help", description: "What you can ask" },
    ],
  });
  console.log("command menu set");

  const info = (await tg("getWebhookInfo")) as { url: string; pending_update_count: number; last_error_message?: string };
  console.log(`check: url=${info.url} pending=${info.pending_update_count}${info.last_error_message ? ` last_error="${info.last_error_message}"` : ""}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
