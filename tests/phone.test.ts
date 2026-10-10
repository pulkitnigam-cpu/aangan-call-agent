import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { normalizePhone } from "../lib/phone";

describe("normalizePhone", () => {
  it("maps every way an Indian mobile arrives to one form", () => {
    for (const raw of ["+91 98123 45678", "+919812345678", "919812345678", "09812345678", "98123-45678", " (981) 234 5678 ", "0919812345678"]) {
      assert.equal(normalizePhone(raw), "+919812345678", raw);
    }
  });

  it("handles a Pune landline with STD code", () => {
    assert.equal(normalizePhone("020 2567 1234"), "+912025671234");
  });

  it("keeps foreign numbers (NRI clients)", () => {
    assert.equal(normalizePhone("+1 (415) 555-0123"), "+14155550123");
    assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  });

  it("rejects junk", () => {
    for (const raw of ["", null, undefined, "anonymous", "12345", "0000000000", "+91 98123"]) {
      assert.equal(normalizePhone(raw), null, String(raw));
    }
  });
});
