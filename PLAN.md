# EV Charging Log — Project Plan

## 1. Purpose

Replace the manual "Record of Home Charging" spreadsheet with a small self-hosted
web app that:

1. Logs home and public (commercial) EV charging sessions long-term.
2. Generates a per-billing-period report in the exact layout the lease company
   expects (mirrors `Record of Home Charging July 2026.xlsx`).
3. Supports both flat-rate and peak/off-peak electricity pricing.
4. Adds quality-of-life extras for personal use: km/kWh efficiency, and a
   dashboard with historical charts.

Single user, single vehicle. No multi-tenancy, no auth (see §6).

## 2. What the spreadsheet currently captures

Reverse-engineered from `Record of Home Charging July 2026.xlsx`:

**Header block**
- Full Name, VIN/Registration
- Starting Date / Closing Date (the electricity bill period)
- `Claiming kW/h` — total home kWh for the period
- `Rate kW/h` — flat rate at the time

**Home charging table** — one row per session:
`Time | Date | Odometer | kWh Used | Location`

**Commercial charging table** ("already claimed through portal") — same columns,
listed separately since it's *not* being claimed again from the lease company.

**Summary rows**
- Total kWh Used (home) → Cost = Total kWh × Rate
- Total kWh Claimed (public)
- Percentage of Home charging = home kWh ÷ (home kWh + public kWh)

The app's data model and report generator are built directly around this shape.

## 3. Decisions (confirmed with user)

| Area | Decision |
|---|---|
| Framework | SvelteKit only — no separate backend service. SvelteKit server routes/form actions serve as the API layer against SQLite directly. |
| UI | Svelte + Material Design components. **Note:** MUI itself is React-only — the Svelte equivalent is **SMUI (Svelte Material UI)**, which will be used to match the "Material UI" look and feel. |
| Persistence | SQLite via **Drizzle ORM** + `better-sqlite3`. Type-safe schema/queries, minimal ceremony, fits a single-user app. |
| Report output | **Excel export matching the original template.** Use `exceljs` to load the original `.xlsx` as a template and fill in cells/rows, preserving the existing formatting/styles, rather than generating a layout from scratch. |
| Historical import | Other monthly spreadsheets exist in the same layout and will be backfilled. Import parses header fields + both tables via `exceljs`, shows a preview/review screen, and commits on confirmation. |
| Deployment | Self-hosted on home NAS (Docker), reachable on the home network only. |
| Access control | None — the home network is the trust boundary. No login screen. |
| Rate plans | Time-of-day windows. A rate plan is either `flat` (single rate) or `peak-offpeak` (peak/off-peak rates + configurable time windows, e.g. off-peak 22:00–07:00). Session cost is computed by splitting session time across the applicable windows. Rate plans are versioned by effective date, since rates change over time. |
| Efficiency calc | km/kWh per session = (odometer at this session − odometer at previous session) ÷ kWh added this session. |

## 4. Data model (Drizzle schema, SQLite)

```
settings
  id (singleton row)
  full_name
  vehicle_label        -- rego or VIN, as printed on the report

rate_plans
  id
  effective_from        -- date this plan starts applying
  type                  -- 'flat' | 'peak_offpeak'
  flat_rate             -- nullable, $/kWh
  peak_rate             -- nullable, $/kWh
  offpeak_rate          -- nullable, $/kWh
  offpeak_windows       -- JSON: [{ start: "HH:mm", end: "HH:mm" }, ...]

billing_periods
  id
  label                 -- e.g. "July 2026"
  start_date
  end_date
  submitted_at          -- nullable; set once report is generated/submitted

charging_sessions
  id
  billing_period_id     -- FK, nullable until assigned (auto-assign by date on save)
  kind                  -- 'home' | 'public'
  date
  time
  odometer_km
  kwh_used
  location
  cost                  -- computed at save time from the active rate_plan (home only;
                         -- public sessions are already claimed elsewhere, cost not needed
                         -- for the report but stored for the dashboard if known)
  notes
```

Derived, not stored: totals per period, home %, cost breakdown, km/kWh — all
computed from `charging_sessions` + `rate_plans` so historical rate changes
stay correct.

## 5. Core features

