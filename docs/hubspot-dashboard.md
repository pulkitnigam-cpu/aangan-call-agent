# Nikhil's HubSpot dashboard

HubSpot is Nikhil's view of the business. The designers use the custom Vercel dashboard.
Every lead arrives in HubSpot automatically, as a contact and a deal, and moves through the
pipeline as designers tap buttons and visits get booked. Nobody types anything in.

## One-time setup

1. In HubSpot: **Settings → Integrations → Private apps → Create**. Give it scopes for contacts,
   deals and deal schemas (read and write). Copy the token into `HUBSPOT_TOKEN`.
2. **Settings → Objects → Deals → Pipelines**: make sure the pipeline has these stages:
   **New call · Qualified · Visit booked · Visit done · Won · Lost**.
3. Run:
   ```bash
   npm run hubspot:setup
   ```
   This creates the custom deal properties and prints the pipeline and stage ids. Put them into
   `HUBSPOT_PIPELINE_ID` and `HUBSPOT_STAGE_*` in Vercel.

## What the backend writes on each deal

| Property | Meaning |
| -------- | ------- |
| Deal stage | New call → Qualified → Visit booked → Visit done → Won / Lost |
| `lead_score` | qualified / unclear / not_fit (Nikhil's rubric) |
| `area`, `size_sqft`, `budget`, `timeline` | from the call |
| `call_summary` | three lines for the designer |
| `assigned_designer` | who owns it |
| `response_time_min` | designer callback time (night leads counted from 10am) |
| `cost_per_call_inr` | what the AI cost for this lead (Vani minutes + Gemini tokens) |
| `ai_handled` | answered by the AI agent |

Unclear leads also get a **task** for the front desk.

## The reports to build

**Reports → Dashboards → Create dashboard "Enquiries"**, then add these reports
(**Create report → Single object → Deals** unless noted):

| # | Report | How |
| - | ------ | --- |
| 1 | **Enquiries per day** | Deals · count · by *Create date* (day) · line chart |
| 2 | **% qualified** | Deals · count · by `lead_score` · donut, or a single-value KPI filtered to *qualified* |
| 3 | **Median designer response time** | Deals · `response_time_min` · median (or average on free plans) · by week · line chart. Goal ≤ 120 |
| 4 | **Pipeline funnel** | Funnel report on the deal pipeline: New call → Qualified → Visit booked → Won |
| 5 | **Conversion: enquiry → visit → won** | Same funnel, shown as stage-to-stage conversion % |
| 6 | **System cost** | Deals · **sum** of `cost_per_call_inr` · by month · single value |
| 7 | **Cost per qualified lead** | Deals filtered `lead_score = qualified` · sum of `cost_per_call_inr` ÷ count (formula field, or two single-value tiles side by side) |
| 8 | **Leads by designer** | Deals · count · by `assigned_designer` · bar chart |

Free HubSpot plans limit how many custom reports a dashboard can hold. If you hit the limit,
keep 1, 3, 4 and 6: volume, speed, conversion and cost answer Nikhil's four questions. The
same numbers, plus Telegram-bot usage, are also available to admins on the Vercel dashboard
and via `/cost` in the Telegram bot.
