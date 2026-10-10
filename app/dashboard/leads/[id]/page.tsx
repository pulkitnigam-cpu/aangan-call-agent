import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import "../../../ui.css";
import { Icon } from "@/components/dashboard/Icons";
import { bookingLink } from "@/lib/calendly";
import { getLeadDetail } from "@/lib/dashboard";
import { getSql } from "@/lib/db";
import { EVENT_LABEL, fmtDayTime, fmtDuration, initials, STATUS_LABEL } from "@/lib/format";
import { fmtPhone } from "@/lib/telegram";

export const metadata = { title: "Aangan · Lead" };

export default function LeadPage(props: PageProps<"/dashboard/leads/[id]">) {
  return (
    <main className="aangan shell">
      <div className="wrap">
        <Link href="/dashboard" className="back">← All leads</Link>
        <Suspense fallback={<div className="card" style={{ height: 320 }} />}>
          <Lead params={props.params} />
        </Suspense>
      </div>
    </main>
  );
}

const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

async function Lead({ params }: { params: PageProps<"/dashboard/leads/[id]">["params"] }) {
  await connection();
  const { id } = await params;
  const detail = await getLeadDetail(getSql(), id, { designerId: null });
  if (!detail) notFound();
  const { lead: l, events, calls } = detail;

  const facts: [React.ReactNode, string, string | null][] = [
    [<Icon.pin key="a" />, "Area", str(l.area)],
    [<Icon.home key="b" />, "Space", [str(l.bhk) ? `${l.bhk}BHK` : null, str(l.property_type) ?? str(l.project_kind)].filter(Boolean).join(" · ") || null],
    [<Icon.ruler key="c" />, "Size", str(l.size_sqft) ? `${l.size_sqft} sq ft` : null],
    [<Icon.tag key="d" />, "Scope", str(l.scope)],
    [<Icon.clock key="e" />, "Timeline", str(l.timeline)],
    [<Icon.home key="f" />, "Current state", str(l.current_state)],
    [<Icon.rupee key="g" />, "Budget (their words)", str(l.budget)],
    [<Icon.user key="h" />, "Decision", l.decision_maker && l.decision_maker !== "unknown" ? String(l.decision_maker).replace("_", " ") : null],
    [<Icon.leads key="i" />, "Source", str(l.source)],
    [<Icon.visit key="j" />, "Visit times", str(l.consultation_preference)],
  ];
  const book = l.calendly_link ? bookingLink({ calendly_link: l.calendly_link }, { id: l.id, name: str(l.name) }) : null;
  const notes = [...((l.handoff_notes as string[]) ?? []), ...(l.needs_review && l.review_reason ? [String(l.review_reason)] : [])];
  const questions = (l.open_questions as string[]) ?? [];

  return (
    <>
      <section className="card">
        <div className="hero">
          <span className="avatar" aria-hidden>{initials(str(l.name))}</span>
          <div style={{ flex: 1, minWidth: 200 }}>
            <h1>{str(l.name) ?? "Unnamed caller"} {l.priority ? <span title="Priority">⭐</span> : null}</h1>
            <a className="phone" href={`tel:${l.phone}`}><Icon.phone /> {fmtPhone(String(l.phone))}</a>
          </div>
          <span className="tag"><span className="dot" />{STATUS_LABEL[String(l.status)] ?? String(l.status)}</span>
          {l.due_at && !l.first_action_at ? <span className="tag">Call by {fmtDayTime(l.due_at as Date)}</span> : null}
          {book && <a className="btn" href={book} target="_blank" rel="noreferrer"><Icon.visit /> Book visit</a>}
        </div>
        {str(l.summary) && <p className="note" style={{ marginTop: 14 }}>{String(l.summary)}</p>}
      </section>

      <section className="card">
        <div className="facts">
          {facts.filter(([, , v]) => v).map(([icon, k, v]) => (
            <div key={k} className="fact"><div className="fact-k">{icon}{k}</div><div className="fact-v">{v}</div></div>
          ))}
        </div>
        {(questions.length > 0 || notes.length > 0) && (
          <div style={{ marginTop: 14, display: "grid", gap: 6 }}>
            {questions.length > 0 && <p className="note"><b>They asked:</b> {questions.join(" · ")}</p>}
            {notes.length > 0 && <p className="note warn"><b>Note:</b> {notes.join(" · ")}</p>}
          </div>
        )}
      </section>

      <section className="grid-2-even">
        <div className="card">
          <div className="card-title">Timeline</div>
          <div className="timeline">
            {events.map((e, i) => (
              <div key={i} className="tl">
                <span className="pt" />
                <span>{EVENT_LABEL[e.type] ?? e.type}</span>
                <span className="when">{fmtDayTime(e.at)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-title">Calls <span style={{ fontWeight: 400 }}>{calls.length}</span></div>
          <div style={{ display: "grid", gap: 12 }}>
            {calls.map((c) => (
              <div key={c.id}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="tag">{fmtDayTime(c.started_at)}</span>
                  <span className="tag">{fmtDuration(c.duration_sec)}</span>
                  <span className="tag">{c.handled_by === "ai" ? "AI" : "Front desk"}</span>
                  {c.language && <span className="tag">{c.language.toUpperCase()}</span>}
                </div>
                {c.transcript ? (
                  <details className="transcript">
                    <summary>Transcript</summary>
                    <pre>{c.transcript}</pre>
                  </details>
                ) : (
                  <p className="note" style={{ marginTop: 8 }}>{c.recording_consent === false ? "Caller declined recording; only the details were kept." : "No transcript."}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
