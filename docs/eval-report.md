# Evaluation: the 40 September 2026 enquiries

Generated 2026-10-10 by `npm run eval`. Real Gemini extraction, then Nikhil's rules.

- **Outcome accuracy (final, rules on Gemini's extraction): 39/40**
- Gemini's own score, before the rules re-check: 34/38 of the scored enquiries
- Qualified leads with a must-have missing: 9/24 (T02, T06, T11, T13, T14, W03, W05, W08, W09)
- Price-like phrases said by the studio side: 1 (T10: "lakh") — these are the human front desk in Sept; the AI agent is held to zero
- Gemini model: gemini-3.8-flash · 1,08,997 tokens · 370 s

| # | Channel | Expected | Rules (final) | Gemini's own | ✓ | Missing must-haves | Price said by studio | Why |
|---|---|---|---|---|---|---|---|---|
| F01 | Web Form | qualified | qualified | qualified | ✅ | — | — |  |
| F02 | Web Form | qualified | qualified | unclear | ✅ | — | — |  |
| F03 | Web Form | not_fit | not_fit | qualified | ✅ | — | — | Talegaon Dabhade is outside Pune / PCMC |
| F04 | Web Form | unclear | unclear | unclear | ✅ | — | — | scope not confirmed (design + execution?) |
| F05 | Web Form | qualified | qualified | qualified | ✅ | — | — |  |
| F06 | Web Form | qualified | qualified | qualified | ✅ | — | — |  |
| F07 | Web Form | unclear | unclear | unclear | ✅ | — | — | caller is still exploring — no project yet |
| F08 | Web Form | not_fit | not_fit | unclear | ✅ | — | — | needs completion in ~3 weeks; we need at least 8 |
| F09 | Web Form | qualified | qualified | qualified | ✅ | — | — |  |
| F10 | Web Form | qualified | qualified | qualified | ✅ | — | — | volunteered budget may be tight for this scope |
| T01 | Phone | qualified | qualified | qualified | ✅ | — | — |  |
| T02 | Phone | qualified | qualified | qualified | ✅ | name | — |  |
| T03 | Phone | not_fit | not_fit | not_fit | ✅ | — | — | Nashik is outside Pune / PCMC |
| T04 | Phone | not_fit | not_fit | not_fit | ✅ | — | — | wants advice only, not design with execution; location not given |
| T05 | Phone | qualified | qualified | qualified | ✅ | — | — |  |
| T06 | Phone | qualified | qualified | qualified | ✅ | name | — |  |
| T07 | Phone | not_fit | not_fit | not_fit | ✅ | — | — | location not given; needs completion in ~3 weeks; we need at least 8 |
| T08 | Phone | missed call | missed call | — | ✅ | — | — | no conversation; system follows up |
| T09 | Phone | existing client (escalate) | existing_client (escalate) | — | ✅ | — | — | Designer Aryan unresponsive for 5 days despite 3 messages and 2 calls; caller requested immediate callback from Nikhil or a senior person. |
| T10 | Phone | not_fit | not_fit | not_fit | ✅ | — | lakh | volunteered budget is clearly below any project of this scope |
| T11 | Phone | qualified | qualified | qualified | ✅ | name, timeline | — |  |
| T12 | Phone | qualified | qualified | qualified | ✅ | — | — |  |
| T13 | Phone | qualified | qualified | unclear | ✅ | name, timeline | — |  |
| T14 | Phone | qualified | qualified | qualified | ✅ | name, timeline | — | caller is researching for the owners — confirm owners attend the consultation |
| T15 | Phone | qualified | qualified | qualified | ✅ | — | — |  |
| T16 | Phone | unclear | unclear | unclear | ✅ | — | — | scope not confirmed (design + execution?) |
| T17 | Phone | qualified | qualified | qualified | ✅ | — | — |  |
| T18 | Phone | not_fit | not_fit | not_fit | ✅ | — | — | commercial space of 180 sq ft is below our ~500 sq ft minimum; location not given |
| T19 | Phone | not_fit | not_fit | not_fit | ✅ | — | — | restaurant interiors are outside our scope |
| T20 | Phone | qualified | qualified | qualified | ✅ | — | — |  |
| W01 | WhatsApp | qualified | qualified | qualified | ✅ | — | — |  |
| W02 | WhatsApp | unclear | unclear | unclear | ✅ | — | — | scope not confirmed (design + execution?); location not given |
| W03 | WhatsApp | qualified | qualified | qualified | ✅ | timeline | — |  |
| W04 | WhatsApp | qualified | qualified | qualified | ✅ | — | — |  |
| W05 | WhatsApp | unclear | qualified | unclear | ❌ | timeline | — |  |
| W06 | WhatsApp | qualified | qualified | qualified | ✅ | — | — |  |
| W07 | WhatsApp | not_fit | not_fit | not_fit | ✅ | — | — | gym interiors are outside our scope |
| W08 | WhatsApp | qualified | qualified | qualified | ✅ | timeline | — |  |
| W09 | WhatsApp | qualified | qualified | qualified | ✅ | timeline | — |  |
| W10 | WhatsApp | unclear | unclear | unclear | ✅ | — | — | caller is still exploring — no project yet |
