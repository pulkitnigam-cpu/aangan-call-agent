// Calendly: the designer books the site visit from a link that carries the
// lead's ID (utm_content). Calendly returns it in the webhook's `tracking`, so
// we match the booking to the exact lead — phone-only callers have no email to
// match on.

import { CalendlyWebhookSchema } from "./schemas";
import type { Designer, Lead } from "./types";

export function bookingLink(designer: Pick<Designer, "calendly_link">, lead: Pick<Lead, "id" | "name">): string | null {
  if (!designer.calendly_link) return null;
  let url: URL;
  try {
    url = new URL(designer.calendly_link);
  } catch {
    return null;
  }
  url.searchParams.set("utm_source", "aangan-agent");
  url.searchParams.set("utm_content", lead.id);
  if (lead.name) url.searchParams.set("name", lead.name);
  return url.toString();
}

export interface CalendlyBooking {
  event: "invitee.created" | "invitee.canceled";
  leadId: string | null;
  eventUri: string | null;
  startTime: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the parts of a Calendly v2 webhook we use. Returns null for other events. */
export function parseCalendlyWebhook(body: unknown): CalendlyBooking | null {
  const parsed = CalendlyWebhookSchema.safeParse(body);
  if (!parsed.success) return null;
  const b = parsed.data;
  if (b?.event !== "invitee.created" && b?.event !== "invitee.canceled") return null;
  const p = b.payload ?? {};
  const se = typeof p.scheduled_event === "object" ? p.scheduled_event : null;
  const leadId = p.tracking?.utm_content ?? null;
  const start = se?.start_time ? new Date(se.start_time) : null;
  return {
    event: b.event,
    leadId: leadId && UUID.test(leadId) ? leadId : null,
    eventUri: se?.uri ?? (typeof p.scheduled_event === "string" ? p.scheduled_event : null) ?? p.event ?? p.uri ?? null,
    startTime: start && !Number.isNaN(start.getTime()) ? start : null,
  };
}
