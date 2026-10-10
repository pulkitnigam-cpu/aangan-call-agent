import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { budgetFloorInr, checkServiceArea, findPriceMentions, scoreLead, type LeadFacts } from "../lib/policy";
import { ENQUIRIES } from "./fixtures/sep-2026-enquiries";

describe("Nikhil's rubric on the 40 September enquiries", () => {
  it("covers all 40", () => assert.equal(ENQUIRIES.length, 40));

  for (const c of ENQUIRIES) {
    if (!c.facts) continue;
    it(`${c.id} (${c.note}) → ${c.expected}`, () => {
      const r = scoreLead(c.facts!, new Date(c.at));
      assert.equal(r.score, c.expected, `reasons: ${r.reasons.join("; ")}`);
    });
  }

  it("notes uncertainty instead of blocking (T14: researching for parents)", () => {
    const t14 = ENQUIRIES.find((c) => c.id === "T14")!;
    const r = scoreLead(t14.facts!, new Date(t14.at));
    assert.equal(r.score, "qualified");
    assert.match(r.notes.join(" "), /owners attend/);
  });

  it("flags a tight-but-not-low budget for the designer (F10)", () => {
    const f10 = ENQUIRIES.find((c) => c.id === "F10")!;
    assert.match(scoreLead(f10.facts!, new Date(f10.at)).notes.join(" "), /budget may be tight/);
  });
});

describe("service area", () => {
  it("passes named and adjoining localities", () => {
    for (const a of ["Kothrud", "Pimple Saudagar", "Hinjewadi Phase 1, Pune", "Kharadi", "NIBM Road", "Pune"]) {
      assert.equal(checkServiceArea(a), "pass", a);
    }
  });
  it("fails out-of-area even when 'Pune' is mentioned", () => {
    assert.equal(checkServiceArea("Talegaon Dabhade, near Pune"), "fail");
    assert.equal(checkServiceArea("Lonavala"), "fail");
  });
  it("is unknown for places it doesn't recognise, or no place", () => {
    assert.equal(checkServiceArea("Uruli Kanchan"), "unknown");
    assert.equal(checkServiceArea(null), "unknown");
  });
  it("regression: non-Latin script or garbage is unknown, not a free pass", () => {
    assert.equal(checkServiceArea("कोथरूड"), "unknown");
    assert.equal(checkServiceArea("???"), "unknown");
    assert.equal(checkServiceArea("   "), "unknown");
  });
  it("regression: in-area and out-of-area together means ask, not decline", () => {
    assert.equal(checkServiceArea("Baner, moving from Mumbai"), "unknown");
  });
});

