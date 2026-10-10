// Provider-neutral call events. Everything after the voice adapter works with
// these types only, so swapping Vaani Voice for another provider (or adding
// WhatsApp / the web form later) means writing a new adapter, nothing else.

import type { ExtractedLead } from "../gemini";

export type { ExtractedLead };

export type Turn = { role: "agent" | "caller"; text: string };

export interface CallStartedEvent {
  providerCallId: string;
  callerPhone: string;
}

export interface CallEndedEvent {
  providerCallId: string;
  callerPhone: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSec: number;
  status: "completed" | "dropped" | "failed";
  recordingConsent: boolean | null;
  turns: Turn[];
  /** Structured fields if the provider extracted them; otherwise Gemini does. */
  extraction: ExtractedLead | null;
  llmInputTokens: number;
  llmOutputTokens: number;
  raw: unknown;
}

export interface ToolCallEvent {
  providerCallId: string | null;
  args: Record<string, unknown>;
}
