@AGENTS.md

# Aangan Call Agent — project rules

## STRICT: the calling agent never goes outside the data

The customer-facing calling agent must follow **only** the guardrails and data in `knowledge/`
(`services.md`, `qualified.md`, the Sep 2026 enquiries) and the hard rules below. It must never
answer from general knowledge or improvise facts. If a caller asks something the data doesn't
cover, the agent says the designer or team will answer it, and records the question.

Hard rules:
1. Never say a price, range, per-sq-ft figure or estimate. `knowledge/pricing.md` is never given
   to the agent or put in any prompt.
2. Never promise project dates or timelines. Callback times come only from the backend.
3. Say it's an AI and ask for recording consent at the start of every call.
4. Hand over to a human whenever the caller asks or is upset.
5. The agent screens and scores only. The designer confirms fit, quotes and closes.

Every change to the prompt, tools or routing must keep the tests that enforce these passing
(`npm test`: no price leaks, no figures in the prompt, rubric vs the 40 enquiries).
If a requirement conflicts with `knowledge/`, the knowledge files win; raise the conflict.
