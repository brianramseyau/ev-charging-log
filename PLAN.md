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
listed separately since it's _not_ being claimed again from the lease company.

**Summary rows**

- Total kWh Used (home) → Cost = Total kWh × Rate
- Total kWh Claimed (public)
- Percentage of Home charging = home kWh ÷ (home kWh + public kWh)

The app's data model and report generator are built directly around this shape.

## 3. Decisions (confirmed with user)

| Area                   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework              | SvelteKit only — no separate backend service. SvelteKit server routes/form actions serve as the API layer against SQLite directly.                                                                                                                                                                                                                                                                                                                          |
| UI                     | Svelte + Material Design components. **Note:** MUI itself is React-only — the Svelte equivalent is **SMUI (Svelte Material UI)**, which will be used to match the "Material UI" look and feel. Built **mobile-first**: the app will almost always be used on a phone (logging a session standing at the charger), so layouts, forms, and navigation are designed for a small screen first and progressively enhanced for desktop, not the other way around. |
| Persistence            | SQLite via **Drizzle ORM** + `better-sqlite3`. Type-safe schema/queries, minimal ceremony, fits a single-user app.                                                                                                                                                                                                                                                                                                                                          |
| Report output          | **Excel export matching the original template.** Use `exceljs` to load the original `.xlsx` as a template and fill in cells/rows, preserving the existing formatting/styles, rather than generating a layout from scratch.                                                                                                                                                                                                                                  |
| Historical import      | Other monthly spreadsheets exist in the same layout and will be backfilled. Import parses header fields + both tables via `exceljs`, shows a preview/review screen, and commits on confirmation.                                                                                                                                                                                                                                                            |
| Deployment             | Self-hosted Docker container on **Unraid**, reachable on the home network only. No docker-compose — an **Unraid Community Applications template** is provided instead, since that's Unraid's native way to configure and launch a container.                                                                                                                                                                                                                |
| Container user mapping | Dockerfile follows the **linuxserver.io-style `PUID`/`PGID`** convention: container starts as root, an entrypoint script creates/adjusts a user to the given `PUID`/`PGID`, `chown`s the mounted data volume, then drops privileges (via `su-exec`/`gosu`) to run the app. This keeps file ownership on the Unraid array/cache correct instead of everything landing as root.                                                                               |
| Access control         | None — the home network is the trust boundary. No login screen.                                                                                                                                                                                                                                                                                                                                                                                             |
| Rate plans             | Time-of-day windows. A rate plan is either `flat` (single rate) or `peak-offpeak` (peak/off-peak rates + configurable time windows, e.g. off-peak 22:00–07:00). Session cost is computed by splitting session time across the applicable windows. Rate plans are versioned by effective date, since rates change over time.                                                                                                                                 |
| Efficiency calc        | km/kWh per session = (odometer at this session − odometer at previous session) ÷ kWh added this session.                                                                                                                                                                                                                                                                                                                                                    |
| App type               | Installable **PWA** from the start (manifest + service worker + icon set), not added on later.                                                                                                                                                                                                                                                                                                                                                              |
| Branding               | A generated EV-charging-themed logo/icon set for the PWA, and a custom error page with a cartoon "crashed EV" illustration (see §5.7).                                                                                                                                                                                                                                                                                                                      |

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

### 5.6 PWA

- Installable on desktop and mobile from day one (Add to Home Screen), since charging sessions will often be logged from a phone.
- `manifest.webmanifest` (name, theme/background colour, icon set) + a service worker (via `@vite-pwa/sveltekit`) for an app shell/offline shell and installability.
- Icon set generated from the master logo (see §5.7) at the standard PWA sizes (e.g. 192×192, 512×512, maskable variants, plus a favicon).

### 5.7 Branding: logo & error page

