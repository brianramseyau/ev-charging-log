# Evnex Integration — Design & Implementation Plan

Status: **scoped, API contract confirmed, not yet started**
Branch: `claude/evnex-integration-plan-tu7pxt`

Extends [PLAN.md](PLAN.md) §4 (data model) and the "Ongoing: Enhancements"
list — see [§13](#13-documentation-to-update) for the exact edits owed once this
lands.

---

## 1. Why

Home charging sessions are currently typed in by hand at the charger: date,
time, odometer, kWh, location. The charger already knows four of those five
things. The Evnex platform exposes them over an HTTP API, so the manual step
that remains — and the only one the charger genuinely cannot know — is the
odometer reading.

The goal is therefore **not** "replace manual logging". It is: pull what the
charger knows into draft sessions, and leave the user to add the odometer.

## 2. Decisions taken up front

These were settled before drafting and are not open for re-litigation by the
implementing agent:

| #   | Decision                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Odometer becomes nullable, but only the Evnex flow may omit it.** Manual session creation still requires it. A session missing an odometer is an incomplete draft: it cannot be exported, and it blocks period submission — same treatment as a session missing kWh.                                    |
| 2   | **Polling writes draft sessions straight to the database**, keyed by the Evnex session ID. A later poll finds the same ID and fills in kWh once charging has finished. It does not pre-fill the Add form.                                                                                                 |
| 3   | **Credentials are OAuth2 client-credentials, not a user login.** A client ID/secret pair (Evnex **Enterprise** account, found under "My Organisation" in CP-Link) is entered in `/settings` and exchanged for a 24-hour access token, which is persisted in the database and re-minted on expiry. See §4. |
| 4   | **Written against today's architecture** — `+page.server.ts` loads and form actions, pure logic in `src/lib/server/`. See [§11](#11-relationship-to-offline-modeplanmd) for what changes if the offline-mode refactor lands first. The two plans are independent and may be built in either order.        |

## 3. What the user does, end to end

1. Opens `/settings`, finds a new **Evnex integration** heading below the
   existing name/vehicle card.
2. Pastes a client ID and client secret, taps **Test connection**. The app
   authenticates, lists the charge points on the account, and the user picks
   theirs.
3. Optionally adjusts **Import sessions from the last N days** (default 3).
4. Saves. The integration is now configured.
5. On `/sessions`, a **Pull from charger** button is now enabled. Tapping it
   imports recent sessions as drafts.
6. Each imported draft shows in the history list with a **From charger** badge
   and an **Add odometer** field. Filling it in completes the session.

---

## 4. API contract

Confirmed against the Evnex reference documentation (`Authorization`,
`GetChargePoint`, `ListChargePointSessions`). Full index at
`https://docs.evnex.com/llms.txt`.

### 4.1 Two hosts

Authentication and the API live on **different hosts** — a detail easy to miss
and productive of confusing 404s:

|                | Host                    |
| -------------- | ----------------------- |
| Token endpoint | `https://auth.evnex.io` |
| API            | `https://api.evnex.io`  |

### 4.2 Getting a token

```
POST https://auth.evnex.io/oauth2/token
Authorization: Basic <base64("clientId:clientSecret")>
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

```json
{ "access_token": "…", "expires_in": 86400, "token_type": "Bearer" }
```

Standard OAuth2 client-credentials with HTTP Basic client authentication.
Base64 the `clientId:clientSecret` pair with `Buffer.from(…).toString('base64')`
— no `openssl` shelling out, and note the docs' `echo -n` (no trailing newline).

There is **no refresh token**, by design: the client credentials themselves are
durable, so re-authentication is simply repeating this exchange. Consequently
there is no "reconnect" flow to build and nothing expires from the user's point
of view.

### 4.3 Using the token — the `Bearer` trap

> Requests to `api.evnex.io` send the **bare token**:
> `Authorization: <access_token>` — **not** `Authorization: Bearer <token>`,
> despite the token response saying `"token_type": "Bearer"`.

This is what the documented examples show, and it matches the OpenAPI
`securitySchemes` entry declaring `ClientAuthorization` as `type: apiKey` in
the `Authorization` header rather than `type: http, scheme: bearer`. Sending
the conventional `Bearer ` prefix is the single most likely cause of an
otherwise-inexplicable 401. Assert this in a comment at the call site.

Tokens last **24 hours** (`expires_in: 86400`). An invalid or expired token
returns **401 Unauthorized**.

### 4.4 Endpoints used

| Purpose            | Request                                                   |
| ------------------ | --------------------------------------------------------- |
| List charge points | `GET /v1/charge-points/`                                  |
| Get charge point   | `GET /v1/charge-points/{id}`                              |
| List sessions      | `GET /v1/charge-points/{id}/sessions?from=<ISO>&to=<ISO>` |

`from` and `to` are both **required** on the sessions call — there is no
"everything since" form, so the window in §6.2 is mandatory, not merely
prudent. The documentation defines **no pagination parameters and no pagination
envelope**: the response is a flat `{ data: [...] }`. A tight window is
therefore the only bound on response size.

Errors are `{ errors: [{ status, title, code?, detail?, meta: { correlationId } }] }`.
Log `correlationId` when surfacing an error — it is what Evnex support will ask
for.

### 4.5 Charge point response

`{ data: { id, type: "chargePoints", attributes: { … } } }`, where `attributes`
carries `name`, `timeZone` (IANA, e.g. `Pacific/Auckland`), `serial`, `model`,
`networkStatus`, `connectors[]`.

`attributes.timeZone` is load-bearing — see §6.3.

### 4.6 Session response — energy is not a field

`{ data: [ { id, type: "sessions", attributes: { … }, relationships: { … } } ] }`.

The `attributes` fields that matter:

| Field                                                                 | Notes                                                                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startDate`                                                           | date-time, **required**. The session start — what the app stores as `date`/`time`.                                                                                                                 |
| `endDate`                                                             | date-time, optional. Absent while in progress.                                                                                                                                                     |
| `sessionStatus`                                                       | **required**. `Pending \| Authorized \| Active \| Closed \| Completed \| Invalid`. The schema states: _"A session is considered to be in-progress unless its status is 'Completed' or 'Invalid'"_. |
| `transaction.meterStart`                                              | **Wh**, required.                                                                                                                                                                                  |
| `transaction.meterStop`                                               | **Wh**, optional — absent until charging finishes.                                                                                                                                                 |
| `totalPowerUsage`                                                     | **Deprecated. Do not use.**                                                                                                                                                                        |
| `totalCost`                                                           | Evnex's own cost figure. **Deliberately ignored** — see below.                                                                                                                                     |
| `totalDuration`, `totalCarbonUsage`, `token`, `connectorId`, `evseId` | Not used.                                                                                                                                                                                          |

> **There is no supported kWh field.** The only non-deprecated energy figure is
> the meter delta, in watt-hours:
>
> ```
> kWh = (transaction.meterStop − transaction.meterStart) / 1000
> ```
>
> `meterStop` being absent _is_ the "still charging" signal, and is what makes
> the deferred-kWh design in §6.5 necessary rather than merely tidy.

`totalCost` is ignored on purpose. The lease report must price electricity
using this app's own versioned rate plans (`resolveRatePlan`), which encode
what the user actually pays and change over time; Evnex's figure comes from
whatever tariff is configured on the charger and would silently diverge.

### 4.7 Do not copy `-k` from the docs

The documented `curl` examples pass `-k`, which disables TLS certificate
verification. That is a convenience in a copy-paste example and must not be
carried into the implementation — `fetch` verifies by default and should be
left alone.

---

## 5. Data model

### 5.1 New table: `evnex_integration`

Single-row, same pattern as `settings`. Kept separate from `settings` because
`settings` is report identity (name, vehicle, address) and this is integration
state with a very different lifecycle.

```ts
export const evnexIntegration = sqliteTable('evnex_integration', {
	id: integer('id').primaryKey({ autoIncrement: true }),

	// User-entered, via /settings
	clientId: text('client_id'),
	clientSecret: text('client_secret'),
	chargePointId: text('charge_point_id'), // UUID of the home charger
	chargePointName: text('charge_point_name'), // cached for display
	chargePointTimeZone: text('charge_point_time_zone'), // IANA, cached; see §6.3
	importLookbackDays: integer('import_lookback_days').notNull().default(3),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),

	// Generated — never user-entered, never sent to the client.
	// 24-hour token from auth.evnex.io (§4.2); expiry is computed at mint time
	// as now + expires_in, since the response carries a duration, not a date.
	accessToken: text('access_token'),
	accessTokenExpiresAt: text('access_token_expires_at'), // ISO datetime

	// Last poll outcome, for the status line in /settings
	lastPolledAt: text('last_polled_at'),
	lastPollStatus: text('last_poll_status', {
		enum: ['ok', 'auth_failed', 'network_error', 'api_error']
	}),
	lastPollError: text('last_poll_error')
});
```

### 5.2 New table: `evnex_dismissed_sessions`

A tombstone list. Without it, deleting an unwanted imported draft is futile:
the next poll sees the same Evnex session still inside the lookback window and
re-imports it. This is not a hypothetical — it fires the first time a user
deletes a draft.

```ts
export const evnexDismissedSessions = sqliteTable('evnex_dismissed_sessions', {
	externalId: text('external_id').primaryKey(),
	dismissedAt: text('dismissed_at').notNull()
});
```

The existing `?/delete` action on `/sessions` writes a row here whenever the
deleted session has a non-null `externalId`.

### 5.3 Changes to `charging_sessions`

```ts
	// Evnex session UUID. Null for manually-logged sessions. Unique, so a
	// repeat poll cannot double-insert even if two polls race.
	externalId: text('external_id').unique(),

	// Was notNull. The charger does not know the odometer, so a session
	// imported from Evnex starts without one. Null is only ever valid on a
	// session that has an externalId — enforced in code (§5.4), since the
	// manual create path still requires a reading.
	odometerKm: real('odometer_km'),
```

SQLite permits multiple `NULL`s in a `UNIQUE` index, so every manually-logged
session having `external_id IS NULL` is fine and does not collide.

### 5.4 The odometer invariant

> A `charging_sessions` row may have `odometer_km IS NULL` **only if**
> `external_id IS NOT NULL`.

Not expressed as a SQL `CHECK` constraint (Drizzle migrations for SQLite would
need a table rebuild, and the app is the only writer). Enforced instead at the
two write paths:

- `?/create` on `/sessions` — validation unchanged, odometer still required.
- the Evnex import — the only producer of null-odometer rows.

### 5.5 Migration — foreign keys must be off during the table rebuild

One migration via `npm run db:generate`, applied on boot by `hooks.server.ts`.

SQLite cannot drop a column's `NOT NULL` in place, so removing it from
`odometer_km` makes drizzle-kit emit a **table rebuild**: create `__new_…`,
`INSERT … SELECT`, `DROP TABLE`, `RENAME`. There is direct precedent in this
repo — `drizzle/0002_worthless_harpoon.sql` rebuilds this exact table the exact
same way.

**The `DROP TABLE` step is the dangerous one.** With foreign key enforcement
on, dropping a table performs an implicit `DELETE FROM` for FK purposes, which
cascades into any table referencing it. Rows the rebuild was meant to preserve
are silently destroyed — no error, no rollback.

#### The pragma drizzle-kit emits does not work

`0002` opens with `PRAGMA foreign_keys=OFF;` and closes with `…=ON;`, which
looks like the problem is already handled. It is not, for two reasons that
compound:

1. **better-sqlite3 enables foreign keys by default** — a fresh connection
   reports `foreign_keys = 1`, unlike the sqlite3 CLI's default of off.
2. **`PRAGMA foreign_keys` is a no-op inside a transaction**, and drizzle's
   migrator wraps each migration in one — it issues `BEGIN` and then runs the
   file's statements inside it (`drizzle-orm/sqlite-core/dialect.cjs`, the
   `migrate` path). The pragma executes, returns success, and changes nothing.

