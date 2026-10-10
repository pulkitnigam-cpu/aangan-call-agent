"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";

type Phase = "idle" | "connecting" | "live" | "processing" | "done" | "error";
type Result = { leadId: string | null; kind: string };

const SCENARIOS = [
  ["Good new client", "\"I'm Rahul. 2BHK in Baner, about 900 sq ft. Full design and execution, done by March.\""],
  ["Asks the price", "A good project, but keep asking \"roughly how much per sq ft?\""],
  ["Not a fit", "\"I only want design drawings, no execution.\""],
  ["Unsure", "Vague answers: \"not sure about the size, maybe next year.\""],
  ["Wants a human", "An existing client, upset about a delay: \"I want to talk to a person.\""],
  ["Hindi / vendor", "Speak Hindi, or try to sell them tiles."],
];

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function TestCall() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [endedBy, setEndedBy] = useState("");
  const roomRef = useRef<Room | null>(null);
  const callRef = useRef<{ id: string; startedAt: number } | null>(null);
  const endingRef = useRef(false);

  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setSecs(Math.floor((Date.now() - (callRef.current?.startedAt ?? Date.now())) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => () => void roomRef.current?.disconnect(), []);

  async function start() {
    setPhase("connecting");
    setError("");
    setResult(null);
    setSecs(0);
    endingRef.current = false;
    try {
      const res = await fetch("/api/test-call/start", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not start the call.");
      const { Room, RoomEvent, Track } = await import("livekit-client");
      const room = new Room();
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) document.body.appendChild(track.attach());
      });
      room.on(RoomEvent.Disconnected, (reason) => void finish(`room closed (${reason ?? "unknown"})`)); // the agent hung up, or the 4-min cap
      room.on(RoomEvent.ParticipantDisconnected, (p) => console.info("[test-call] left:", p.identity));
      await room.connect(body.url, body.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      callRef.current = { id: body.room, startedAt: Date.now() };
      setPhase("live");
    } catch (e) {
      roomRef.current?.disconnect();
      setError(e instanceof Error && /permission|NotAllowed/i.test(e.message) ? "Allow the microphone and try again." : e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }

  async function finish(endedBy = "you pressed End") {
    if (endingRef.current || !callRef.current) return;
    endingRef.current = true;
    const { id, startedAt } = callRef.current;
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    roomRef.current?.disconnect();
    document.querySelectorAll("audio").forEach((a) => a.remove());
    setEndedBy(endedBy);
    setPhase("processing");
    await fetch("/api/test-call/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: id, durationSec, endedBy }) }).catch(() => {});
    // Vaani needs a little while to finish the transcript and analysis.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 6000));
      const r = await fetch(`/api/test-call/status?room=${id}`).then((x) => x.json()).catch(() => null);
      if (r?.state === "done") {
        setResult({ leadId: r.leadId, kind: r.kind });
        setPhase("done");
        return;
      }
    }
    setError("Vaani is taking long. The call will still appear in the report (npm run report).");
    setPhase("error");
  }

  return (
    <>
      <div className="card" style={{ textAlign: "center", padding: "28px 20px" }}>
        {phase === "idle" || phase === "error" || phase === "done" ? (
          <>
            <button className="call-btn" onClick={start}>📞 Start a test call</button>
            <p className="stat-sub" style={{ marginTop: 12 }}>Allow the microphone. The agent speaks first. Calls stop at 4 minutes.</p>
          </>
        ) : phase === "connecting" ? (
          <p className="stat-value">Connecting…</p>
        ) : phase === "live" ? (
          <>
            <p className="stat-label">On the call</p>
            <p className="stat-value">{mmss(secs)}</p>
            <button className="call-btn end" onClick={() => finish()}>End call</button>
          </>
        ) : (
          <>
            <p className="stat-value">Processing…</p>
            <p className="stat-sub">Getting the transcript from Vaani and sending it to the designer. Usually under a minute.</p>
          </>
        )}
        {endedBy && phase !== "live" && <p className="stat-sub" style={{ marginTop: 8 }}>Call ended: {endedBy}</p>}
        {error && <p style={{ color: "var(--critical)", marginTop: 12 }}>{error}</p>}
        {phase === "done" && result && (
          <p style={{ marginTop: 14 }}>
            ✅ Saved{result.kind !== "lead" && result.kind !== "already" ? ` (${result.kind.replace("_", " ")})` : ""}.{" "}
            {result.leadId ? <Link href={`/dashboard/leads/${result.leadId}`}>Open the lead →</Link> : <Link href="/dashboard">Open the dashboard →</Link>}
          </p>
        )}
      </div>

      <div className="card">
        <div className="card-title">Try these six</div>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
          {SCENARIOS.map(([title, line]) => (
            <li key={title}><b>{title}:</b> <span style={{ color: "var(--ink-2)" }}>{line}</span></li>
          ))}
        </ol>
      </div>
    </>
  );
}
