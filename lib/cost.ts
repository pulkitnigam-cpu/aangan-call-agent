import { numberEnv } from "./env";

// What the system costs to run, in INR (the brief: "including the cost of the
// tool doing it"). Formula from the build brief:
//
//   cost = minutes × COST_PER_MIN_VANI_INR
//        + input_tokens/1000  × COST_PER_1K_INPUT_GEMINI_INR
//        + output_tokens/1000 × COST_PER_1K_OUTPUT_GEMINI_INR
//
// Rates live in env vars so they change without a deploy. Never hardcode prices.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

let warnedMissingRates = false;

function rates() {
  // COST_PER_1K_TOKENS_GEMINI_INR is the older single rate; used if the split ones aren't set.
  const legacy = numberEnv("COST_PER_1K_TOKENS_GEMINI_INR", 0);
  return {
    perMinVani: numberEnv("COST_PER_MIN_VANI_INR", 0),
    per1kIn: numberEnv("COST_PER_1K_INPUT_GEMINI_INR", legacy),
    per1kOut: numberEnv("COST_PER_1K_OUTPUT_GEMINI_INR", legacy),
  };
}

function warnIfMissing(values: number[]) {
  if (values.some((v) => v === 0) && !warnedMissingRates) {
    warnedMissingRates = true;
    console.warn("[cost] a COST_PER_* rate is not set; costs will be understated");
  }
}

/** Gemini tokens alone (Telegram bot questions, extraction retries). */
export function tokenCostInr({ inputTokens, outputTokens }: TokenUsage): number {
  const r = rates();
  warnIfMissing([r.per1kIn, r.per1kOut]);
  const cost = (Math.max(0, inputTokens) / 1000) * r.per1kIn + (Math.max(0, outputTokens) / 1000) * r.per1kOut;
  return Math.round(cost * 10_000) / 10_000;
}

/** One AI-handled call: voice minutes + Gemini tokens, rounded to paise. */
export function computeCallCostInr({ durationSec, inputTokens, outputTokens }: TokenUsage & { durationSec: number }): number {
  const r = rates();
  warnIfMissing([r.perMinVani, r.per1kIn, r.per1kOut]);
  // Telephony is usually billed per started minute. TODO(vani-docs): confirm Vani's billing unit.
  const billedMinutes = Math.ceil(Math.max(0, durationSec) / 60);
  const cost = billedMinutes * r.perMinVani + tokenCostInr({ inputTokens, outputTokens });
  return Math.round(cost * 100) / 100;
}