So the emitted pragma is dead code, and `0002` already rebuilt
`charging_sessions` with enforcement live. That did no damage only because
nothing currently references `charging_sessions` — the FK on that table points
outward, to `billing_periods`. It is luck, not design, and this plan is exactly
the change that starts adding tables around it.

#### The fix: disable it on the connection, before `migrate()`

In `src/lib/server/db/index.ts`, outside any transaction:

```ts
const client = new Database(env.DATABASE_URL);

// SQLite implements column-constraint changes as a table rebuild
// (CREATE __new_x / INSERT SELECT / DROP x / RENAME). With foreign keys
// enforced — which better-sqlite3 does by default — the DROP cascades into any
// table referencing x and silently deletes rows the rebuild meant to preserve.
//
// drizzle-kit does emit `PRAGMA foreign_keys=OFF` around those blocks, but its
// migrator runs each migration inside BEGIN/COMMIT and the pragma is a no-op
// within a transaction. Setting it out here, before migrate() opens one, is
// what actually takes effect.
client.pragma('foreign_keys = OFF');

export const db = drizzle(client, { schema });

migrate(db, { migrationsFolder: env.MIGRATIONS_FOLDER || 'drizzle' });

// Step 10 of SQLite's documented table-rebuild procedure: confirm the rebuild
// left nothing dangling before enforcement is restored for the app's queries.
const violations = client.pragma('foreign_key_check') as unknown[];
if (violations.length > 0) {
	throw new Error(
		`Migration left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`
	);
}

client.pragma('foreign_keys = ON');
```