### 5.1 Session logging
- Form to add a home or public charging session (time, date, odometer, kWh, location).
- Odometer validation: warn if lower than the last recorded odometer reading.
- On save, session is auto-assigned to the billing period whose date range contains it (or left unassigned with a prompt to create one).

### 5.2 Rate plan management
- CRUD for rate plans: flat or peak/off-peak, with effective-from date.
- Peak/off-peak sessions split cost proportionally by minutes in each window.

### 5.3 Billing periods & report generation
- CRUD for billing periods (start/end date, label).
- Period detail view: home sessions, public sessions, computed totals/cost/%,
  matching the spreadsheet summary block.
- "Export report" button → fills the original xlsx template via `exceljs` and
  downloads a file ready to submit to the lease company.

### 5.4 Historical import
- Upload a legacy monthly `.xlsx`.
- Parser extracts header fields + both session tables.
- Review screen: editable preview of parsed rows before committing.
- Commit creates the billing period + sessions in one transaction.

### 5.5 Dashboard (personal use only, not part of the lease report)
- km/kWh trend over time (line chart).
- Home vs public charging split over time (stacked bar or area).
- Cost per period trend.
- Simple KPI tiles: lifetime kWh, lifetime cost, average efficiency, current period % home.
- (When building charts: consult the `dataviz` skill for chart/color/layout conventions before writing chart code.)

## 6. Non-goals (explicitly out of scope)

- Multi-user auth, roles, or accounts.
- Multi-vehicle support (single `settings` row is enough for now; can be revisited if needed).
- Cloud hosting / public internet exposure.
- Native mobile app (a responsive web UI is sufficient on the home network).

## 7. Tech stack summary

- **Language**: TypeScript everywhere.
- **App framework**: SvelteKit (adapter-node, for Docker deployment on NAS).
- **UI**: Svelte + SMUI (Material Design components), custom theme.
- **DB**: SQLite file, Drizzle ORM, `better-sqlite3` driver, Drizzle Kit for migrations.
- **Spreadsheet I/O**: `exceljs` (both import parsing and template-based export).
- **Charts**: lightweight Svelte-friendly charting lib (e.g. LayerChart or Chart.js via a thin wrapper) — final pick made during dashboard implementation.
- **Testing**: Vitest for calculation logic (rate splitting, totals, efficiency, import parsing) — these are the parts most worth covering since they're the whole point of trusting the report.
- **Deployment**: Dockerfile (multi-stage build) + docker-compose, SQLite file on a mounted volume so data survives container rebuilds.

## 8. Project structure (initial)

```
ev-charging-log/
  src/
    lib/
      server/
        db/
          schema.ts
          index.ts          -- drizzle client
        rates.ts             -- rate plan resolution + cost splitting logic
        report.ts            -- exceljs template fill/export
        import.ts            -- legacy xlsx parsing
      components/            -- Svelte UI components (forms, tables, charts)
    routes/
      +page.svelte            -- dashboard
      sessions/+page.svelte    -- log/list sessions
      periods/                 -- billing period list/detail/report export
      rates/+page.svelte       -- rate plan management
      import/+page.svelte      -- historical import + review
  drizzle/                     -- generated migrations
  static/
    templates/
      home-charging-template.xlsx  -- the original file, used as export template
  Dockerfile
  docker-compose.yml
  PLAN.md
```

## 9. Build phases

1. **Scaffold**: SvelteKit + TS project, SMUI theme wired up, Drizzle schema + migrations, Docker setup working end-to-end with an empty DB.
2. **Core logging**: settings, rate plans, session CRUD, billing period CRUD — no report/import yet.
3. **Report generation**: rate-splitting/cost logic (with tests), exceljs export matching the original template, verified against the July 2026 file as a known-good case.
4. **Historical import**: parser + review screen, backfill real historical data.
5. **Dashboard**: efficiency + trend charts once there's enough real historical data to make them meaningful.
6. **Deployment**: finalize Dockerfile/compose, deploy to NAS, confirm persistence across container restarts.

## 10. Open items to revisit during build

- Confirm exact peak/off-peak window(s) and rates once you're on that plan, to validate the splitting logic against a real bill.
- Decide final charting library once dashboard UI is underway.
- Decide whether "public charging" sessions need their own cost tracking, or just kWh (since they're already claimed elsewhere and don't affect what you submit).
