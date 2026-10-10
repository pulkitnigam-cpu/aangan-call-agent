"use client";

import { useState } from "react";

// Two chart forms, hand-built in SVG/HTML (no chart library):
//  - ColumnChart: one measure over time (leads per day), hover crosshair + tooltip.
//  - BarList: one measure across a few categories (pipeline, callback speed),
//    direct-labelled values, hover tooltip with share.
// Single series each, so one color; "Late" is the only status color and always
// carries its text label. Each chart has a screen-reader table.

interface Point {
  label: string;
  value: number;
}

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

export function ColumnChart({ data, unit = "leads", height = 180 }: { data: { day: string; leads: number }[]; unit?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const padL = 28;
  const padB = 22;
  const plotW = W - padL;
  const plotH = H - padB - 8;
  const max = Math.max(1, ...data.map((d) => d.leads));
  const niceMax = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const step = plotW / Math.max(1, data.length);
  const gap = data.length > 45 ? 1 : 2;
  const barW = Math.max(1, step - gap);
  const y = (v: number) => 8 + plotH - (v / niceMax) * plotH;
  const ticks = niceMax <= 4 ? Array.from({ length: niceMax + 1 }, (_, i) => i) : [0, niceMax / 2, niceMax];
  const labelEvery = Math.ceil(data.length / 6);

  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${unit} per day`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={t === 0 ? 1.5 : 1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="tick">{t}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = padL + i * step + gap / 2;
          const h = Math.max(0, y(0) - y(d.leads));
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={d.day}>
              {h > 0 && (
                <path
                  d={`M${x},${y(0)} V${y(d.leads) + r} Q${x},${y(d.leads)} ${x + r},${y(d.leads)} H${x + barW - r} Q${x + barW},${y(d.leads)} ${x + barW},${y(d.leads) + r} V${y(0)} Z`}
                  fill="var(--series-1)"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              {/* hit target: the full column, wider than the mark */}
              <rect x={padL + i * step} y={8} width={step} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" className="tick">{fmtDay(d.day)}</text>
              )}
            </g>
          );
        })}
        {hover !== null && (
          <line x1={padL + hover * step + step / 2} x2={padL + hover * step + step / 2} y1={8} y2={y(0)} stroke="var(--axis)" strokeDasharray="3 3" />
        )}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${((padL + hover * step + step / 2) / W) * 100}%`, top: `${(y(data[hover].leads) / H) * 100}%` }}>
          <b>{data[hover].leads}</b> {unit} · {fmtDay(data[hover].day)}
        </div>
      )}
      <table className="sr-only">
        <tbody>{data.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.leads}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export function BarList({ data, lateLabel }: { data: (Point & { late?: boolean })[]; lateLabel?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <div className="barlist chart" onMouseLeave={() => setHover(null)}>
      {data.map((d, i) => (
        <div key={d.label} className="barrow" onMouseEnter={() => setHover(i)} style={{ position: "relative" }}>
          <span className="lbl">{d.late ? <span style={{ color: "var(--critical)" }} aria-hidden>●</span> : null}{d.label}</span>
          <div className="track">
            <div className={`fill${d.late ? " late" : ""}`} style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
          <span className="val" style={d.late && d.value > 0 ? { color: "var(--critical)" } : undefined}>{d.value}</span>
          {hover === i && total > 0 && (
            <div className="tooltip" style={{ left: "60%", top: 0 }}>
              <b>{d.value}</b> · {Math.round((d.value / total) * 100)}%{d.late && lateLabel ? ` · ${lateLabel}` : ""}
            </div>
          )}
        </div>
      ))}
      <table className="sr-only">
        <tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td>{d.value}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