Failing loudly on `foreign_key_check` is the point: a corrupted relational
state that boots successfully is far worse than one that refuses to.

This edit belongs in **phase 1**, landing with the odometer migration and
before any new table exists, so every later rebuild inherits the protection.

#### `evnex_dismissed_sessions` deliberately has no foreign key

The tombstone table (§5.2) intentionally does **not** reference
`charging_sessions.external_id`. Its entire purpose is to outlive the session
row it describes — an FK, especially one with `ON DELETE CASCADE`, would delete
the tombstone at the exact moment it starts being needed, and would resurrect
the dismissed session on the next poll. Do not add one.

Regardless, the generated SQL must be **read before committing**, to confirm
the `INSERT … SELECT` carries every column and existing rows survive the copy.

---

## 6. Import logic

### 6.1 Layering

Per the convention in CLAUDE.md, split three ways:

| File                                  | Responsibility                                                                                                                                  | Tested                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `src/lib/server/evnex.ts`             | **Pure.** Window arithmetic, timezone conversion, payload → draft mapping, insert/update/skip planning, token expiry. No `fetch`, no db import. | Vitest, `evnex.test.ts`                                 |
| `src/lib/server/evnex-client.ts`      | The only place that calls `fetch`. Auth exchange, charge-point fetch, session listing, pagination, error mapping.                               | Not unit tested (the Vitest project is pure logic only) |
| `src/routes/sessions/+page.server.ts` | New `?/pollEvnex` action wiring db + client + pure logic.                                                                                       | Playwright                                              |

