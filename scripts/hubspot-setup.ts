// One-time HubSpot setup:
//   1. creates the custom deal properties the backend writes (skips ones that exist)
//   2. prints your deal pipelines and stage ids, to copy into HUBSPOT_PIPELINE_ID / HUBSPOT_STAGE_*
//
//   HUBSPOT_TOKEN=... npm run hubspot:setup
//
// The token is a HubSpot private app token with scopes:
//   crm.objects.contacts.read/write, crm.objects.deals.read/write,
//   crm.schemas.deals.read/write, crm.objects.tasks? (tasks use the contacts scopes on most accounts)

import { config } from "dotenv";
import { DEAL_PROPERTIES, hs } from "../lib/hubspot";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("Set HUBSPOT_TOKEN first.");

  for (const p of DEAL_PROPERTIES) {
    const body: Record<string, unknown> = { name: p.name, label: p.label, type: p.type, fieldType: p.fieldType, groupName: "dealinformation" };
    if ("options" in p) body.options = p.options.map((o, i) => ({ label: o.replace("_", " "), value: o, displayOrder: i }));
    if (p.type === "bool") body.options = [{ label: "Yes", value: "true", displayOrder: 0 }, { label: "No", value: "false", displayOrder: 1 }];
    try {
      await hs("POST", "/crm/v3/properties/deals", body);
      console.log(`created  ${p.name}`);
    } catch (err) {
      if ((err as { status?: number }).status === 409) console.log(`exists   ${p.name}`);
      else throw err;
    }
  }

  const pipelines = await hs<{ results: { id: string; label: string; stages: { id: string; label: string }[] }[] }>("GET", "/crm/v3/pipelines/deals");
  console.log("\nDeal pipelines — copy the ids into your env:\n");
  for (const pl of pipelines.results) {
    console.log(`HUBSPOT_PIPELINE_ID=${pl.id}   # ${pl.label}`);
    for (const s of pl.stages) console.log(`   ${s.id.padEnd(24)} ${s.label}`);
  }
  console.log(`
Create (or rename) stages so you have: New call, Qualified, Visit booked, Visit done, Won, Lost.
Then set HUBSPOT_STAGE_NEW / _QUALIFIED / _VISIT_BOOKED / _VISIT_DONE / _WON / _LOST.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
