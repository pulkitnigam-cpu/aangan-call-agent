import type postgres from "postgres";

// Data for the designers' dashboard. Every query takes a scope: one designer's
// leads (the designer picker), or null for the whole studio. There is no
// sign-in (owner's decision, 10 Oct). Nikhil's business view lives in HubSpot.

export interface Scope {
  designerId: string | null; // null = the whole studio
}

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];
export const parseRange = (v: string | undefined): RangeDays => (RANGES.includes(Number(v) as RangeDays) ? (Number(v) as RangeDays) : 30);


export interface DashboardData {
  kpis: {
    leads: number;
    visits: number;
    won: number;
    medianCallbackMin: number | null;
    onTimePct: number | null;
    waitingNow: number;
  };
  daily: { day: string; leads: number }[];
  funnel: { stage: string; count: number }[];
  speed: { bucket: string; count: number; late: boolean }[];
  leads: LeadRow[];
  cost: { totalInr: number; calls: number; perQualifiedInr: number | null } | null; // admin only
  designers: { id: string; name: string }[]; // admin filter
}

export interface LeadRow {
  id: string;
  name: string | null;
  area: string | null;
  bhk: number | null;
  status: string;
  score: string;
  priority: boolean;
  needs_review: boolean;
  due_at: Date | null;
  first_action_at: Date | null;
  created_at: Date;
  designer_name: string | null;
}