### 6.2 The lookback window

`importLookbackDays` (default 3) bounds every poll to sessions that started
within the last N days. Its purpose is duplicate suppression, and it works on
two fronts beyond the `externalId` key:

- A first poll on an account with years of history does not import years of
  sessions the user already logged by hand.
- A dismissed session (§5.2) stops being considered at all once it ages out,
  so the tombstone table stays small.

**Known limitation, accept and document:** a session still missing its kWh when
it ages out of the window will never be updated by a later poll, and has to be
completed by hand. Evnex sessions finish within hours, so a 3-day window is
ample; the setting exists for anyone who wants more slack.

The window is also the _only_ bound on response size, since the sessions
endpoint has no pagination and requires both `from` and `to` (§4.4).

```ts
/**
 * The [from, to] instants for a poll. `from` is `now − lookbackDays`,
 * as an instant rather than a local midnight — "the last 3 days" is both
 * simpler to reason about and immune to DST edges.
 */
export function importWindow(now: Date, lookbackDays: number): { from: string; to: string }; // ISO date-times, for the query string
```

`planImport` re-checks the window client-side even though the API already
filters. It is two lines, it makes the pure function total, and it means the
`outside_window` skip reason is exercised by tests rather than only in
production.

### 6.3 Timezone conversion — do not skip this

