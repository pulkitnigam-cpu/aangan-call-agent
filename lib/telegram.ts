// Telegram Bot API: lead cards for designers, a front-desk group, alerts to
// Nikhil. Buttons carry short callback codes, handled by
// app/api/telegram/webhook (see lib/leads.ts handleDesignerAction).

import { bookingLink } from "./calendly";
import type { Designer, Lead } from "./types";

type Button = { text: string; callback_data: string } | { text: string; url: string };
export type Keyboard = Button[][];

let warned = false;

async function tg<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    if (!warned) console.warn("[telegram] TELEGRAM_BOT_TOKEN not set; messages are only logged");
    warned = true;
    console.log(`[telegram:${method}]`, JSON.stringify(body).slice(0, 300));
    return null;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string } | null;
  if (!json?.ok) {
    console.error(`[telegram] ${method} failed: ${json?.description ?? res.status}`);
    return null;
  }
  return json.result ?? null;
}

/** Sends a message; returns its message_id. `silent` = no sound (night-time). */
export async function sendMessage(
  chatId: string,
  html: string,
  opts: { keyboard?: Keyboard; silent?: boolean } = {},
): Promise<number | null> {
  const r = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_notification: !!opts.silent,
    link_preview_options: { is_disabled: true },
    ...(opts.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
  });
  return r?.message_id ?? null;
}

export async function editMessage(chatId: string, messageId: number, html: string, keyboard?: Keyboard): Promise<void> {
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard ?? [] },
  });
}

export async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  await tg("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

export const frontDeskChat = () => process.env.TELEGRAM_FRONTDESK_CHAT_ID ?? "";
export const nikhilChat = () => process.env.TELEGRAM_NIKHIL_CHAT_ID ?? "";

export async function sendFrontDesk(html: string, keyboard?: Keyboard, silent = false): Promise<number | null> {
  return frontDeskChat() ? sendMessage(frontDeskChat(), html, { keyboard, silent }) : null;
}

export async function sendNikhil(html: string): Promise<void> {
  if (nikhilChat()) await sendMessage(nikhilChat(), html);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function esc(s: string | number | null | undefined): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
});
export const fmtTime = (d: Date | null | undefined) => (d ? IST_TIME.format(d) : "—");

/** "+919812345678" -> "+91 98123 45678" (Telegram makes it tap-to-call). */
export function fmtPhone(p: string): string {
  const m = p.match(/^\+91(\d{5})(\d{5})$/);
  return m ? `+91 ${m[1]} ${m[2]}` : p;
}

function line(label: string, value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : `<b>${label}:</b> ${esc(value as string)}`;
}

