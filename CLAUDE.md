# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted, single-user SvelteKit app for logging EV charging sessions (home + public), computing costs from versioned electricity rate plans, and generating `.xlsx` billing reports for a lease company — replacing a manual spreadsheet workflow. No accounts, no auth. See [PLAN.md](PLAN.md) for the full design doc (data model, feature spec, build phases, open items in §10).

## Commands

```sh
npm run dev              # dev server (add -- --open to launch a browser tab)
npm run build             # production build
npm run preview           # preview the production build
npm run check              # svelte-kit sync + svelte-check (type errors)
npm run lint                # prettier --check + eslint
npm run format              # prettier --write
npm run test:unit           # vitest in watch mode
npm run test                 # vitest --run (single pass, use in CI/pre-commit checks)
npx vitest run path/to/file.test.ts   # run a single test file
npx vitest run -t "test name"          # run tests matching a name

npm run db:generate         # generate a drizzle migration after editing schema.ts
npm run db:studio            # drizzle-kit studio (inspect local db)
npm run db:seed              # wipe + reseed dev DB with ~6 months of demo data (prompts for confirmation; --yes to skip)
npm run db:reset-evnex       # clear Evnex tombstones + previously-imported sessions so the next poll re-imports fresh (keeps the sign-in connected)
```

Migrations apply automatically on server boot (`src/hooks.server.ts` imports `$lib/server/db`, which runs `migrate()`), for both local dev and the Docker image. `db:push`/`db:migrate` exist but aren't part of the normal dev loop.

`src/lib/server/db/index.ts` disables SQLite foreign-key enforcement on the connection _before_ `migrate()` runs and restores it (after a `PRAGMA foreign_key_check`) once it completes. This matters because dropping a column's `NOT NULL` — or any other constraint change SQLite can't do in place — makes drizzle-kit emit a table rebuild (`CREATE __new_x` / `INSERT … SELECT` / `DROP x` / `RENAME`), and with foreign keys enforced (the better-sqlite3 default, unlike the sqlite3 CLI), that `DROP TABLE` cascades into any table referencing it and silently deletes rows the rebuild was meant to preserve. The `PRAGMA foreign_keys=OFF`/`=ON` pair drizzle-kit itself emits in the migration file is dead code here — it runs inside the migrator's `BEGIN`/`COMMIT` transaction, and the pragma is a no-op inside a transaction. Do not "clean up" the connection-level pragma calls in `db/index.ts` by assuming the in-file ones already cover it.

Requires `DATABASE_URL` in `.env` (copy from `.env.example`) — path to the SQLite file.

## Architecture

**No separate API/backend.** SvelteKit server routes (`+page.server.ts` load functions and form `actions`) talk directly to Drizzle/SQLite and pass data straight to Svelte pages — this is a deliberate decision (see PLAN.md), not an omission.

**Layering convention**, consistent across the `home`/`public` session domain:

- `src/lib/server/db/schema.ts` — Drizzle table definitions (source of truth for the data model: `settings`, `ratePlans`, `billingPeriods`, `chargingSessions`, `evnexIntegration`, `evnexDismissedSessions`).
- `src/lib/server/*.ts` (`sessions.ts`, `rates.ts`, `report.ts`, `import.ts`, `evnex.ts`, `car-odometer.ts`) — pure, dependency-free calculation/parsing logic, deliberately kept free of DB imports so it's cheap to unit test. Each has a co-located `*.test.ts`.
- `src/lib/server/evnex-auth.ts`, `evnex-client.ts` — the Evnex integration's impure edges, both built on the `evnex-client` npm package: session/token construction (`evnex-auth.ts`, the only file that imports `evnex-client/auth`) and the actual API calls (`evnex-client.ts`, via the package's `Evnex` client). Not unit tested (network + SDK), unlike `evnex.ts`.
- `src/lib/server/evnex-token.ts` — a narrow, deliberate exception to the "only routes import `$lib/server/db`" rule below: `sessionFor` builds a per-request `EvnexAuth` from a stored integration row with `onTokenUpdate` wired to persist every token the SDK issues, and `recordAuthFailure` records a terminal `EvnexRefreshExpiredError`. Kept in one place so this can't drift between the two callers (`/settings` and the `/sessions` poll action).
- `src/routes/**/+page.server.ts` — the other main place that imports `$lib/server/db` and wires the pure helpers to Drizzle queries and form actions.
- `src/routes/settings/charge-points/+server.ts` — a `+server.ts` exception to the same rule, for the same reason as `evnex-token.ts`: `/settings`' `load` deliberately does _not_ fetch the Evnex charge-point list (token refresh + org lookup + charge-point list against the Evnex API), since awaiting that in `load` blocks page render behind a flaky, unofficial third-party API. The browser fetches this endpoint itself once `/settings` has already mounted.
- `src/lib/server/car-odometer-client.ts` — the car-odometer integration's impure edge: one `fetch` to the companion Home Assistant integration's endpoint (10 s timeout, `version` + shape check via `car-odometer.ts`), plus the dev-only `CAR_ODOMETER_FAKE` stub (`1` serves a synthetic history; `401`/`404`/`outdated`/`unreachable` simulate failures; honoured only by the dev server, never a deployment setting). Not unit tested.
- `src/lib/server/car-odometer-store.ts` — another narrow exception to the db rule, same reasoning as `evnex-token.ts`: `readCompanion` calls the companion and records `lastReadStatus`/`lastReadError`/`lastSuccessAt` in one place, because the `/sessions` banner, nav dot and paused-calls rule are all driven by what it records.
- `src/routes/settings/car-odometer/+server.ts` (the Test button) and `src/routes/sessions/car-odometer/+server.ts` (Read from car, and `?apply=1` auto-fill after Pull from charger) — two more `+server.ts` exceptions. Every call to Home Assistant is made server-side through these, so the secret never reaches the browser; they're fetched by the page rather than run in `load`/a form action so a slow or unreachable HA never blocks page render or an Evnex import.
- `src/routes/+layout.server.ts` — reads only the stored car-odometer status (never the network) to produce the alert behind the nav's Settings dot and the `/sessions` banner.
- `src/lib/dashboard.ts` — same pure-logic pattern, for the personal dashboard (not part of the lease report).

When changing business logic (cost calculation, billing-period assignment, efficiency, import parsing), the pure function in `src/lib/server/*.ts` is almost always the right place — keep DB access in the route's `+page.server.ts`.

### Key domain logic