Evnex returns timestamps as `date-time` (UTC). The app stores a local `date`
(`YYYY-MM-DD`) and `time` (`HH:mm`) as separate strings. Converting with
`toISOString().slice(0, 10)` is **wrong** and will silently corrupt data: an
Australian evening session lands on the previous day, which can put it in the
wrong billing period and resolve the wrong peak/off-peak rate.

Convert using the charge point's `attributes.timeZone` (§4.1) via
`Intl.DateTimeFormat` with `timeZone` and `en-CA` (which formats as
`YYYY-MM-DD`). No new dependency. The timezone is cached on the integration row
at setup time and refreshed on each poll's charge-point fetch.

The session's `date`/`time` come from the **start** timestamp — matching the
manual flow, where the user logs the session when plugging in.

### 6.4 Mapping a session

`evnex-client.ts` normalises the wire format into a flat shape first, so the
pure logic never handles the `{ id, attributes: { transaction: … } }` nesting
or the watt-hours arithmetic:

```ts
export interface EvnexSessionPayload {
	id: string; // data[].id — the UUID stored as externalId
	startDate: string; // attributes.startDate, ISO UTC
	sessionStatus: EvnexSessionStatus; // attributes.sessionStatus, §4.6
	/**
	 * Derived by evnex-client.ts as
	 * (transaction.meterStop − transaction.meterStart) / 1000 — see §4.6.
	 * Null when meterStop is absent, i.e. charging has not finished.
	 */
	energyKwh: number | null;
}

export type EvnexSessionStatus =
	'Pending' | 'Authorized' | 'Active' | 'Closed' | 'Completed' | 'Invalid';

export interface DraftFromEvnex {
	externalId: string;
	kind: 'home';
	date: string; // local, from startDate
	time: string; // local, from startDate
	odometerKm: null;
	kwhUsed: number | null; // null while charging is still in progress
	location: string;
	notes: null;
}

export function toDraftSession(
	payload: EvnexSessionPayload,
	opts: { timeZone: string; location: string }
): DraftFromEvnex;
```

`kind` is always `'home'` — the integration is for the user's own charger.
`location` is `settings.homeAddress` when set, falling back to the charge
point's `name`.

### 6.5 Planning a poll

One pure function decides everything, so the outcome is fully unit-testable
without a database:

```ts
export function planImport(
	remote: EvnexSessionPayload[],
	existing: {
		id: number;
		externalId: string | null;
		kwhUsed: number | null;
		billingPeriodId: number | null;
	}[],
	dismissed: string[],
	opts: { windowStart: string; timeZone: string; location: string; submittedPeriodIds: number[] }
): {
	insert: DraftFromEvnex[];
	update: { id: number; kwhUsed: number }[];
	skipped: { externalId: string; reason: SkipReason }[];
};

type SkipReason =
	| 'invalid'
	| 'outside_window'
	| 'dismissed'
	| 'already_complete'
	| 'still_charging'
	| 'period_submitted';
```

Rules, in order:

1. `sessionStatus === 'Invalid'` → `invalid`. Never import; an Invalid session
   did not deliver energy and must not reach a lease report.
2. Outside the lookback window → `outside_window`.
3. `externalId` in `dismissed` → `dismissed`.
4. No existing row with this `externalId` → **insert** as a draft, whether or
   not charging has finished. An in-progress session is inserted with
   `kwhUsed: null`; a later poll fills it in.
5. Existing row, `kwhUsed` already set → `already_complete`. Never overwrite a
   value the user may have corrected by hand.
6. Existing row, `kwhUsed` null, `energyKwh` still null → `still_charging`.
7. Existing row, `kwhUsed` null, `energyKwh` present → **update**.
8. Any insert or update whose billing period is already submitted →
   `period_submitted`, consistent with the existing guards in `?/complete` and
   `?/delete`.

**Trust `energyKwh`, not `sessionStatus`, for kWh.** The two are related but
not equivalent: `sessionStatus` describes the session's lifecycle while the
meter delta describes whether an energy figure actually exists. A `Closed`
session may still be missing `meterStop`, and rule 7 keying off `energyKwh`
handles that without enumerating which statuses do or do not carry a meter
reading. `sessionStatus` is used only for rule 1.

