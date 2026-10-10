// This app is an API backend; the dashboard lives in HubSpot.
export default function Home() {
  return (
    <main style={{ padding: 32, fontFamily: "var(--font-geist-sans)" }}>
      <h1>Aangan Call Agent</h1>
      <p>
        Backend for Aangan Studio&apos;s AI phone receptionist. Check <a href="/api/health">/api/health</a>.
      </p>
    </main>
  );
}