- **Rate resolution** (`src/lib/server/rates.ts`): rate plans are versioned by `effectiveFrom` date. `resolveRatePlan` picks the plan with the latest `effectiveFrom` that's still `<=` the session date, so historical sessions keep the rate that was actually in effect. For `peak_offpeak` plans, the _entire_ session's kWh is billed at whichever rate applies at the session's start time (the schema has no session duration/end time, so there's no way to split a session that spans a peak/off-peak boundary — this is an intentional approximation, not a bug).
- **Billing period assignment** (`src/lib/server/sessions.ts`): a session is auto-assigned to the billing period whose `[startDate, endDate]` range contains its date, computed at session-create time.
- **Report export** (`src/lib/server/report.ts`): fills `static/templates/home-charging-template.xlsx` (generated by `scripts/generate-template.mjs`, mirrors the original lease-company spreadsheet layout) with a period's sessions and streams back the filled workbook. Row layout is rebuilt dynamically per period size — clears everything below the header block first since periods have varying session counts.
- **Historical import** (`src/lib/server/import.ts`): parses the legacy monthly spreadsheet by scanning for label/header text rather than assuming fixed row/column positions, since section locations vary file to file. Anything unparseable is collected into `issues` for a manual-review screen rather than thrown.
- **Evnex charger integration** (`src/lib/server/evnex.ts`, wired by `/sessions`' `?/pollEvnex` action): pulls recent home-charging sessions from the user's Evnex charger as drafts missing only the odometer. Dedupes on `charging_sessions.externalId` (the Evnex session UUID), since a poll can see the same session repeatedly. The Evnex sessions endpoint takes no date-range parameter, so `importLookbackDays` is enforced entirely client-side in `planImport`, not by the API. UTC timestamps are converted to the app's local `date`/`time` strings via `Intl.DateTimeFormat('en-AU', { hourCycle: 'h23' }).formatToParts()` — never `.format()` (day-first locale output) or `.toISOString().slice(0, 10)` (reads the UTC day, which can land on the wrong local day and therefore the wrong billing period/peak-offpeak rate). Energy is derived from the meter delta in watt-hours (the `evnex-client` package's `sessionEnergyWh`, divided by 1000 in `evnex-client.ts`), never the Evnex-reported `totalEnergyUsage`/`totalCost` figures, since cost must always come from this app's own versioned rate plans. A session with `energyKwh === 0` (meter didn't move — plugged in and immediately stopped) is tombstoned in `evnex_dismissed_sessions` exactly like an `Invalid` `sessionStatus`, never imported as a draft; both are "not a real charge," not "still charging" (which is `energyKwh === null`). **This is an unofficial, undocumented API** (there is no published spec) that can change without notice — the `evnex-client` package (see its README/PARITY.md) is what now stays defensive against that (zod schemas, skip-and-log on the one endpoint it still parses loosely) rather than this app's own hand-written shape-guards.

- **Car odometer via Home Assistant** (`src/lib/server/car-odometer.ts`, see foundational/BYD-INTEGRATION-PLAN.md): a companion HA integration in its own repo (`brianramseyau/ev-charging-log-hass` — no code for it lives here) exposes one read-only endpoint returning the recorded history of an odometer entity and a car-telemetry-timestamp entity. `toReadings` pairs them using the telemetry entity's _state_ (the car's own timestamp) as `carReportedAt`, never HA's recorded `at` — HA re-records stale cloud data while the car sleeps. Readings are dropped unless the unit is exactly `km`, and `unavailable`/`unknown`/`0`/`-1` are unusable. `planOdometerFill` writes an odometer (`odometer_source = 'car'`) only when the car reported it inside the charge's `[startedAt, endedAt]` instants (the car can't move while charging) and every reading in that window agrees; anything else is at most a pre-filled suggestion the user confirms. The BYD charging-state sensors are deliberately _not_ evidence (pyBYD notes "gun connected" doesn't reset). HA's recorder keeps 10 days by default, so a charge older than `oldestRecorded` is `too_old`. `started_at`/`ended_at` are filled by the Evnex import (and backfilled onto open drafts by `planImport`) because converting local `date`/`time` back to instants breaks across DST. A `401`/`404`/version mismatch is a _broken_ status that pauses automatic calls until a successful Test. **Do not** replace the companion with a long-lived HA token "to simplify setup": HA tokens have no scopes (one could unlock the car), and the endpoint-scoped secret is the reason the companion exists.

### Stack specifics

