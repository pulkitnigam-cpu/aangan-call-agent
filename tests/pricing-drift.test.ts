import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { PRICE_FLOORS } from "../lib/policy";

// The budget check uses the lowest indicative figures from pricing.md. If
// Nikhil updates pricing.md, this fails until lib/policy.ts is updated too.

const md = readFileSync("knowledge/pricing.md", "utf8");
const rupees = (s: string) => Number(s.replace(/[₹,\s]/g, ""));

describe("pricing.md and the code agree", () => {
  it("residential standard low end", () => {
    const m = md.match(/Standard specification\s*\|\s*(₹[\d,]+)/);
    assert.ok(m, "row 'Standard specification' not found in pricing.md");
    assert.equal(rupees(m[1]), PRICE_FLOORS.residentialPerSqft);
  });

  it("commercial basic fitout low end", () => {
    const m = md.match(/Basic fitout\s*\|\s*(₹[\d,]+)/);
    assert.ok(m, "row 'Basic fitout' not found in pricing.md");
    assert.equal(rupees(m[1]), PRICE_FLOORS.commercialPerSqft);
  });

  it("single room low end", () => {
    const m = md.match(/Single room redesign[^₹]*₹([\d.]+)\s*lakh/);
    assert.ok(m, "'Single room redesign' line not found in pricing.md");
    assert.equal(Math.round(Number(m[1]) * 100_000), PRICE_FLOORS.singleRoom);
  });
});