describe("scoring edge cases", () => {
  const base: LeadFacts = {
    intent: "design_and_execution", project_kind: "home", scope_kind: "full_home", room_count: null, bhk: null,
    area: "Baner", size_sqft: 1000, budget_max_inr: null, deadline_date: null, site_available_in_weeks: null,
    decision_maker: "self",
  };
  const oct7 = new Date("2026-10-07T12:00:00+05:30");

  it("a clean lead qualifies", () => assert.equal(scoreLead(base, oct7).score, "qualified"));

  it("regression: a deadline resolved into the past is unclear, never a decline", () => {
    const r = scoreLead({ ...base, deadline_date: "2026-03-31" }, oct7);
    assert.equal(r.score, "unclear");
    assert.match(r.reasons.join(), /in the past/);
  });

  it("deadline boundaries: <8 weeks fails, 8–10 asks, >10 passes", () => {
    assert.equal(scoreLead({ ...base, deadline_date: "2026-11-25" }, oct7).score, "not_fit"); // ~7 weeks
    assert.equal(scoreLead({ ...base, deadline_date: "2026-12-07" }, oct7).score, "unclear"); // ~9 weeks
    assert.equal(scoreLead({ ...base, deadline_date: "2026-12-31" }, oct7).score, "qualified"); // ~12 weeks
  });

  it("regression: space types services.md doesn't cover go to a human", () => {
    assert.equal(scoreLead({ ...base, project_kind: "other" }, oct7).score, "unclear");
  });

  it("commercial size limits", () => {
    const office = { ...base, project_kind: "office" as const, scope_kind: "commercial_fitout" as const };
    assert.equal(scoreLead({ ...office, size_sqft: 499 }, oct7).score, "not_fit");
    assert.equal(scoreLead({ ...office, size_sqft: 1500 }, oct7).score, "qualified");
    assert.equal(scoreLead({ ...office, size_sqft: 4000 }, oct7).score, "unclear");
  });

  it("budget floor uses BHK when size is unknown", () => {
    // 2BHK full home ≈ 4 rooms. ₹3 lakh is far below; ₹12 lakh is not.
    const twoBhk = { ...base, size_sqft: null, bhk: 2 };
    assert.equal(budgetFloorInr(twoBhk), 1_400_000);
    assert.equal(scoreLead({ ...twoBhk, budget_max_inr: 300_000 }, oct7).score, "not_fit");
    assert.equal(scoreLead({ ...twoBhk, budget_max_inr: 1_200_000 }, oct7).score, "qualified");
  });

  it("no budget, no floor, or unknown decision-maker never blocks", () => {
    assert.equal(scoreLead({ ...base, size_sqft: null, budget_max_inr: 100_000 }, oct7).score, "qualified");
    const r = scoreLead({ ...base, decision_maker: "unknown" }, oct7);
    assert.equal(r.score, "qualified");
    assert.match(r.notes.join(), /decision-maker not confirmed/);
  });

  it("an explicit 'not authorised' caller is not forwarded", () => {
    assert.equal(scoreLead({ ...base, decision_maker: "not_authorised" }, oct7).score, "not_fit");
  });
});

describe("price guardrail", () => {
  it("allows the approved deflections (pricing.md, T02, T13, W02)", () => {
    const ok = [
      "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can set that up for you right now if you'd like.",
      "I genuinely can't — it varies quite a bit based on materials. Giving you a number without seeing the site would be misleading. The consultation is free and there's no obligation.",
      "The difference between a standard and a premium kitchen alone can be 3× the cost.",
      "Our pricing depends on materials and scope — our designers go through all of this at a free consultation.",
    ];
    for (const line of ok) assert.deepEqual(findPriceMentions(line), [], line);
  });

  it("doesn't flag normal speech (false alarms would page Nikhil)", () => {
    const ok = [
      "I'm hundred percent sure our designer can help.",
      "So that's a 3BHK of about 1,400 sq ft in Kothrud, done by March — right?",
      "Design takes 3 to 4 weeks, and execution 8 to 16 weeks.",
      "One of our designers will call you by 12 noon tomorrow.",
      "Is that within Pune city or PCMC?",
    ];
    for (const line of ok) assert.deepEqual(findPriceMentions(line), [], line);
  });

  it("catches every phrase pricing.md forbids", () => {
    const bad = [
      "It'll cost around 20 lakh.",
      "Our rates start at ₹1,800.",
      "For a 2BHK it's typically 12 to 15 lakhs.",
      "Roughly 2,000 per sq ft.",
      "Usually comes to about 18k per square foot.",
      "Lagbhag 10 लाख लगेगा.",
      "Rs. 3500 psf for luxury.",
      // regressions: these slipped through before
      "Around two thousand a square foot.",
      "Roughly 2,000 a sq ft.",
      "Lagbhag pandrah hazaar.",
      "Somewhere between 18 and 24 hundred.",
    ];
    for (const line of bad) assert.ok(findPriceMentions(line).length > 0, line);
  });

  it("is strict: repeating the caller's figure back counts (T10 front desk line)", () => {
    assert.ok(findPriceMentions("1 to 1.5 lakh would be significantly below what a project of that scope would cost").length > 0);
  });
});