- Svelte 5 in runes mode (forced project-wide via `vite.config.ts`, except `node_modules`).
- SMUI (Svelte Material UI) for components; theme SCSS lives in `src/theme/`, compiled to `static/smui/*.css` via `npm run theme:compile` (part of the `prepare`/`assets:generate` script, runs on `npm install`).
- Vitest is scoped to `src/**/*.{test,spec}.{js,ts}` (server-side pure logic only) — `.svelte.{test,spec}.ts` files are explicitly excluded from the configured test project.
- PWA via `@vite-pwa/sveltekit`.
- `evnex-client` (npm) — a TypeScript port of `hardbyte/python-evnex`, used for both the Cognito session (`evnex-client/auth`'s `EvnexAuth`, imported only by `src/lib/server/evnex-auth.ts`) and the API calls themselves (`evnex-client`'s `Evnex`, imported only by `src/lib/server/evnex-client.ts`). It signs in via SRP against the Evnex consumer Cloud API's Cognito user pool, matching the Evnex mobile app, and — once `EvnexAuth` is resumed from a stored refresh token via `evnex-token.ts`'s `sessionFor` — refreshes itself automatically (proactively before expiry, reactively on a 401, exactly one retry), publishing every new token to the `onTokenUpdate` callback before it's used for any request. This replaced a hand-rolled `amazon-cognito-identity-js` + `fetch` implementation; do **not** reintroduce a direct Cognito `InitiateAuth`/`USER_PASSWORD_AUTH` call to "simplify" this — the app client belongs to Evnex, not this project, and may not permit that flow.
- Deployment is a single Docker image (PUID/PGID-aware entrypoint at `docker/entrypoint.sh`) to Unraid — see `unraid/ev-charging-log.xml`. No docker-compose. The Evnex integration adds no deployment configuration: no environment variables, no `config.json` changes — it's signed into entirely through `/settings`, identically on every deployment including the Electron build.

## Browser testing

Playwright is a dev dependency (Chromium only) specifically so UI changes can be verified visually instead of reasoned about blind — this matters here because SMUI/MDC's CSS resets (`appearance: none`, `display: flex` on inputs, etc.) have caused real regressions that type-checking and unit tests can't catch. For any UI change, start the dev server, drive it with Playwright, and look at the screenshot before calling the work done:

```sh
npm run dev &
LANGUAGE=en_AU:en LC_ALL=C.utf8 LANG=C.utf8 node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--lang=en-GB'] });
  const page = await browser.newPage({ locale: 'en-GB' });
  await page.goto('http://localhost:5173/<route>');
  await page.waitForSelector('text=<something on the page>');
  await page.screenshot({ path: '/tmp/check.png' });
  await browser.close();
})();
"
```

Check both light and dark mode by passing `colorScheme: 'light' | 'dark'` to `browser.newPage()` / `browser.newContext()` — this app is dark-theme-first and several past bugs (e.g. native date/time picker icons) only showed up in one mode.

This app targets an Australian (day-first) user, so native `<input type="date">`/`<input type="time">` fields must be screenshotted with a day-first locale, not left at Playwright's default `en-US`. That default renders `MM/DD/YYYY` and is easy to mistake for an app bug when it's actually just the browser's own language setting — a page can't override this via its `lang` attribute or `Intl`/`document.documentElement.lang`; only the browser's own UI language controls it. No `en-AU` locale pack ships in the sandboxed Chromium build this environment uses (`ls $(dirname $(node -e "console.log(require('playwright').chromium.executablePath())"))/locales | grep ^en` to check what's available), so the recipe above substitutes `en-GB` (same day-first `DD/MM/YYYY` convention) — set via **both** the `LANGUAGE` env var (Chromium reads this for its locale pak on Linux; the sandboxed OS has no locale data installed beyond `C`/`C.utf8`/`POSIX`, so `LC_ALL`/`LANG` alone don't do it) and the `--lang` launch arg together — one without the other was not sufficient when this was verified.

## Privacy

This project handles real personal data (vehicle details, home address, charging history). The live SQLite db (`data/`), `.env`, and raw spreadsheets are gitignored and must never be committed. This matters more since the Evnex integration landed: `evnex_integration.refreshToken` is a genuine credential — it can mint fresh access tokens for as long as Cognito's pool allows, so it's as sensitive as the Evnex account password. It must never be logged, rendered, or returned by a `load` function; the Evnex password itself is used once at sign-in and never persisted at all. The DB also holds the car-odometer companion secret (`car_odometer_integration.secret`). It's low-sensitivity by comparison — it can only read odometer history — but the same rule applies: it's shown once when generated, then never logged, rendered, or returned by a `load` function (`/settings`' `load` returns only whether one exists).
