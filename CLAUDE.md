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
```

Migrations apply automatically on server boot (`src/hooks.server.ts` imports `$lib/server/db`, which runs `migrate()`), for both local dev and the Docker image. `db:push`/`db:migrate` exist but aren't part of the normal dev loop.

`src/lib/server/db/index.ts` disables SQLite foreign-key enforcement on the connection _before_ `migrate()` runs and restores it (after a `PRAGMA foreign_key_check`) once it completes. This matters because dropping a column's `NOT NULL` — or any other constraint change SQLite can't do in place — makes drizzle-kit emit a table rebuild (`CREATE __new_x` / `INSERT … SELECT` / `DROP x` / `RENAME`), and with foreign keys enforced (the better-sqlite3 default, unlike the sqlite3 CLI), that `DROP TABLE` cascades into any table referencing it and silently deletes rows the rebuild was meant to preserve. The `PRAGMA foreign_keys=OFF`/`=ON` pair drizzle-kit itself emits in the migration file is dead code here — it runs inside the migrator's `BEGIN`/`COMMIT` transaction, and the pragma is a no-op inside a transaction. Do not "clean up" the connection-level pragma calls in `db/index.ts` by assuming the in-file ones already cover it.

Requires `DATABASE_URL` in `.env` (copy from `.env.example`) — path to the SQLite file.

## Architecture

**No separate API/backend.** SvelteKit server routes (`+page.server.ts` load functions and form `actions`) talk directly to Drizzle/SQLite and pass data straight to Svelte pages — this is a deliberate decision (see PLAN.md), not an omission.

**Layering convention**, consistent across the `home`/`public` session domain:

- `src/lib/server/db/schema.ts` — Drizzle table definitions (source of truth for the data model: `settings`, `ratePlans`, `billingPeriods`, `chargingSessions`, `evnexIntegration`, `evnexDismissedSessions`).
- `src/lib/server/*.ts` (`sessions.ts`, `rates.ts`, `report.ts`, `import.ts`, `evnex.ts`) — pure, dependency-free calculation/parsing logic, deliberately kept free of DB imports so it's cheap to unit test. Each has a co-located `*.test.ts`.
- `src/lib/server/evnex-auth.ts`, `evnex-client.ts` — the Evnex integration's impure edges: Cognito auth and the `fetch` calls against the Evnex API, respectively. Not unit tested (network + SDK), unlike `evnex.ts`.
- `src/lib/server/evnex-token.ts` — a narrow, deliberate exception to the "only routes import `$lib/server/db`" rule below: shared access-token refresh/persist logic used by both `/settings` and the `/sessions` poll action, kept in one place so the terminal-refresh-failure handling can't drift between two copies.
- `src/routes/**/+page.server.ts` — the only other place that imports `$lib/server/db` and wires the pure helpers to Drizzle queries and form actions.
- `src/lib/dashboard.ts` — same pure-logic pattern, for the personal dashboard (not part of the lease report).

When changing business logic (cost calculation, billing-period assignment, efficiency, import parsing), the pure function in `src/lib/server/*.ts` is almost always the right place — keep DB access in the route's `+page.server.ts`.

### Key domain logic

- **Rate resolution** (`src/lib/server/rates.ts`): rate plans are versioned by `effectiveFrom` date. `resolveRatePlan` picks the plan with the latest `effectiveFrom` that's still `<=` the session date, so historical sessions keep the rate that was actually in effect. For `peak_offpeak` plans, the _entire_ session's kWh is billed at whichever rate applies at the session's start time (the schema has no session duration/end time, so there's no way to split a session that spans a peak/off-peak boundary — this is an intentional approximation, not a bug).
- **Billing period assignment** (`src/lib/server/sessions.ts`): a session is auto-assigned to the billing period whose `[startDate, endDate]` range contains its date, computed at session-create time.
- **Report export** (`src/lib/server/report.ts`): fills `static/templates/home-charging-template.xlsx` (generated by `scripts/generate-template.mjs`, mirrors the original lease-company spreadsheet layout) with a period's sessions and streams back the filled workbook. Row layout is rebuilt dynamically per period size — clears everything below the header block first since periods have varying session counts.
- **Historical import** (`src/lib/server/import.ts`): parses the legacy monthly spreadsheet by scanning for label/header text rather than assuming fixed row/column positions, since section locations vary file to file. Anything unparseable is collected into `issues` for a manual-review screen rather than thrown.
- **Evnex charger integration** (`src/lib/server/evnex.ts`, wired by `/sessions`' `?/pollEvnex` action): pulls recent home-charging sessions from the user's Evnex charger as drafts missing only the odometer. Dedupes on `charging_sessions.externalId` (the Evnex session UUID), since a poll can see the same session repeatedly. The Evnex sessions endpoint takes no date-range parameter, so `importLookbackDays` is enforced entirely client-side in `planImport`, not by the API. UTC timestamps are converted to the app's local `date`/`time` strings via `Intl.DateTimeFormat('en-AU', { hourCycle: 'h23' }).formatToParts()` — never `.format()` (day-first locale output) or `.toISOString().slice(0, 10)` (reads the UTC day, which can land on the wrong local day and therefore the wrong billing period/peak-offpeak rate). Energy is derived from the meter delta in watt-hours (`(transaction.meterStop - transaction.meterStart) / 1000`), never the Evnex-reported `totalEnergyUsage`/`totalCost` figures, since cost must always come from this app's own versioned rate plans. A session with `energyKwh === 0` (meter didn't move — plugged in and immediately stopped) is tombstoned in `evnex_dismissed_sessions` exactly like an `Invalid` `sessionStatus`, never imported as a draft; both are "not a real charge," not "still charging" (which is `energyKwh === null`). Requests to `client-api.evnex.io` send the **bare** access token as the `Authorization` header — no `Bearer ` prefix — which is the single most likely cause of an inexplicable 401 if "corrected" to look more standard. **This is an unofficial, undocumented API** (there is no published spec; the shapes in `evnex-client.ts` are taken from `foundational/EVNEX-INTEGRATION-PLAN.md` §4, sourced from the open-source `hardbyte/python-evnex` client) — it can change without notice, and every parse is defensive (skip a malformed item, never crash the whole poll) because of that.

### Stack specifics

- Svelte 5 in runes mode (forced project-wide via `vite.config.ts`, except `node_modules`).
- SMUI (Svelte Material UI) for components; theme SCSS lives in `src/theme/`, compiled to `static/smui/*.css` via `npm run theme:compile` (part of the `prepare`/`assets:generate` script, runs on `npm install`).
- Vitest is scoped to `src/**/*.{test,spec}.{js,ts}` (server-side pure logic only) — `.svelte.{test,spec}.ts` files are explicitly excluded from the configured test project.
- PWA via `@vite-pwa/sveltekit`.
- `amazon-cognito-identity-js` — used only by `src/lib/server/evnex-auth.ts`, to sign in via SRP (`authenticateUser`/`refreshSession`) against the Evnex consumer Cloud API's Cognito user pool, matching `python-evnex` and the Evnex mobile app. Nothing outside that one file should import it or otherwise know Cognito is involved. Do **not** "simplify" the auth flow to `USER_PASSWORD_AUTH` via a raw `InitiateAuth` call — the app client belongs to Evnex, not this project, and may not permit that flow; SRP is confirmed to work because it's what the mobile app itself uses.
- Deployment is a single Docker image (PUID/PGID-aware entrypoint at `docker/entrypoint.sh`) to Unraid — see `unraid/ev-charging-log.xml`. No docker-compose. The Evnex integration adds no deployment configuration: no environment variables, no `config.json` changes — it's signed into entirely through `/settings`, identically on every deployment including the Electron build.

## Browser testing

Playwright is a dev dependency (Chromium only) specifically so UI changes can be verified visually instead of reasoned about blind — this matters here because SMUI/MDC's CSS resets (`appearance: none`, `display: flex` on inputs, etc.) have caused real regressions that type-checking and unit tests can't catch. For any UI change, start the dev server, drive it with Playwright, and look at the screenshot before calling the work done:

```sh
npm run dev &
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/<route>');
  await page.waitForSelector('text=<something on the page>');
  await page.screenshot({ path: '/tmp/check.png' });
  await browser.close();
})();
"
```

Check both light and dark mode by passing `colorScheme: 'light' | 'dark'` to `browser.newPage()` / `browser.newContext()` — this app is dark-theme-first and several past bugs (e.g. native date/time picker icons) only showed up in one mode.

## Privacy

This project handles real personal data (vehicle details, home address, charging history). The live SQLite db (`data/`), `.env`, and raw spreadsheets are gitignored and must never be committed. This matters more since the Evnex integration landed: `evnex_integration.refreshToken` is a genuine credential — it can mint fresh access tokens for as long as Cognito's pool allows, so it's as sensitive as the Evnex account password. It must never be logged, rendered, or returned by a `load` function; the Evnex password itself is used once at sign-in and never persisted at all.
