# EV Charging Log

A small self-hosted app for tracking EV charging sessions (home + public),
splitting cost across flat-rate or peak/off-peak electricity plans, and
generating lease-company billing reports — replacing a manual spreadsheet
workflow.

Built for a single user / single vehicle. No accounts, no auth — designed to
run on a home network.

See [PLAN.md](PLAN.md) for the full project plan, data model, and build phases.

## Features

- Log home and public charging sessions (time, date, odometer, kWh, location).
- Flat-rate or peak/off-peak electricity plans, versioned by effective date.
- Per billing-period reports matching the format expected by a lease company,
  exported as a filled-in `.xlsx`.
- Import historical spreadsheet data.
- Personal dashboard: km/kWh efficiency trend, home vs public charging split,
  cost over time.

## Tech stack

- **SvelteKit** (TypeScript) — single app, no separate backend service.
- **SMUI** (Svelte Material UI) for the component layer.
- **SQLite** via Drizzle ORM + `better-sqlite3`.
- **exceljs** for spreadsheet import/export.
- **Vitest** for testing calculation logic.
- Deployed via **Docker** to a home NAS.

## Status

Early planning stage — see [PLAN.md](PLAN.md) for the build phases.

## A note on privacy

This project handles personal data (vehicle details, home address, charging
history). Raw spreadsheets, the live SQLite database, and `.env` files are
gitignored and must never be committed — see [.gitignore](.gitignore).