export function leadCardText(lead: Lead, header: string): string {
  const size = [lead.bhk ? `${lead.bhk}BHK` : null, lead.size_sqft ? `${lead.size_sqft} sq ft` : null].filter(Boolean).join(", ");
  const lines = [
    header,
    "",
    `<b>${esc(lead.name ?? "Name not given")}</b> · ${esc(fmtPhone(lead.phone))}`,
    line("Area", lead.area),
    line("Space", [lead.property_type ?? lead.project_kind, size].filter(Boolean).join(" · ")),
    line("Scope", lead.scope),
    line("Current state", lead.current_state),
    line("Timeline", lead.timeline),
    line("Possession", lead.possession),
    line("Budget (their words)", lead.budget),
    line("Decision", lead.decision_maker && lead.decision_maker !== "unknown" ? lead.decision_maker.replace("_", " ") : null),
    line("Rented", lead.rented ? "yes (no structural changes)" : null),
    line("Source", lead.source),
    line("Visit times", lead.consultation_preference),
    lead.summary ? `\n${esc(lead.summary)}` : null,
    lead.open_questions.length ? `\n<b>They asked:</b> ${esc(lead.open_questions.join("; "))}` : null,
    lead.handoff_notes.length ? `<b>Note:</b> ${esc(lead.handoff_notes.join("; "))}` : null,
    lead.needs_review ? `\n⚠️ <b>Review:</b> ${esc(lead.review_reason)}` : null,
    "",
    `<b>Call back by:</b> ${fmtTime(lead.due_at)}`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// Callback codes (Telegram allows 64 bytes): "<action>:<lead uuid>[:<reason>]"
export const NOT_FIT_REASONS: Record<string, string> = {
  ar: "Outside our area",
  bu: "Budget",
  ti: "Timeline",
  sc: "Not design + execution",
  ot: "Other",
};

/** "Open in dashboard" — only with a real https base URL (Telegram rejects localhost links). */
export function dashboardLink(leadId: string): string | null {
  const base = process.env.APP_BASE_URL ?? "";
  return base.startsWith("https://") ? `${base.replace(/\/+$/, "")}/dashboard/leads/${leadId}` : null;
}

const withDashboard = (rows: Keyboard, leadId: string): Keyboard => {
  const link = dashboardLink(leadId);
  return link ? [...rows, [{ text: "🖥 Open in dashboard (transcript)", url: link }]] : rows;
};

export function newLeadKeyboard(leadId: string): Keyboard {
  return withDashboard([[
    { text: "✅ Accept", callback_data: `a:${leadId}` },
    { text: "↪️ Can't take", callback_data: `x:${leadId}` },
  ]], leadId);
}

export function acceptedKeyboard(lead: Lead, designer: Designer): Keyboard {
  const rows: Keyboard = [[
    { text: "📞 Called", callback_data: `c:${lead.id}` },
    { text: "📅 Visit booked", callback_data: `v:${lead.id}` },
    { text: "🚫 Not a fit", callback_data: `n:${lead.id}` },
  ]];
  const link = bookingLink(designer, lead);
  if (link) rows.push([{ text: "Book the site visit (Calendly)", url: link }]);
  return withDashboard(rows, lead.id);
}

export function notFitReasonKeyboard(leadId: string): Keyboard {
  return [Object.entries(NOT_FIT_REASONS).map(([code, text]) => ({ text, callback_data: `r:${leadId}:${code}` }))];
}

export function frontDeskKeyboard(leadId: string): Keyboard {
  return withDashboard([[{ text: "📞 Called back", callback_data: `f:${leadId}` }]], leadId);
}

/** The lead card a designer gets. Silent outside studio hours. */
export async function sendLeadCard(lead: Lead, designer: Designer, header: string, silent: boolean): Promise<number | null> {
  if (!designer.telegram_chat_id) return null;
  return sendMessage(designer.telegram_chat_id, leadCardText(lead, header), { keyboard: newLeadKeyboard(lead.id), silent });
}

// ---------------------------------------------------------------------------
// Call transcript as a file, threaded under the lead card
// ---------------------------------------------------------------------------

/** Sends a text file (multipart). Returns its message_id. */
export async function sendDocument(
  chatId: string,
  filename: string,
  content: string,
  opts: { caption?: string; replyTo?: number | null; silent?: boolean } = {},
): Promise<number | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log(`[telegram:sendDocument] ${chatId} ${filename} (${content.length} chars)`);
    return null;
  }
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", new Blob([content], { type: "text/plain;charset=utf-8" }), filename);
  if (opts.caption) {
    form.append("caption", opts.caption);
    form.append("parse_mode", "HTML");
  }
  if (opts.replyTo) form.append("reply_parameters", JSON.stringify({ message_id: opts.replyTo, allow_sending_without_reply: true }));
  form.append("disable_notification", String(!!opts.silent));
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
  const json = (await res.json().catch(() => null)) as { ok: boolean; result?: { message_id: number }; description?: string } | null;
  if (!json?.ok) {
    console.error(`[telegram] sendDocument failed: ${json?.description ?? res.status}`);
    return null;
  }
  return json.result?.message_id ?? null;
}

const FILE_DATE = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

/** The transcript file a designer (or the front desk) gets with a lead. */
export function transcriptFile(
  lead: Pick<Lead, "name" | "phone" | "area">,
  call: { started_at: Date; duration_sec: number | null; transcript: string },
): { filename: string; content: string } {
  const stamp = FILE_DATE.format(call.started_at).replace(/\D/g, "").slice(0, 12); // yyyymmddhhmm
  const safeName = (lead.name ?? "caller").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, "-") || "caller";
  const header = [
    "Aangan Studio — call transcript",
    `Caller: ${lead.name ?? "not given"} · ${fmtPhone(lead.phone)}`,
    `Area: ${lead.area ?? "—"}`,
    `Call: ${fmtTime(call.started_at)} IST · ${call.duration_sec === null ? "—" : `${Math.floor(call.duration_sec / 60)}m ${call.duration_sec % 60}s`}`,
    "─".repeat(40),
    "",
  ].join("\n");
  return { filename: `transcript-${safeName}-${stamp}.txt`, content: header + call.transcript };
}
