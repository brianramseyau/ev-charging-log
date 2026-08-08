# EV Charging Log

A small self-hosted app for tracking EV charging sessions (home + public),
splitting cost across flat-rate or peak/off-peak electricity plans, and
generating lease-company billing reports — replacing a manual spreadsheet
workflow.

Built for a single user / single vehicle. No accounts, no auth — designed to
run on a home network (Unraid).

See [PLAN.md](PLAN.md) for the full project plan, data model, and build phases.

## Screenshots

### Desktop

| Dashboard                                                                          | Billing period detail                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| <img src="docs/images/dashboard-desktop.png" width="420" alt="Dashboard, desktop"> | <img src="docs/images/period-detail-desktop.png" width="420" alt="Billing period detail, desktop"> |

### Mobile

| Dashboard                                                                        | Billing period detail                                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| <img src="docs/images/dashboard-mobile.png" width="220" alt="Dashboard, mobile"> | <img src="docs/images/period-detail-mobile.png" width="220" alt="Billing period detail, mobile"> |

## Features

- Log home and public charging sessions (time, date, odometer, kWh, location).
- Flat-rate or peak/off-peak electricity plans, versioned by effective date.
- Per billing-period reports matching the format expected by a lease company,
  exported as a filled-in `.xlsx`.
- Import historical spreadsheet data.
- Optional Evnex charger integration: pull recent home-charging sessions in
  as drafts, so only the odometer needs typing in by hand.
- Personal dashboard: km/kWh efficiency trend, home vs public charging split,
  cost over time.
- Installable PWA, mobile-first UI.

## Tech stack

- **SvelteKit** (TypeScript) — single app, no separate backend service.
- **SMUI** (Svelte Material UI) for the component layer.
- **SQLite** via Drizzle ORM + `better-sqlite3`.
- **exceljs** for spreadsheet import/export.
- **Vitest** for testing calculation logic.
- Deployed via **Docker** (PUID/PGID-aware) to a home Unraid server.
- Optional **Electron** desktop build (macOS, unsigned) for personal use
  alongside the Docker deployment.

## Developing

Install dependencies with `npm install`, then start a dev server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

Migrations apply automatically on server boot (see `src/hooks.server.ts`). If
you change `src/lib/server/db/schema.ts`, generate a new migration file with:

```sh
npm run db:generate
```

## Evnex integration

Optional, and entirely configured in the app — open `/settings`, sign in with
an ordinary Evnex account (the same email/password as the Evnex mobile app),
pick your charge point, and switch it on. No environment variables, no config
file — the password is used once to sign in and never stored, and the same
setup flow works identically on every deployment, Electron included.

It talks to Evnex's consumer Cloud API, which has no published specification,
so worth saying plainly: it's built against a reverse-engineered contract and
may break if Evnex changes it without notice. See
[foundational/EVNEX-INTEGRATION-PLAN.md](foundational/EVNEX-INTEGRATION-PLAN.md)
for the full design.

## Building

To create a production version of the app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

## Deploying

`docker build -t ev-charging-log .` builds a production image with a
linuxserver.io-style `PUID`/`PGID` entrypoint (see `docker/entrypoint.sh`) so
files written to the mounted `/data` volume end up owned by the right user —
no docker-compose needed. On Unraid, use the template at
[unraid/ev-charging-log.xml](unraid/ev-charging-log.xml).

## Desktop app (Electron)

For personal convenience, the same app can also run as a self-contained macOS
desktop app instead of (or alongside) the Docker deployment — see
[PLAN.md §11](PLAN.md#11-electron-desktop-distribution-optional-alongside-docker)
for the full design. It bundles the production `adapter-node` build and runs
it as a local child process, with an Electron window pointed at
`http://127.0.0.1:<port>`; by default the SQLite database lives under the
OS's per-app data directory (`~/Library/Application Support/ev-charging-log`
on macOS) as its own separate dataset from any Docker deployment.

To have the desktop build read/write the _same_ database as an existing
Docker deployment instead (e.g. a file shared over a network mount), create
`config.json` in that per-app data directory before first launch:

```json
{ "databasePath": "/path/to/ev-charging-log.db" }
```

Run it in dev mode (rebuilds first, then launches Electron against that
build):

```sh
npm run electron:dev
```

Package a distributable `.dmg`/`.zip` with `electron-builder`:

```sh
npm run electron:build
```

Output lands in `release/`. This is a single-user, unsigned build — macOS
(`.dmg`/`.zip`), Windows (`.exe` via NSIS), and Linux (`.AppImage`) targets
are all packaged from `electron-release.yml` on tag push, one job per OS
since native module rebuilds (`better-sqlite3`) need to happen on the real
target platform. No code signing/notarization for any of them (see
PLAN.md §11.5).

App name and icon (window/Dock/taskbar, and packaged `.icns`/`.ico`) come
from the same source logo as the PWA icons (`src/lib/assets/logo.svg`),
rasterized to `electron/resources/icon.png` by `npm run icons:generate`
(part of `npm install`'s `prepare` step) — not Electron's defaults.

Packaged builds check GitHub Releases for a newer version on launch and
prompt to download/install it (via `electron-updater`, reading the same
`publish` config used to publish releases) — nothing to configure, it's a
no-op when running unpackaged (`electron:dev`).

## Status

Core features are built: session logging, rate plans (flat + peak/off-peak),
billing periods with xlsx report export, historical import, a personal
dashboard, and settings — all mobile-first with SMUI, running as a PWA. See
[PLAN.md](PLAN.md) for the original design and remaining open items (§10),
such as confirming real peak/off-peak rates once you're on that plan.

## A note on privacy

This project handles personal data (vehicle details, home address, charging
history). Raw spreadsheets, the live SQLite database, and `.env` files are
gitignored and must never be committed — see [.gitignore](.gitignore).
