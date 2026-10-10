# Knowledge — the agent's guardrails

These files from Nikhil are the source of truth for how the agent talks and decides.
If a rule changes, change it here first, then update `agent/system-prompt.md` and
`lib/policy.ts` to match. `npm test` checks the policy against all 40 September enquiries.

| File | What it is | Voice agent KB? | Used in code |
| ---- | ---------- | --------------- | ------------ |
| `services.md` | What the studio does and doesn't do, service area, timelines | **Yes** | `lib/policy.ts`: service area, scope exclusions, lead time |
| `qualified.md` | Nikhil's five criteria for forwarding a lead | **Yes** | `lib/policy.ts`: `scoreLead()` |
| `pricing.md` | Internal pricing guide, "indicative only" | **No — never upload** | `lib/policy.ts`: internal budget floor only, never spoken |
| `Aangan_Sep 2026_Enquiries.pdf` | 40 real enquiries (20 phone, 10 WhatsApp, 10 web form) | No | `tests/fixtures/sep-2026-enquiries.ts`: labelled test set |

## What the 40 enquiries tell us

Scored with Nikhil's rubric (`npm test`):

| Outcome | Count | Enquiries |
| ------- | ----- | --------- |
| Qualified | 23 | T01 T02 T05 T06 T11 T12 T13 T14 T15 T17 T20 · W01 W03 W04 W06 W08 W09 · F01 F02 F05 F06 F09 F10 |
| Not a fit | 9 | T03 Nashik · T04 advice only · T07 3-week deadline · T10 budget · T18 180 sq ft pod · T19 restaurant · W07 gym · F03 Talegaon · F08 3-week deadline |
| Unclear | 6 | T16 W02 W05 W10 F04 F07: scope, area or intent not confirmed |
| Other | 2 | T08 missed call at 10:47pm (never reached) · T09 existing-client complaint (escalate) |

Patterns the prompt is built around:
- **Price questions are common, and never a reason to drop a lead** (T02, T13, W02, F04, F07).
- **Slow replies lose leads**: T08 (missed at night), T16 (no callback for 2 days), W05 (weekend), W08 (4 days).
  Two of these callers said so on the call.
- **Referrals are everywhere** (T01, T05, W01, W06, F02, F05, F09), so the agent records referrer names exactly.
- **Hindi/Hinglish callers** (W03), so the agent matches the caller's language.

## Decisions confirmed by Nikhil (7 Oct 2026)

- **Calls up to 4 minutes** (changed from 10 on 10 Oct). The agent collects the 5 must-haves first and wraps up at ~3 min.
- **The consultation is free.** The agent may say so.
- **Callbacks every day, 10am–7pm, including weekends and public holidays.** The AI answers 24/7.
  A call outside those hours is promised a call by noon the next morning, never "on Monday" (W05 was lost to weekend delay).

## Rules taken from practice, not from the .md files (still to confirm)

- **Commercial minimum of ~500 sq ft.** From T18; `services.md` only gives the ~3,000 sq ft cap.
- **"Adjoining areas".** `services.md` doesn't name them. `ADJOINING_AREAS` in `lib/policy.ts` is a best guess (e.g. Kharadi, Bavdhan, Nanded City).
- **"Clearly below" budget** = under half the lowest indicative cost for that scope. T10 is at 21%. F10 is at 94%: forwarded, with a "budget may be tight" note for the designer.
  The floors come from `pricing.md`; `tests/pricing-drift.test.ts` fails if the two ever differ.
