// Test helpers: a real Postgres (PGlite, in memory) with our migrations, and a
// fake Telegram that records every message instead of sending it.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { closeSql, getSql } from "../lib/db";
import { parseExtraction } from "../lib/gemini";
import type { CallEndedEvent } from "../lib/voice/types";

export const CHAT = { frontDesk: "-100", nikhil: "999", ananya: "101", rohan: "102", meera: "103" };

export async function startTestDb() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  for (const f of readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join("db/migrations", f), "utf8"));
  }
  const port = 56000 + Math.floor(Math.random() * 3000);
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 4 });
  await server.start();

  Object.assign(process.env, {
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    DB_POOL_MAX: "1",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_FRONTDESK_CHAT_ID: CHAT.frontDesk,
    TELEGRAM_NIKHIL_CHAT_ID: CHAT.nikhil,
    COST_PER_MIN_VANI_INR: "6",
    COST_PER_1K_INPUT_GEMINI_INR: "0.04",
    COST_PER_1K_OUTPUT_GEMINI_INR: "0.08",
  });
  await closeSql();
  const sql = getSql();

  return {
    sql,
    async reset() {
      await db.exec(`
        truncate lead_events, leads, calls restart identity cascade;
        delete from designers;
        insert into designers (name, areas, telegram_chat_id, calendly_link) values
          ('Ananya Kulkarni', '{kothrud,warje,bavdhan}', '${CHAT.ananya}', 'https://calendly.com/aangan-ananya/site-visit'),
          ('Rohan Joshi', '{baner,aundh,wakad,hinjewadi}', '${CHAT.rohan}', 'https://calendly.com/aangan-rohan/site-visit'),
          ('Meera Patil', '{kharadi,viman nagar,hadapsar}', '${CHAT.meera}', 'https://calendly.com/aangan-meera/site-visit');
      `);
    },
    async stop() {
      await closeSql();
      await server.stop();
      await db.close();
    },
  };
}

export interface Sent {
  method: string;
  body: Record<string, unknown>;
}

/** Replaces fetch: Telegram calls are recorded and succeed; anything else fails the test. */
export function fakeTelegram() {
  const sent: Sent[] = [];
  let nextId = 1000;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("https://api.telegram.org/")) throw new Error(`unexpected fetch: ${u}`);
    let body: Record<string, unknown>;
    if (init?.body instanceof FormData) {
      // sendDocument: record the fields, plus the file's name and text.
      body = {};
      for (const [k, v] of init.body.entries()) {
        if (typeof v === "string") body[k] = v;
        else body[k] = { filename: (v as File).name, text: await (v as Blob).text() };
      }
    } else {
      body = JSON.parse(String(init?.body ?? "{}"));
    }
    sent.push({ method: u.split("/").pop()!, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++nextId } }));
  }) as typeof fetch;
  return {
    sent,
    messagesTo: (chat: string) => sent.filter((s) => s.method === "sendMessage" && s.body.chat_id === chat),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

let seq = 0;

/** A finished call, with sensible defaults for a qualified Baner 2BHK enquiry. */
export function endedCall(at: string, extraction: Record<string, unknown> = {}, over: Partial<CallEndedEvent> = {}): CallEndedEvent {
  return {
    providerCallId: `v-${++seq}`,
    callerPhone: "+91 98123 45678",
    startedAt: new Date(at),
    endedAt: new Date(new Date(at).getTime() + 4 * 60_000),
    durationSec: 240,
    status: "completed",
    recordingConsent: true,
    turns: [
      { role: "agent", text: "Hi, this is Aangan Studio's assistant." },
      { role: "caller", text: "Hi, I have a 2BHK in Baner." },
    ],
    extraction: parseExtraction({
      category: "new_project",
      language: "en",
      recording_consent: true,
      name: "Priya",
      area: "Baner",
      project_kind: "home",
      scope_kind: "full_home",
      bhk: 2,
      size_sqft: 950,
      intent: "design_and_execution",
      decision_maker: "self",
      promised_outcome: "designer_callback",
      score: "qualified",
      summary: "2BHK in Baner, full redesign.",
      ...extraction,
    }),
    llmInputTokens: 1500,
    llmOutputTokens: 500,
    raw: { test: true },
    ...over,
  };
}
