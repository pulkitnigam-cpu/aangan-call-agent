# Aangan Call Agent

AI phone receptionist for Aangan Studio (Pune). Missed and after-hours calls go to a
Vaani Voice agent. It collects the enquiry and checks fit against Nikhil's rules,
live, during the call. This backend then gives the lead to one designer on Telegram,
chases until the promised callback happens, and logs everything for Nikhil's HubSpot
dashboard.

**Stack:** Next.js on Vercel · Neon (serverless Postgres, RLS on) · Vaani Voice · Gemini · Telegram ·
Calendly · HubSpot · Google OAuth · GitHub Actions (the sweep).

**Three ways in:**
- **Nikhil** → HubSpot dashboard ([docs/hubspot-dashboard.md](docs/hubspot-dashboard.md))
- **Designers** → the Vercel dashboard at `/dashboard`: charts first, click any lead for its full history. Google sign-in only.
- **Everyone on the team** → the Telegram bot: ask in plain words ("who's waiting for a call?")

> **Strict rule:** the calling agent answers only from `knowledge/` and the hard rules. See [CLAUDE.md](CLAUDE.md).

## Build progress

| Step | What | Status |
| ---- | ---- | ------ |
| 1 | Project setup, database, health check | done |
| 2 | Agent config (prompt, schema, forwarding), guardrails as code | done |
| 3 | Vaani Voice: `/api/voice/webhook`, tools `check-fit` + `callback-times`, `npm run vaani:setup` | done (built from docs.vaanivoice.ai) |
| 4 | Telegram: lead cards, Accept / Can't take, reassignment, `/log`, **data bot** | done |
| 5 | Calendly (lead-ID links) · **HubSpot sync** + `hubspot:setup` | done |
| 6 | Sweep · **designers' dashboard + Google sign-in** · HubSpot dashboard guide | done |
| 7 | Create the Vaani agent, number, accounts, launch | together, at setup |

## How a call flows

1. **Call starts** → `pre-call` returns the caller's history (as data, not instructions) and the
   callback times the agent may promise.
2. **Before closing** → the agent calls `check_fit`. Nikhil's rubric (`lib/policy.ts`) returns the
   exact closing line, so **the agent never promises what the system won't do**.
3. **Call ends** → `post-call` stores the call, re-scores the lead and routes it by **what the
   caller was told**. If the rules disagree, the lead is flagged for review; it's never silently
   dropped.
   - Repeat callers merge into their open lead, and the same designer is told "called again".
   - Declined recording → the transcript is deleted; only the details are kept.
   - Anything price-like the agent said → stored, and Nikhil is alerted.
4. **Designer** gets a card: **Accept** or **Can't take**. Then **Called / Visit booked / Not a
   fit** (with a reason), plus a Calendly link carrying the lead ID.
5. **The sweep** (every 5 min) keeps the promise:

   | When (for a 2-hour promise) | What happens |
   | --------------------------- | ------------ |
   | Not accepted after 30 min | Next designer (max 2 reassigns, then front desk + Nikhil) |
   | Accepted but not called, 1 hour to go | Reminder to the designer |
   | Still not called, 30 min to go | Nikhil + front desk alerted |
   | Dropped call, no ring-back in 15 min | Front-desk follow-up |
   | Call never reported back after 30 min | Marked failed, front-desk follow-up |

   Night leads: cards are silent, and the timings above count back from the noon deadline.

Callbacks run **10am–7pm every day**, weekends and holidays included.

## Database (Neon; any Postgres works)

Plain Postgres through `DATABASE_URL`. We use **Neon** (free tier). Supabase or any Postgres would work by changing two variables.

| | Neon | Supabase |
|---|---|---|
| `DATABASE_URL` (app) | Pooled string (host has `-pooler`) | Transaction pooler, port 6543 |
| `DATABASE_URL_UNPOOLED` (migrations) | Direct string | Session pooler or direct, port 5432 |
| Browse data | Neon console → Tables | Supabase Table Editor |

## Run locally

```bash
npm install
cp .env.example .env.local        # fill in DATABASE_URL at minimum
npm run db:migrate                # creates tables (safe to re-run, even concurrently)
npm run db:seed                   # 3 sample designers
DEMO=1 npm run db:seed-demo       # optional: the 26 real Sep enquiries as demo leads (refuses on real data)
npm run dev                       # http://localhost:3000/login
npm test                          # Vitest: 167 tests incl. full workflow against an in-memory Postgres
npm run eval                      # real Gemini on all 40 Sep enquiries → docs/eval-report.md (39/40)
```

## Endpoints

