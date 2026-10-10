// Display helpers for the dashboard. Times are always India time.

const TIME = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const DAY_TIME = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

export const fmtTime = (d: Date | string | null | undefined) => (d ? TIME.format(new Date(d)) : "—");
export const fmtDayTime = (d: Date | string | null | undefined) => (d ? DAY_TIME.format(new Date(d)) : "—");
export const fmtDay = (d: Date | string | null | undefined) => (d ? DAY.format(new Date(d)) : "—");

export function fmtMinutes(min: number | null): string {
  if (min === null) return "—";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export const fmtDuration = (sec: number | null) => (sec === null ? "—" : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);

export const STATUS_LABEL: Record<string, string> = {
  new: "With front desk",
  assigned: "To call",
  called: "Called",
  visit_booked: "Visit booked",
  visit_done: "Visit done",
  won: "Won",
  lost: "Lost",
  not_fit: "Not a fit",
};

export const EVENT_LABEL: Record<string, string> = {
  created: "Enquiry received",
  merged: "Called again",
  assigned: "Assigned",
  accepted: "Accepted",
  passed: "Passed on",
  timeout: "Not accepted in time",
  reminded: "Reminder sent",
  escalated: "Escalated to Nikhil",
  called: "Called back",
  visit_booked: "Visit booked",
  visit_done: "Visit done",
  visit_cancelled: "Visit cancelled",
  not_fit: "Marked not a fit",
  won: "Won",
  lost: "Lost",
  to_front_desk: "Sent to front desk",
  closed: "Closed (not a fit)",
};

export const initials = (name: string | null) =>
  (name ?? "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";

export const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
