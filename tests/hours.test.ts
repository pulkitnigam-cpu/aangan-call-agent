import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { callbackDue, describeDue, escalationDue, frontDeskDue, isBusinessHours } from "../lib/hours";

const at = (iso: string) => new Date(iso);

describe("studio hours (IST, 10am–7pm, every day)", () => {
  it("knows open and closed", () => {
    assert.equal(isBusinessHours(at("2026-10-06T15:00:00+05:30")), true); // Tue 3pm
    assert.equal(isBusinessHours(at("2026-10-06T19:00:00+05:30")), false); // Tue 7pm
    assert.equal(isBusinessHours(at("2026-10-06T09:59:00+05:30")), false);
  });

  it("is open on weekends and holidays", () => {
    assert.equal(isBusinessHours(at("2026-10-10T12:00:00+05:30")), true); // Sat
    assert.equal(isBusinessHours(at("2026-10-11T18:30:00+05:30")), true); // Sun
    assert.equal(isBusinessHours(at("2026-11-08T11:00:00+05:30")), true); // Diwali 2026
  });
});

describe("callback deadline", () => {
  it("in hours: 2 hours", () => {
    const c = at("2026-10-06T15:00:00+05:30");
    assert.equal(callbackDue(c).toISOString(), at("2026-10-06T17:00:00+05:30").toISOString());
    assert.equal(describeDue(c, callbackDue(c)), "within 2 hours");
  });

  it("late night: noon next day, never 1am", () => {
    const c = at("2026-10-06T23:10:00+05:30");
    assert.equal(callbackDue(c).toISOString(), at("2026-10-07T12:00:00+05:30").toISOString());
    assert.equal(describeDue(c, callbackDue(c)), "by 12 noon tomorrow");
  });

  it("early morning: noon the same day", () => {
    const c = at("2026-10-07T07:30:00+05:30");
    assert.equal(describeDue(c, callbackDue(c)), "by 12 noon today");
  });

  it("regression (W05): Friday and Saturday nights roll to the next morning, not Monday", () => {
    const fri = at("2026-10-09T21:00:00+05:30");
    assert.equal(callbackDue(fri).toISOString(), at("2026-10-10T12:00:00+05:30").toISOString());
    assert.equal(describeDue(fri, callbackDue(fri)), "by 12 noon tomorrow");
    const sat = at("2026-10-10T20:44:00+05:30");
    assert.equal(describeDue(sat, callbackDue(sat)), "by 12 noon tomorrow");
  });

  it("regression: front desk never promises '2 hours' it can't keep before 7pm", () => {
    const early = at("2026-10-06T15:00:00+05:30");
    assert.equal(describeDue(early, frontDeskDue(early)), "within 2 hours");
    const late = at("2026-10-06T18:55:00+05:30"); // desk leaves at 7
    assert.equal(frontDeskDue(late).toISOString(), at("2026-10-07T12:00:00+05:30").toISOString());
    assert.equal(describeDue(late, frontDeskDue(late)), "by 12 noon tomorrow");
  });

  it("regression: the phrase follows the real gap, not just 'is the studio open'", () => {
    const c = at("2026-10-07T09:59:00+05:30"); // one minute before opening
    assert.equal(describeDue(c, callbackDue(c)), "by 12 noon today");
  });

  it("complaints: 15 minutes in hours, 10:30am next morning otherwise", () => {
    const day = at("2026-10-06T11:32:00+05:30");
    assert.equal(describeDue(day, escalationDue(day)), "within 15 minutes");
    const night = at("2026-10-06T22:00:00+05:30");
    assert.equal(describeDue(night, escalationDue(night)), "by 10:30 am tomorrow");
  });
});
