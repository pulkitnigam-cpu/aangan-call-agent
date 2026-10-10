import Link from "next/link";
import "../ui.css";
import { TestCall } from "@/components/test-call/TestCall";

export const metadata = { title: "Aangan · Test call" };

// Talk to the Aangan agent from the browser. Each call is pulled from Vaani's
// API when it ends and handled exactly like a phone call (no webhook needed).
export default function TestCallPage() {
  return (
    <main className="aangan shell">
      <div className="wrap" style={{ maxWidth: 720 }}>
        <div className="topbar">
          <div className="brand"><span className="brand-mark">A</span>Aangan · Test call</div>
          <span className="spacer" />
          <Link className="pill" href="/dashboard">Dashboard</Link>
        </div>
        <TestCall />
      </div>
    </main>
  );
}