| Endpoint | Called by | Auth |
| -------- | --------- | ---- |
| `GET /api/health` | you / uptime monitor | — |
| `POST /api/voice/webhook?token=…` | Vaani: call_started, call_ended, call_postprocessing | secret URL token (or Vaani's `X-Vaani-Signature`) |
| `POST /api/voice/check-fit` | Vaani agent tool | `X-Aangan-Tool-Key` header |
| `POST /api/voice/callback-times` | Vaani agent tool | `X-Aangan-Tool-Key` header |
| `POST /api/telegram/webhook` | Telegram, buttons and commands | `TELEGRAM_WEBHOOK_SECRET` header |
| `POST /api/calendly/webhook` | Calendly, booking/cancel | Calendly signature, 3-min replay window |
| `GET /api/cron/sweep` | GitHub Actions every 5 min | `Bearer CRON_SECRET` |
| `GET /api/auth/google`, `/api/auth/callback`, `POST /api/auth/logout` | designers signing in | Google OAuth + signed cookie |
| `/dashboard`, `/dashboard/leads/[id]` | designers, admins | session, re-checked against `designers.email` on every page |

**Why GitHub Actions and not Vercel Cron:** Vercel's free (Hobby) plan only allows crons that run
**once a day**, and a more frequent schedule fails the deploy. `.github/workflows/sweep.yml` calls
the sweep every 5 minutes for free. The sweep also runs after every Vani and Telegram webhook.
For to-the-minute timing, point cron-job.org (free) at the same URL.

## Designers' dashboard

- **Sign-in:** "Sign in with Google" only. There's no sign-up and no password. A designer gets in
  if their Google email is in `designers.email` (and they're active). `DASHBOARD_ADMIN_EMAILS`
  can see every designer, plus the tool's running cost. Deactivating a designer locks them out on
  their next click, not when their cookie expires.
- **What a designer sees:** only their own leads. Four headline numbers (leads, visits booked,
  median callback, % on time), leads per day, pipeline, callback speed ("Late" is the only red),
  and the lead list. Click any lead for its full details, timeline and call transcript.
- **Background photo:** "white and brown living room set" by Spacejoy on Unsplash (free licence),
  loaded from Unsplash's CDN. To use one of Nikhil's own project photos instead, save it as
  `public/bg/interior.jpg` (landscape, ~2000px wide); it takes priority automatically.
- **Google OAuth client:** Google Cloud Console → APIs & Services → OAuth consent screen
  (Internal if the studio uses Google Workspace, otherwise External + test users) → Credentials →
  Create OAuth client ID → Web application → authorised redirect URI
  `https://<app>.vercel.app/api/auth/callback`. Put the ID and secret in `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET`.

## Telegram bot (data questions)

Nikhil, the front-desk group and designers can ask the bot in plain words: "how many qualified
leads this week?", "who's waiting for a call?", "show Priya's lead", "what did it cost this month?".
Commands work too: `/today /week /month /pending /lead <name> /cost /designers /help`.

- **Strict:** Gemini only picks which fixed lookup to run. The answer is built from the database
  by code, so the bot can't invent a number. Off-topic questions get the help text.
- **Who sees what:** Nikhil and the front desk see everything. A designer sees only their own
  leads and no costs. Unknown chats get no reply.
- Each Gemini call is logged in `ai_usage` and counted in the system's running cost.

## Telegram setup

1. Create the bot with @BotFather and set `TELEGRAM_BOT_TOKEN`.
2. Register the webhook (`TELEGRAM_WEBHOOK_SECRET` is any random string):
   ```bash
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" -d "url=https://<app>.vercel.app/api/telegram/webhook" -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
   ```
3. Each designer sends `/start` to the bot. It replies with their chat ID; put it in `designers.telegram_chat_id`.
4. Add the bot to the front-desk group, then send `/start` there to get `TELEGRAM_FRONTDESK_CHAT_ID`.
5. Front desk logs the calls it answers itself, so the dashboard counts every call:
   `/log 98123 45678 qualified Priya, 3BHK Kothrud, by March` (outcomes: `qualified`, `unclear`, `notfit`, `existing`, `other`).
   A qualified log goes straight to a designer.

## Layout

```
app/api/…                 the endpoints above
lib/leads.ts              what happens after a call: routing, merging, buttons, sweep, /log
lib/fit.ts                check_fit: rubric → closing line the agent says
lib/policy.ts             Nikhil's rubric, service area, price guardrail, price floors
lib/hours.ts              10am–7pm every day, callback deadlines (IST)
lib/routing.ts            picks the designer (area, then rotation)
lib/caller-context.ts     caller history for the agent, cleaned against prompt injection
lib/security.ts           webhook signature checks (all fail closed)
lib/voice/                types.ts (provider-neutral events) + vani.ts (the ONLY Vaani-specific file)
lib/gemini.ts             extraction + validation of anything the LLM returns
lib/telegram.ts           cards, buttons, alerts
lib/calendly.ts           booking links with the lead ID, webhook parsing
lib/hubspot.ts            contacts, deals, stages, tasks (retries on 429/5xx)
lib/bot.ts                Telegram data bot: plain question → fixed lookup → answer from data
lib/dashboard.ts          dashboard queries, always scoped to the signed-in designer
lib/auth/                 Google OAuth, signed session cookie, per-page re-check
lib/schemas.ts            zod schemas for every external payload
app/dashboard/            the designers' dashboard; components/dashboard/ charts
docs/hubspot-dashboard.md Nikhil's HubSpot setup and the reports to build
db/migrations/*.sql       schema, applied in order
knowledge/                Nikhil's files: source of truth for the rules
agent/                    Vani prompt, extraction schema, setup + role-play scripts
tests/                    rubric × 40 Sep enquiries, workflow end to end, guardrails
```

## Deploy

1. Push to a **private** GitHub repo (`knowledge/` holds Nikhil's internal pricing guide and
   client enquiries), then import it in Vercel.
2. Add the variables from `.env.example` in Vercel → Settings → Environment Variables.
3. Add `CRON_SECRET` and `SWEEP_URL` as GitHub Actions secrets.
4. Run `npm run db:migrate` against the production database.
5. Run `npm run hubspot:setup` once and copy the printed ids into Vercel.
   Then `npm run telegram:webhook` (and `npm run calendly:subscribe` on a paid Calendly plan).
6. Add each designer's Google email to `designers.email`.
7. `npm run vaani:setup -- --apply`, then finish the dashboard steps in [agent/README.md](agent/README.md).
