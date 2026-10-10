import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import "../ui.css";
import { BarList, ColumnChart } from "@/components/dashboard/Charts";
import { DesignerFilter } from "@/components/dashboard/DesignerFilter";
import { Icon } from "@/components/dashboard/Icons";
import { getDashboardData, parseRange, RANGES, type LeadRow } from "@/lib/dashboard";
import { getSql } from "@/lib/db";
import { fmtMinutes, fmtTime, initials, isUuid, STATUS_LABEL } from "@/lib/format";

export const metadata = { title: "Aangan · Leads" };

export default function DashboardPage(props: PageProps<"/dashboard">) {
  return (
    <main className="aangan shell">
      <div className="wrap">
        <Suspense fallback={<Skeleton />}>
          <Dashboard searchParams={props.searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

function Skeleton() {
  return (
    <>
      <div className="topbar"><div className="brand"><span className="brand-mark">A</span>Aangan</div></div>
      <div className="grid-4">{[0, 1, 2, 3].map((i) => <div key={i} className="card" style={{ height: 96 }} />)}</div>
      <div className="card" style={{ height: 240 }} />
    </>
  );
}

async function Dashboard({ searchParams }: { searchParams: PageProps<"/dashboard">["searchParams"] }) {
  await connection(); // "now" is request-time data
  const sp = await searchParams;
  const range = parseRange(typeof sp.range === "string" ? sp.range : undefined);
  // No sign-in (owner's decision): everyone sees the studio view and can pick a designer.
  const filter = isUuid(sp.designer) ? sp.designer : null;
  const designerId = filter;
  const d = await getDashboardData(getSql(), { designerId }, range);
  const now = new Date();
  const q = (r: number) => `/dashboard?range=${r}${filter ? `&designer=${filter}` : ""}`;

  return (
    <>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">A</span>Aangan</div>
        <span className="spacer" />
        <DesignerFilter designers={d.designers} current={filter} range={range} />
        <nav className="pills" aria-label="Date range">
          {RANGES.map((r) => (
            <Link key={r} href={q(r)} className="pill" aria-current={r === range ? "page" : undefined}>{r}d</Link>
          ))}
        </nav>
      </header>

      <section className="grid-4" aria-label="Key numbers">
        <Stat icon={<Icon.leads />} label="Leads" value={d.kpis.leads} sub={d.kpis.waitingNow ? `${d.kpis.waitingNow} to call now` : "All called"} tone={d.kpis.waitingNow ? undefined : "good"} />
        <Stat icon={<Icon.visit />} label="Visits booked" value={d.kpis.visits} sub={d.kpis.won ? `${d.kpis.won} won` : undefined} />
        <Stat icon={<Icon.clock />} label="Median callback" value={fmtMinutes(d.kpis.medianCallbackMin)} sub="Goal ≤ 2h" tone={d.kpis.medianCallbackMin !== null && d.kpis.medianCallbackMin > 120 ? "bad" : "good"} />
        <Stat icon={<Icon.check />} label="On time" value={d.kpis.onTimePct === null ? "—" : `${d.kpis.onTimePct}%`} sub="Called before the promised time" tone={d.kpis.onTimePct !== null && d.kpis.onTimePct < 90 ? "bad" : undefined} />
      </section>

      <section className="grid-2">
        <div className="card">
          <div className="card-title">Leads per day</div>
          <ColumnChart data={d.daily} />
        </div>
        <div className="card">
          <div className="card-title">Pipeline</div>
          <BarList data={d.funnel.map((s) => ({ label: s.stage, value: s.count }))} />
        </div>
      </section>

      <section className={d.cost ? "grid-2" : "grid-2-even"}>
        <div className="card">
          <div className="card-title">Callback speed</div>
          <BarList data={d.speed.map((s) => ({ label: s.bucket, value: s.count, late: s.late }))} lateLabel="after the promised time" />
        </div>
        {d.cost ? (
          <div className="card">
            <div className="card-title">What the system costs <span style={{ fontWeight: 400 }}>{range}d</span></div>
            <div className="grid-2-even">
              <div><div className="stat-label"><Icon.rupee /> Total</div><div className="stat-value">₹{d.cost.totalInr.toLocaleString("en-IN")}</div><div className="stat-sub">{d.cost.calls} AI calls</div></div>
              <div><div className="stat-label"><Icon.rupee /> Per qualified lead</div><div className="stat-value">{d.cost.perQualifiedInr === null ? "—" : `₹${d.cost.perQualifiedInr.toLocaleString("en-IN")}`}</div><div className="stat-sub">Vani minutes + Gemini</div></div>
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="card-title">Waiting for your call</div>
            <LeadList leads={d.leads.filter((l) => l.status === "assigned" && !l.first_action_at).slice(0, 4)} now={now} showDesigner={false} emptyText="Nobody waiting. 🎉" />
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-title">Leads <span style={{ fontWeight: 400 }}>{d.leads.length}</span></div>
        <LeadList leads={d.leads} now={now} showDesigner={!filter} emptyText="No leads in this period yet." />
      </section>
    </>
  );
}

function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="card">
      <div className="stat-label">{icon}{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className={`stat-sub${tone ? ` ${tone}` : ""}`}>{sub}</div>}
    </div>
  );
}

function LeadList({ leads, now, showDesigner, emptyText }: { leads: LeadRow[]; now: Date; showDesigner: boolean; emptyText: string }) {
  if (!leads.length) return <div className="empty">{emptyText}</div>;
  return (
    <div className="leads">
      {leads.map((l) => {
        const waiting = l.status === "assigned" && !l.first_action_at;
        const late = waiting && l.due_at !== null && l.due_at < now;
        return (
          <Link key={l.id} href={`/dashboard/leads/${l.id}`} className="lead">
            <span className="avatar" aria-hidden>{initials(l.name)}</span>
            <span style={{ minWidth: 0 }}>
              <span className="lead-name">{l.name ?? "Unnamed caller"}{l.priority && <span title="Priority" aria-label="Priority">⭐</span>}</span>
              <span className="lead-meta">{[l.bhk ? `${l.bhk}BHK` : null, l.area, showDesigner ? l.designer_name : null].filter(Boolean).join(" · ") || "—"}</span>
            </span>
            {waiting ? (
              <span className={`tag${late ? " late" : ""}`}><span className="dot" />{late ? `Late · ${fmtTime(l.due_at)}` : `Call by ${fmtTime(l.due_at)}`}</span>
            ) : (
              <span className={`tag${["visit_booked", "visit_done", "won"].includes(l.status) ? " done" : ""}`}><span className="dot" />{STATUS_LABEL[l.status] ?? l.status}</span>
            )}
            <span className="tag hide-sm">{l.needs_review ? "Review" : l.score === "qualified" ? "Qualified" : l.score === "unclear" ? "Unclear" : "Not a fit"}</span>
          </Link>
        );
      })}
    </div>
  );
}