An `energyKwh` of `0` — plugged in, no energy drawn — is falsy in JavaScript
and will be silently treated as "still charging" by a careless `if (energyKwh)`.
Use explicit `!= null` checks. Whether a genuine 0 kWh session should be
imported at all is §12.5.

### 6.6 Wiring in `?/pollEvnex`

The action, in order:

1. Load the integration row; `fail(400)` if not configured (§7.3).
2. Ensure a valid token — reuse `accessToken` when
   `!isTokenExpired(accessTokenExpiresAt, new Date())` (60s clock skew),
   otherwise mint a new one (§4.2) and persist it with
   `expiresAt = now + expires_in`.
3. `GET /v1/charge-points/{id}` — refresh cached name and timezone.
4. `GET /v1/charge-points/{id}/sessions?from=…&to=…` for the §6.2 window.

   **Any 401 on steps 3–4 triggers exactly one re-auth and retry.** A token can
   be revoked or invalidated before its nominal 24 hours are up, so expiry
   arithmetic alone is not sufficient. One retry, then fail — never a loop.

5. Load existing sessions, dismissed IDs, and billing periods from the db.
6. Call `planImport`.
7. For each **insert**: assign a billing period with the existing
   `findBillingPeriodId`, and insert. Cost stays null — there is no kWh yet,
   and no odometer.
8. For each **update**: set `kwhUsed`, and recompute `cost` with the existing
   `resolveRatePlan` + `calculateSessionCost`, exactly as `?/complete` does.
   The session remains a draft until its odometer is filled in.
9. Record `lastPolledAt` / `lastPollStatus` / `lastPollError`.
10. Return `{ inserted, updated, skipped }` counts for the UI summary.

Steps 7 and 8 reuse the existing helpers rather than reimplementing them — a
session imported today and completed later must resolve against the rate plan
in effect on _its own_ date, which `resolveRatePlan` already guarantees.

---

## 7. UI

### 7.1 `/settings` — new "Evnex integration" heading

A second `<Card>` below the existing one, with its own `?/saveEvnex` action.

| Field                         | Control                                    | Notes                                                                 |
| ----------------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| Client ID                     | `Textfield`                                |                                                                       |
| Client secret                 | `Textfield` `type="password"`              | Write-only, see below                                                 |
| Charge point                  | `Select`                                   | Populated from `GET /v1/charge-points/` by **Test connection** (§4.4) |
| Import sessions from the last | `Textfield` `type="number"`, suffix "days" | Default 3, min 1                                                      |
| Enabled                       | `Switch`                                   | Gates the poll button                                                 |

Plus a **Test connection** button and a status line: _"Connected to
'Home charger' · last polled 2 hours ago"_, or the last error.

**The client secret must never be sent to the browser.** `settings`'
`load` currently returns the whole row; the Evnex row needs a redacted
projection — return `hasClientSecret: boolean`, not the value. The field shows
a `••••••••` placeholder with a **Replace** affordance, and an empty submitted
secret means "leave unchanged" rather than "clear it".

### 7.2 `/sessions` — the poll button

A **Pull from charger** button (`mdiCloudDownloadOutline`, following the
existing `Icon.svelte` + `@mdi/js` pattern) in the sessions history header,
posting to `?/pollEvnex` with `use:enhance`.

- **Configured and enabled** → active. Shows a spinner and "Pulling…" while in
  flight.
- **Not configured** → rendered disabled, with helper text linking to
  `/settings`. Disabled-and-explained beats hidden: a user who set it up on
  another device needs to see why it is not working.

On success, a summary: _"Imported 2 drafts, updated 1, skipped 3 already
imported."_ Skips are aggregated by reason rather than listed per session.

### 7.3 Draft rows

Today a draft is a session with `kwhUsed == null` and the row offers an
**Add kWh** field. That generalises: a draft is a session missing kWh **or**
odometer, and the row offers whichever fields are missing.

- `?/complete` accepts both `kwhUsed` and `odometerKm`, requiring only the ones
  actually missing. A session leaves draft state when both are set.
- Imported sessions get a **From charger** badge alongside the existing
  **Draft** badge.
- The existing `isOdometerBelowLastRecorded` soft warning applies when the
  odometer is added.

---

## 8. Ripple from a nullable odometer