- **Logo**: an EV-charging-themed mark (car + charging plug/bolt motif) used as the app logo, PWA icon set, and favicon. Provided as a master SVG that's rasterized to the required PWA icon sizes during the scaffold phase.
- **Error page**: SvelteKit's `+error.svelte` is replaced with a custom page featuring a cartoon "crashed EV" illustration and a light, "oh no, it crashed!" tone, rather than a bare stack trace — used for both unhandled app errors and the PWA offline fallback.

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
- **PWA**: `@vite-pwa/sveltekit` for manifest + service worker generation.
- **Deployment**: multi-stage Dockerfile with a `PUID`/`PGID`-aware entrypoint script (linuxserver.io style — `su-exec`/`gosu` to drop from root to the mapped user after fixing ownership of the mounted data volume). No docker-compose; an **Unraid Community Applications template XML** is provided instead. SQLite file lives on a mounted volume so data survives container rebuilds.

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
      assets/
        logo.svg               -- master EV-charging-themed logo
        crashed-ev.svg         -- cartoon illustration used on the error page
    routes/
      +page.svelte            -- dashboard
      +error.svelte            -- custom "crashed EV" error page
      sessions/+page.svelte    -- log/list sessions
      periods/                 -- billing period list/detail/report export
      rates/+page.svelte       -- rate plan management
      import/+page.svelte      -- historical import + review
  drizzle/                     -- generated migrations
  static/
    templates/
      home-charging-template.xlsx  -- sanitized template, used as export template (see §10)
    icons/                      -- generated PWA icon set (rasterized from the master logo)
    manifest.webmanifest
  docker/
    entrypoint.sh                -- PUID/PGID handling (linuxserver.io style), then drops to that user
  unraid/
    ev-charging-log.xml          -- Unraid Community Applications template
  Dockerfile
  PLAN.md
```

## 9. Build phases

1. **Scaffold**: SvelteKit + TS project, SMUI theme wired up, Drizzle schema + migrations, PWA plugin configured with a generated icon set, custom `+error.svelte`, Docker (with PUID/PGID entrypoint) working end-to-end against an empty DB.
2. **Core logging**: settings, rate plans, session CRUD, billing period CRUD — no report/import yet.
3. **Report generation**: rate-splitting/cost logic (with tests), exceljs export matching the original template, verified against the July 2026 file as a known-good case.
4. **Historical import**: parser + review screen, backfill real historical data.
5. **Dashboard**: efficiency + trend charts once there's enough real historical data to make them meaningful.
6. **Deployment**: finalize Dockerfile + entrypoint, publish the Unraid Community Applications template, deploy to Unraid, confirm PUID/PGID ownership and data persistence across container rebuilds.

## 10. Open items to revisit during build

- Confirm exact peak/off-peak window(s) and rates once you're on that plan, to validate the splitting logic against a real bill.
- Decide final charting library once dashboard UI is underway.
- Decide whether "public charging" sessions need their own cost tracking, or just kWh (since they're already claimed elsewhere and don't affect what you submit).
- **Export template file**: the real `Record of Home Charging July 2026.xlsx` contains personal data (name, rego, home address) and is gitignored — it must never be committed. Before phase 3, create a **sanitized version** of the template (same layout/formatting, placeholder values) to check into `static/templates/` so the export feature has something to build/test against in the repo.
- Confirm target Unraid PUID/PGID values (typically `99`/`100` for the default Unraid `nobody`/`users`, but check your setup) when writing the template defaults.

## Ongoing: Enhancements

[x] Enhancement: Home address is almost always the same, in the settings (/settings) allow a user to add their home address. This should then pre-populate the home address into the Location field in sessions (/sessions)
[x] Fix: Let's set a common theme for the charging type colours, anywhere that Home is coloured it should be Blue (#3987e5), and anywhere Public is shown with colour it should be orange (#d95926). These colours are taken from the dashboard area. i'd like them used on other places such as the type chips used in the sessions history area also.
[x] Fix: the app currently has US$ where some money is concerned. Remove any currency related prefixes like this, the only currency symbol/detail should be $ (dollar sign).
[x] Fix: if there is no rate present before adding sessions, no cost is recorded against sessions, and can never be added after due to no edit facility. If a rate is added/changed for a time period, this should update all sessions covered by it. This will also allow if prices change from a given month and sessions exist, it can be updated retrospectively.