export async function getDashboardData(sql: postgres.Sql, scope: Scope, days: RangeDays, now = new Date()): Promise<DashboardData> {
  const since = new Date(now.getTime() - days * 86_400_000);
  // The callback clock starts when the lead is assigned, or — for night leads —
  // two hours before the noon deadline (10am), so overnight hours don't count as "slow".
  const clockStart = sql`greatest(l.assigned_at, l.due_at - interval '2 hours')`;
  const mine = scope.designerId
    ? sql`and l.designer_id = ${scope.designerId}`
    : sql`and l.designer_id is not null`;

  const [k] = await sql<{ leads: number; visits: number; won: number; median: number | null; on_time: number | null; waiting: number }[]>`
    select
      count(*)::int as leads,
      count(*) filter (where l.status in ('visit_booked', 'visit_done', 'won'))::int as visits,
      count(*) filter (where l.status = 'won')::int as won,
      percentile_cont(0.5) within group (
        order by extract(epoch from (l.first_action_at - ${clockStart})) / 60
      ) filter (where l.first_action_at is not null) as median,
      round(100.0 * count(*) filter (where l.first_action_at is not null and l.first_action_at <= l.due_at)
        / nullif(count(*) filter (where l.first_action_at is not null or l.due_at < ${now}), 0)) as on_time,
      count(*) filter (where l.status = 'assigned' and l.first_action_at is null)::int as waiting
    from leads l
    where l.created_at >= ${since} ${mine}
  `;

  const daily = await sql<{ day: string; leads: number }[]>`
    with days as (
      select generate_series(
        date_trunc('day', ${since}::timestamptz at time zone 'Asia/Kolkata'),
        date_trunc('day', ${now}::timestamptz at time zone 'Asia/Kolkata'),
        interval '1 day'
      ) as day
    )
    select to_char(d.day, 'YYYY-MM-DD') as day, count(l.id)::int as leads
    from days d
    left join leads l on date_trunc('day', l.created_at at time zone 'Asia/Kolkata') = d.day ${mine}
    group by d.day order by d.day
  `;

  const [f] = await sql<{ given: number; called: number; visit: number; won: number }[]>`
    select count(*)::int as given,
      count(*) filter (where l.first_action_at is not null)::int as called,
      count(*) filter (where l.status in ('visit_booked', 'visit_done', 'won'))::int as visit,
      count(*) filter (where l.status = 'won')::int as won
    from leads l where l.created_at >= ${since} ${mine}
  `;

  const [s] = await sql<{ b30: number; b60: number; b120: number; late: number }[]>`
    with t as (
      select extract(epoch from (coalesce(l.first_action_at, ${now}) - ${clockStart})) / 60 as mins,
             l.first_action_at, l.due_at
      from leads l
      where l.created_at >= ${since} ${mine} and l.assigned_at is not null and l.due_at is not null
        and (l.first_action_at is not null or l.due_at < ${now})
    )
    select count(*) filter (where first_action_at is not null and mins < 30)::int as b30,
           count(*) filter (where first_action_at is not null and mins >= 30 and mins < 60)::int as b60,
           count(*) filter (where first_action_at is not null and mins >= 60 and first_action_at <= due_at)::int as b120,
           count(*) filter (where first_action_at is null or first_action_at > due_at)::int as late
    from t
  `;

  const leads = await sql<LeadRow[]>`
    select l.id, l.name, l.area, l.bhk, l.status, l.score, l.priority, l.needs_review,
           l.due_at, l.first_action_at, l.created_at, d.name as designer_name
    from leads l left join designers d on d.id = l.designer_id
    where l.created_at >= ${since} ${mine}
    order by (l.status = 'assigned' and l.first_action_at is null) desc, l.created_at desc
    limit 60
  `;

  let cost: DashboardData["cost"] = null;
  // The designer picker needs the full list in every view.
  const designers = await sql<{ id: string; name: string }[]>`select id, name from designers where active order by name`;
  if (!scope.designerId) {
    const [c] = await sql<{ total: string; calls: number; qualified: number; bot: string }[]>`
      select coalesce((select sum(cost_inr) from calls where started_at >= ${since}), 0)::text as total,
             (select count(*)::int from calls where started_at >= ${since} and handled_by = 'ai') as calls,
             (select count(*)::int from leads where created_at >= ${since} and score = 'qualified') as qualified,
             coalesce((select sum(cost_inr) from ai_usage where at >= ${since}), 0)::text as bot
    `;
    const total = Number(c.total) + Number(c.bot);
    cost = { totalInr: Math.round(total * 100) / 100, calls: c.calls, perQualifiedInr: c.qualified ? Math.round((total / c.qualified) * 100) / 100 : null };
  }

  return {
    kpis: {
      leads: k.leads,
      visits: k.visits,
      won: k.won,
      medianCallbackMin: k.median === null ? null : Math.round(Number(k.median)),
      onTimePct: k.on_time === null ? null : Number(k.on_time),
      waitingNow: k.waiting,
    },
    daily,
    funnel: [
      { stage: "Given", count: f.given },
      { stage: "Called", count: f.called },
      { stage: "Visit booked", count: f.visit },
      { stage: "Won", count: f.won },
    ],
    speed: [
      { bucket: "< 30 min", count: s.b30, late: false },
      { bucket: "30–60 min", count: s.b60, late: false },
      { bucket: "1–2 h", count: s.b120, late: false },
      { bucket: "Late", count: s.late, late: true },
    ],
    leads,
    cost,
    designers,
  };
}

export interface LeadDetail {
  lead: Record<string, unknown> & { id: string; designer_id: string | null; designer_name: string | null; calendly_link: string | null };
  events: { type: string; actor: string | null; at: Date; data: unknown }[];
  calls: { id: string; started_at: Date; duration_sec: number | null; language: string | null; recording_consent: boolean | null; transcript: string | null; handled_by: string; cost_inr: string }[];
}

/** One lead with its history — or null if it doesn't exist or isn't this designer's. */
export async function getLeadDetail(sql: postgres.Sql, id: string, scope: Scope): Promise<LeadDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [lead] = await sql<LeadDetail["lead"][]>`
    select l.*, d.name as designer_name, d.calendly_link
    from leads l left join designers d on d.id = l.designer_id
    where l.id = ${id}
  `;
  if (!lead) return null;
  if (scope.designerId && lead.designer_id !== scope.designerId) return null;
  const events = await sql<LeadDetail["events"]>`select type, actor, at, data from lead_events where lead_id = ${id} order by at`;
  const calls = await sql<LeadDetail["calls"]>`
    select id, started_at, duration_sec, language, recording_consent, transcript, handled_by, cost_inr::text
    from calls where lead_id = ${id} or id = ${lead.call_id as string} order by started_at
  `;
  return { lead, events, calls };
}
