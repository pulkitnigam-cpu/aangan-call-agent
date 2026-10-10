// Studio hours and callback deadlines, always in India time (IST, UTC+5:30,
// no daylight saving). Vercel runs in UTC, so never use local Date methods.
//
// Callbacks run 10am–7pm EVERY day, weekends and public holidays included
// (Nikhil's decision, 7 Oct 2026). Weekend delay is how W05 was lost.
// Outside those hours the AI still answers; the human callback is the next
// morning, never "Monday".

const IST_OFFSET_MS = 330 * 60 * 1000;
const OPEN_MIN = 10 * 60;
const CLOSE_MIN = 19 * 60;
const BUSINESS_DAYS = new Set([0, 1, 2, 3, 4, 5, 6]); // every day
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ist(d: Date) {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth(),
    day: t.getUTCDate(),
    dow: t.getUTCDay(),
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

function fromIst(y: number, m: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(y, m, day, hour, minute) - IST_OFFSET_MS);
}

/** Hour and minute of a Date in IST, as minutes since midnight. */
export function istMinutes(d: Date): number {
  return ist(d).minutes;
}

export function isBusinessHours(d: Date): boolean {
  const p = ist(d);
  return BUSINESS_DAYS.has(p.dow) && p.minutes >= OPEN_MIN && p.minutes < CLOSE_MIN;
}

/** The next business day at hh:mm IST that is after `d` (may be later today). */
export function nextBusinessAt(d: Date, hour: number, minute = 0): Date {
  const p = ist(d);
  for (let i = 0; i <= 7; i++) {
    const candidate = fromIst(p.y, p.m, p.day + i, hour, minute);
    if (candidate > d && BUSINESS_DAYS.has(ist(candidate).dow)) return candidate;
  }
  throw new Error("unreachable: no business day within a week");
}

/**
 * When someone must call the lead back. In hours: 2 hours. Out of hours: noon
 * on the next business day (open + 2 hours), so nobody is pinged at 1am.
 */
export function callbackDue(callAt: Date): Date {
  return isBusinessHours(callAt) ? new Date(callAt.getTime() + 2 * 60 * 60 * 1000) : nextBusinessAt(callAt, 12);
}

/**
 * When the front desk must call back (unclear leads, existing clients). Same
 * as callbackDue, except the 2 hours must fit before the desk closes at 7pm —
 * a 6:55pm call can't be promised "within 2 hours" by people who leave at 7.
 */
export function frontDeskDue(callAt: Date): Date {
  if (isBusinessHours(callAt)) {
    const due = new Date(callAt.getTime() + 2 * 60 * 60 * 1000);
    if (ist(due).minutes <= CLOSE_MIN && ist(due).day === ist(callAt).day) return due;
  }
  return nextBusinessAt(callAt, 12);
}

/** Existing-client complaints: 15 minutes in hours, 10:30am next business day otherwise. */
export function escalationDue(callAt: Date): Date {
  return isBusinessHours(callAt) ? new Date(callAt.getTime() + 15 * 60 * 1000) : nextBusinessAt(callAt, 10, 30);
}

/** How the agent says the deadline out loud, e.g. "by 12 noon tomorrow". */
export function describeDue(callAt: Date, due: Date): string {
  // Phrase from the actual gap, not from "is the studio open".
  const mins = Math.round((due.getTime() - callAt.getTime()) / 60000);
  if (mins <= 15) return "within 15 minutes";
  if (mins <= 120) return "within 2 hours";

  const c = ist(callAt);
  const d = ist(due);
  const hh = Math.floor(d.minutes / 60);
  const mm = d.minutes % 60;
  const time = hh === 12 && mm === 0 ? "12 noon" : `${hh > 12 ? hh - 12 : hh}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${hh >= 12 ? "pm" : "am"}`;

  const dayDiff = Math.round((Date.UTC(d.y, d.m, d.day) - Date.UTC(c.y, c.m, c.day)) / 86_400_000);
  if (dayDiff === 0) return `by ${time} today`;
  if (dayDiff === 1) return `by ${time} tomorrow`;
  return `by ${time} on ${WEEKDAYS[d.dow]}`;
}
