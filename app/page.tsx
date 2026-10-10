import { redirect } from "next/navigation";

// The app is the dashboard; Nikhil's business view lives in HubSpot.
export default function Home() {
  redirect("/dashboard");
}
