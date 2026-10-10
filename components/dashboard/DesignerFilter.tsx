"use client";

import { useRouter } from "next/navigation";

/** Admin-only: view one designer's dashboard, or everyone's. */
export function DesignerFilter({ designers, current, range }: { designers: { id: string; name: string }[]; current: string | null; range: number }) {
  const router = useRouter();
  return (
    <select
      className="ghost-btn"
      aria-label="Designer"
      value={current ?? ""}
      onChange={(e) => router.push(`/dashboard?range=${range}${e.target.value ? `&designer=${e.target.value}` : ""}`)}
    >
      <option value="">All designers</option>
      {designers.map((d) => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  );
}