`odometerKm` is non-null in five modules today. Every one needs revisiting —
this is the largest single chunk of work in the plan and is why §10 puts it in
its own phase.

| File                                        | Change                                                                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/server/sessions.ts`                | `SessionRow.odometerKm` → `number \| null`. `mostRecentOdometer` returns the most recent **non-null** reading. `withEfficiency`: efficiency is null when either this session's or the immediately-preceding session's odometer is null. |
| `src/lib/dashboard.ts`                      | Same rule for cost-per-km and km/kWh; sessions with a null odometer are excluded from distance maths.                                                                                                                                   |
| `src/lib/server/report.ts`                  | Type as `number \| null`; write a blank cell defensively. In practice never reached — §8.1 blocks the export first.                                                                                                                     |
| `src/routes/periods/[id]/+page.server.ts`   | `draftSessions` is currently `kwhUsed == null`; becomes `kwhUsed == null \|\| odometerKm == null`. The `?/submit` guard message extends to name whichever is missing.                                                                   |
| `src/routes/periods/[id]/export/+server.ts` | The `completedSessions` filter gains the same odometer condition.                                                                                                                                                                       |
| `src/routes/sessions/+page.server.ts`       | `?/create` unchanged (odometer still required). `?/complete` extended per §7.3. `?/delete` writes a tombstone per §5.2.                                                                                                                 |

### 8.1 Why not skip the efficiency changes

It is tempting to treat null odometers as "just a display concern". They are
not: `withEfficiency` subtracts consecutive odometer readings, so a single null
in the middle of the chain produces `NaN` for the following session, which
propagates into the dashboard KPIs. The rule in the table above — null if
_either_ endpoint is null — is the honest one. Carrying the previous reading
forward instead would attribute two intervals' distance to one session's kWh
and silently understate efficiency.

---

## 9. Testing

**Vitest** — `src/lib/server/evnex.test.ts`, pure logic only, per the
configured test project:

- `importWindow` across month, year and DST boundaries.
- `toDraftSession` timezone conversion: a UTC timestamp that falls on the
  previous local day, and one that falls on the next — the §6.3 bug class,
  asserted directly.
- `planImport` for each of the eight rules in §6.5, including the
  never-overwrite-a-completed-session case, the `Invalid` skip, and the
  submitted-period skip.
- **`energyKwh === 0` is treated as present, not as still-charging** — the
  falsy trap in §6.5, which a naive implementation passes every other test
  while failing.
- The Wh → kWh conversion, including a session whose `meterStop` is absent.
- `isTokenExpired` including the clock-skew margin.
- The existing `sessions.test.ts`, `dashboard.test.ts` and `report.test.ts`
  must be **extended** with null-odometer cases, not just kept passing — they
  are the regression net for §8.

**Playwright**, per the browser-testing requirement in CLAUDE.md, in **both
light and dark**:

- `/settings` with the new heading — SMUI `Select` and `Switch` are new
  controls on this page and MDC's resets have caused real regressions here
  before.
- `/sessions` poll button in both disabled (unconfigured) and enabled states.
- A draft row showing both **Add kWh** and **Add odometer**.

The Evnex API itself is not contacted in tests; `evnex-client.ts` is stubbed.

**Migration safety**, once per schema-changing phase — this is not covered by
either suite above and has to be done deliberately:

- Copy a database that has real rows in it, run the migration against the copy,
  and confirm the row count and column values survive.
- Confirm `PRAGMA foreign_keys` reports `0` at the moment `migrate()` runs and
  `1` once boot completes — the §5.5 fix is invisible when it works and silent
  when it does not, so assert it rather than assuming it.

---

## 10. Phasing

Each phase lands green (`npm run check`, `npm run lint`, `npm run test`).

| #   | Phase                                                                  | Notes                                                                                                            |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Nullable odometer + the §8 ripple + the §5.5 foreign-key fix           | No Evnex code at all. Largest phase; ships a coherent "drafts can be missing an odometer" capability on its own. |
| 2   | Schema: `evnex_integration`, `evnex_dismissed_sessions`, `external_id` | Migration only, plus the tombstone write in `?/delete`.                                                          |
| 3   | `evnex.ts` pure logic + full Vitest suite                              | No network, no UI.                                                                                               |
| 4   | `evnex-client.ts` + `/settings` section + Test connection              | First real API contact. Verify §4.3 (bare token, no `Bearer`) against the live API before building on it.        |
| 5   | Poll button + `?/pollEvnex`                                            | The payoff.                                                                                                      |
| 6   | Playwright verification + §13 documentation updates                    |                                                                                                                  |

No phase is blocked on outstanding questions; the API contract in §4 is
confirmed. Phase 4 is the first to need real credentials.

---

## 11. Relationship to OFFLINE-MODE-PLAN.md

[OFFLINE-MODE-PLAN.md](OFFLINE-MODE-PLAN.md) is agreed but not started, and
would move every route to `/api/*` endpoints with `ssr = false`. The two plans
do not conflict and may land in either order. If offline mode lands first:

- `?/pollEvnex` becomes `POST /api/evnex/poll`; `?/saveEvnex` becomes part of
  the settings endpoint. The pure logic in `evnex.ts` is unaffected.
- Polling requires network by definition, so the poll button should key off
  that plan's reachability probe (`GET /api/ping`) rather than
  `navigator.onLine`, and disable itself when unreachable.
- Imported drafts are server-side writes and never enter the offline outbox.
  Completing one — adding the odometer — is an ordinary session mutation and
  queues like any other.

---

## 12. Open decisions

| #   | Question                                                                                                                                                                                  | Default if unanswered                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Automatic background polling on app load, in addition to the button?                                                                                                                      | Manual button only, as specified. Worth revisiting once the failure modes are understood in practice.                                                                                                                                                                                                                                                                                                                          |
| 2   | A `source` column (`manual` / `evnex` / `import`) instead of deriving provenance from `externalId != null`?                                                                               | Derive from `externalId`. Add the column if a second integration ever appears.                                                                                                                                                                                                                                                                                                                                                 |
| 3   | Client secret is stored in plaintext in SQLite. The Evnex docs warn these credentials are "highly sensitive" and grant read — and in some cases write — access to the whole organisation. | Accepted: single-user self-hosted app, the database is gitignored and never leaves the host, and the existing data (home address, vehicle, charging history) is comparably sensitive. Supporting an `EVNEX_CLIENT_SECRET` env-var override instead of the database column is a cheap hardening step if the app is ever hosted less privately. **The secret must never be logged, echoed to the browser (§7.1), or committed.** |
| 4   | Multiple charge points on one account?                                                                                                                                                    | One charge point, chosen at setup. The schema change to support several is a table, not a column, so this is deliberately deferred rather than designed around.                                                                                                                                                                                                                                                                |
| 5   | Should a genuine 0 kWh session (plugged in, no energy drawn) be imported at all?                                                                                                          | Import it as a normal session. It is real, it costs $0, and suppressing it would mean the poll silently disagrees with the charger's own history. Revisit if these turn out to be common noise.                                                                                                                                                                                                                                |
| 6   | This needs an Evnex **Enterprise** account — the client ID/secret live under "My Organisation" in CP-Link.                                                                                | Confirm the account tier before starting phase 4. Phases 1–3 are useful regardless, but the feature is dead without API access, and that is worth knowing early.                                                                                                                                                                                                                                                               |

---

## 13. Documentation to update

Owed once this lands:

- **CLAUDE.md** — add an Evnex bullet to "Key domain logic": the `externalId`
  dedupe key, the lookback window, the timezone rule in §6.3, the Wh → kWh
  meter-delta derivation (§4.6), and the bare-token header (§4.3). Note
  `evnex.ts` / `evnex-client.ts` in the layering convention.
- **CLAUDE.md "Privacy"** — the database now holds API credentials.
- **CLAUDE.md "Commands"** — the migrations-on-boot paragraph should record
  that foreign keys are disabled around `migrate()` and restored afterwards,
  and why (§5.5). Anyone who later "tidies up" that pragma would reintroduce
  silent data loss on the next table rebuild.
- **PLAN.md §4** — the data model gains two tables and two columns; the
  odometer is no longer mandatory.
- **PLAN.md "Ongoing: Enhancements"** — add the Evnex integration entry.
