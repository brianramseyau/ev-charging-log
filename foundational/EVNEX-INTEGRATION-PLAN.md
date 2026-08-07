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

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Odometer becomes nullable, but only the Evnex flow may omit it.** Manual session creation still requires it. A session missing an odometer is an incomplete draft: it cannot be exported, and it blocks period submission — same treatment as a session missing kWh.                                                                                                                          |
| 2   | **Polling writes draft sessions straight to the database**, keyed by the Evnex session ID. A later poll finds the same ID and fills in kWh once charging has finished. It does not pre-fill the Add form.                                                                                                                                                                                       |
| 3   | **Credentials are OAuth2 client-credentials, supplied by environment.** `EVNEX_CLIENT_ID` and `EVNEX_CLIENT_SECRET` (Evnex **Enterprise** account, found under "My Organisation" in CP-Link) are read from the environment and never stored in the database or entered in the UI. They are exchanged for a 24-hour access token, which _is_ persisted and re-minted on expiry. See §4 and §5.6. |
| 4   | **Written against today's architecture** — `+page.server.ts` loads and form actions, pure logic in `src/lib/server/`. See [§11](#11-relationship-to-offline-modeplanmd) for what changes if the offline-mode refactor lands first. The two plans are independent and may be built in either order.                                                                                              |

## 3. What the user does, end to end

1. Sets `EVNEX_CLIENT_ID` and `EVNEX_CLIENT_SECRET` in the environment — `.env`
   locally, the Unraid template's variable fields in production (§5.6) — and
   restarts the app.
2. Opens `/settings`, finds a new **Evnex integration** heading below the
   existing name/vehicle card, showing **Credentials found in environment**.
3. Taps **Test connection**. The app authenticates, lists the charge points on
   the account, and the user picks theirs.
4. Optionally adjusts **Import sessions from the last N days** (default 3),
   switches the integration on, and saves.
5. On `/sessions`, a **Pull from charger** button is now enabled. Tapping it
   imports recent sessions as drafts.
6. Each imported draft shows in the history list with a green
   **Home - Imported** chip (§7.4) and an **Add odometer** field. Filling it in
   completes the session.

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

	// User-entered, via /settings. Credentials are deliberately absent — they
	// come from the environment (§5.6) and are never written to the database.
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
	// SHA-256 of EVNEX_CLIENT_ID, so a credential rotation can be detected and
	// the stale token discarded (§6.6). A hash, not the value — this table must
	// never hold anything that identifies the account.
	credentialFingerprint: text('credential_fingerprint'),

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

### 5.6 Configuration: credentials come from the environment

```sh
EVNEX_CLIENT_ID=…
EVNEX_CLIENT_SECRET=…
```

Both use the `EVNEX_` prefix. Neither is written to the database, rendered in
any page, or entered through the UI, which means the secret never reaches a
database backup and `/settings` has nothing to redact.

Read them through `$env/dynamic/private`, matching `DATABASE_URL` in
`src/lib/server/db/index.ts`. **Dynamic, not static** — the Docker image is
built once and configured at run time, so a build-time binding would freeze
whatever was set in the builder. Being dynamic also means the Dockerfile needs
no placeholder value the way `DATABASE_URL` needs one at line 15.

Absent or blank credentials are a normal, expected state, not an error: the
integration is simply unconfigured and the poll button stays disabled (§7.2).
Do not throw at boot the way `DATABASE_URL` does — an unset Evnex variable must
never stop the app from starting.

#### Surfaces to update

| File                         | Change                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.example`               | Document both, commented out, following the existing optional-variable style used for `NOMINATIM_BASE_URL`.                                                                                                                  |
| `Dockerfile`                 | Nothing. Do not add `ENV EVNEX_CLIENT_SECRET=` — an image must never carry a default credential, and dynamic env needs no build-time placeholder.                                                                            |
| `docker/entrypoint.sh`       | Nothing. It `exec`s the app, so the environment passes through.                                                                                                                                                              |
| `unraid/ev-charging-log.xml` | Two `<Config … Type="Variable">` entries alongside the existing `PUID`/`PGID`, `Required="false"`. Set **`Mask="true"`** on the secret so Unraid renders it as a password field instead of plain text on the container page. |

#### The Electron build has no obvious place for these

PLAN.md §11 packages the app for desktop, where a user cannot readily set
environment variables. PLAN.md §11.5 already solved the equivalent problem for
the database path with a `config.json` in the app's `userData` directory, and
the same mechanism is the natural home for these two values.

Until that is done, the integration is simply unavailable in the desktop build
— which is acceptable, since polling a home charger is home-wifi work that the
server deployment covers. Flagging it so it is a recorded gap rather than a
surprise bug report.

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

Convert using the charge point's `attributes.timeZone` (§4.5) via
`Intl.DateTimeFormat` with `en-AU`, matching the app's Australian audience. No
new dependency. The timezone is cached on the integration row at setup time and
refreshed on each poll's charge-point fetch.

**Build the strings from `formatToParts`, never from `.format()`.** `en-AU`
formats day-first — `format()` on that same timestamp yields `07/08/2026`,
which is neither the storage format nor unambiguously parseable. Only the
_parts_ are locale-stable:

```ts
const parts = Object.fromEntries(
	new Intl.DateTimeFormat('en-AU', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23' // explicit: en-AU is 12-hour by default
	})
		.formatToParts(new Date(startDate))
		.map((p) => [p.type, p.value])
);

const date = `${parts.year}-${parts.month}-${parts.day}`; // YYYY-MM-DD
const time = `${parts.hour}:${parts.minute}`; // HH:mm
```

Assembling explicitly is the point. A shorter version of this exists — `en-CA`
happens to `format()` straight to `YYYY-MM-DD` — but it relies on a locale
coincidence, reads as a typo to the next person, and silently produces a
day-first string if anyone "corrects" the locale to the `en-AU` used everywhere
else. Assembling from parts states the intended format in the code.

Note `hourCycle: 'h23'`: `en-AU` defaults to 12-hour, so without it a 00:30
session returns `hour: "12"` plus a separate `dayPeriod: "am"` part. Ignoring
`dayPeriod` — as the assembly above does — would store that as `12:30` and put
a midnight charge in the middle of the day, resolving the wrong off-peak rate.

The session's `date`/`time` come from the **start** timestamp — matching the
manual flow, where the user logs the session when plugging in.

The app has no established locale convention to follow — the only other
`Intl.DateTimeFormat` call (`src/routes/import/+page.server.ts:36`) passes
`en-US`, but only to render a month-name billing period label like
`"July 2026"`, where the locale makes no visible difference. It is not a
precedent for date storage, and does not need changing.

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
imported at all is §12.4.

### 6.6 Wiring in `?/pollEvnex`

The action, in order:

1. Read `EVNEX_CLIENT_ID` / `EVNEX_CLIENT_SECRET` (§5.6) and load the
   integration row. `fail(400)` if either credential is missing, the charge
   point is unset, or the integration is switched off — with a message naming
   which, since the two failures have completely different fixes.
2. Ensure a valid token — reuse `accessToken` when
   `!isTokenExpired(accessTokenExpiresAt, new Date())` (60s clock skew),
   otherwise mint a new one (§4.2) and persist it with
   `expiresAt = now + expires_in`.

   **Clear the stored token if the credentials change.** A token minted from a
   rotated client secret stays nominally valid for 24 hours, so after a
   credential swap the app would keep using the old one until it expired. Store
   a hash of the client ID alongside the token and discard the token when it no
   longer matches — never store the credentials themselves to compare.

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

Credentials are **not** on this page — they come from the environment (§5.6).
What remains is the genuinely user-chosen configuration:

| Field                         | Control                                    | Notes                                                                 |
| ----------------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| Charge point                  | `Select`                                   | Populated from `GET /v1/charge-points/` by **Test connection** (§4.4) |
| Import sessions from the last | `Textfield` `type="number"`, suffix "days" | Default 3, min 1                                                      |
| Enabled                       | `Switch`                                   | Gates the poll button                                                 |

Above them, a read-only credential status derived from whether both environment
variables are non-empty:

- **Credentials found in environment** — proceed to **Test connection**.
- **No credentials configured** — name `EVNEX_CLIENT_ID` and
  `EVNEX_CLIENT_SECRET` and say they are set in the environment and need a
  restart. Someone hitting this has no other way to discover what is wrong, so
  the message must be specific rather than a generic "not configured".

Plus a **Test connection** button and a status line: _"Connected to
'Home charger' · last polled 2 hours ago"_, or the last error.

**Send booleans, never values.** `load` may return `hasCredentials: boolean`
and must not return the client ID or secret — not even the ID, and not even
partially masked. The env-var design removes the write-only-field problem
entirely; the remaining risk is re-introducing it by "helpfully" displaying
which client ID is in use.

The same applies to `lastPollError` (§5.1): it is rendered on this page, so
whatever `evnex-client.ts` puts there must be a summarised message plus the
Evnex `correlationId`, never a raw request echo that could contain the
`Authorization` header.

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
- The existing `isOdometerBelowLastRecorded` soft warning applies when the
  odometer is added.
- Provenance is shown by the chip in §7.4.

### 7.4 The "Home - Imported" chip

Imported rows must be visually distinguishable from hand-logged ones at a
glance. The existing row markup (`sessions/+page.svelte:272`) renders a kind
badge and, when incomplete, a draft badge:

```svelte
<span class="badge" class:badge--home={session.kind === 'home'}>
	{session.kind === 'home' ? 'Home' : 'Public'}
</span>
{#if session.kwhUsed == null}
	<span class="badge badge--draft">Draft</span>
{/if}
```

**Replace the kind badge for imported rows rather than adding a third one.**
Every imported session is `kind: 'home'` (§6.4), so a separate provenance badge
would render `HOME` `IMPORTED` `DRAFT` — three uppercase pills competing for
space on a mobile-first row. One chip reading **`HOME - IMPORTED`** carries both
facts:

```svelte
<span
	class="badge"
	class:badge--home={session.kind === 'home' && session.externalId == null}
	class:badge--imported={session.externalId != null}
>
	{session.externalId != null ? 'Home - Imported' : session.kind === 'home' ? 'Home' : 'Public'}
</span>
```

`session.externalId != null` is the provenance test, per §12.2. The `load` in
`sessions/+page.server.ts` must therefore include `externalId` in the row
projection.

#### Colour

Green, for the Evnex brand, added as a token alongside the existing two in
`src/routes/+layout.svelte:67-68` so it follows the established convention
rather than hardcoding:

```css
--charge-home-color: #3987e5;
--charge-public-color: #d95926;
--charge-imported-color: #15803d; /* Evnex green — see the contrast note */
```

The badge then reuses the existing `color-mix` treatment verbatim:

```css
.badge--imported {
	background: color-mix(in srgb, var(--charge-imported-color) 15%, white);
	color: var(--charge-imported-color);
}

/* in the existing prefers-color-scheme: dark block */
.badge--imported {
	background: color-mix(in srgb, var(--charge-imported-color) 25%, black);
	color: #fff;
}
```

> **Do not substitute a bright or lime green.** Light mode puts the colour
> itself on a 15%-on-white tint of the same colour, which bright greens fail
> badly. Measured against that exact treatment, with the shipped home blue as
> the baseline:
>
> | Colour              | Light      | Dark    |
> | ------------------- | ---------- | ------- |
> | `#3987e5` home blue | 3.07:1     | 16.10:1 |
> | `#d95926` public    | 3.22:1     | 16.42:1 |
> | `#15803d` deep      | **4.09:1** | 17.21:1 |
> | `#4caf50` grass     | 2.42:1     | 15.06:1 |
> | `#7ac943` lime      | **1.84:1** | 13.77:1 |
> | `#4ade80` mint      | **1.59:1** | 13.10:1 |
>
> A lime chip would be roughly half as legible as everything already shipping.
> Dark mode is unaffected — white on a 25%-on-black tint clears 13:1 for any of
> them — so this is a light-mode constraint only.

I could not confirm Evnex's exact brand hex (their documentation host is
blocked by this environment's egress policy, §4 note). `#15803d` is a
placeholder chosen to satisfy the constraint above. If the real brand green is
a brighter lime, keep it for the **dark-mode** tint and as an accent, and use a
darkened variant for the light-mode foreground — do not use one bright value
for both.

Two smaller notes:

- `HOME - IMPORTED` is roughly twice the width of `HOME`, and `.badge` is
  uppercase at `font-weight: 700`. Check it does not push the date/time or the
  delete button onto a second line at 320px.
- The offline-mode plan proposes green `#4ade80` for its app-bar cloud
  indicator. Different surface, and the two are never adjacent, but it is worth
  knowing green will then carry two unrelated meanings in the app.

---

## 8. Ripple from a nullable odometer

`odometerKm` is non-null across the app today. Every reader needs revisiting —
this is the largest single chunk of work in the plan and is why §10 puts it in
its own phase.

| File                                        | Change                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/server/sessions.ts`                | `SessionRow.odometerKm` → `number \| null`. `mostRecentOdometer` returns the most recent **non-null** reading. `withEfficiency`: efficiency is null when either this session's or the immediately-preceding session's odometer is null.                                                                                                    |
| `src/lib/dashboard.ts`                      | Same rule for cost-per-km and km/kWh; sessions with a null odometer are excluded from distance maths.                                                                                                                                                                                                                                      |
| `src/lib/server/report.ts`                  | Type as `number \| null`; write a blank cell defensively. In practice never reached — §8.1 blocks the export first.                                                                                                                                                                                                                        |
| `src/routes/periods/[id]/+page.server.ts`   | `draftSessions` is currently `kwhUsed == null`; becomes `kwhUsed == null \|\| odometerKm == null`. The completed `homeSessions`/`publicSessions` filters must take the exact inverse — a session with kWh but no odometer currently lands in the completed lists. The `?/submit` guard message extends to name whichever field is missing. |
| `src/routes/periods/[id]/+page.svelte`      | Lines 143 and 181 render `s.odometerKm.toLocaleString()` unguarded. These are the completed home/public lists, so they are safe **only** if the filter above is fixed in the same change. Add a conditional render anyway — the crash is silent until a real null reaches it.                                                              |
| `src/routes/periods/[id]/export/+server.ts` | The `completedSessions` filter gains the same odometer condition.                                                                                                                                                                                                                                                                          |
| `src/routes/sessions/+page.server.ts`       | `?/create` unchanged (odometer still required). `?/complete` extended per §7.3. `?/delete` writes a tombstone per §5.2. `load` must project `externalId` for the §7.4 chip.                                                                                                                                                                |
| `src/routes/sessions/+page.svelte`          | **Throws today.** Line 289 renders `{session.odometerKm.toLocaleString()} km` unguarded — a null odometer is a `TypeError` that blanks the whole history list, not a cosmetic gap. Render the km figure conditionally, as the kWh figure two lines below it already is.                                                                    |

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
- `toDraftSession` output **format**, not just its value: assert `date` matches
  `YYYY-MM-DD` and `time` matches `HH:mm`. A day-first `en-AU` regression
  produces a plausible-looking `07/08/2026` that every value-only assertion
  waves through.
- A 00:30 local session stores `time` as `00:30`, not `12:30` — the
  `hourCycle` trap in §6.3.
- A session during an Australian DST transition, since `importWindow` works in
  instants while `date`/`time` are local.
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
- The §7.4 chip: a manual row and an imported row **in the same screenshot**,
  so the colours are compared side by side rather than across two images. The
  whole point of the chip is telling them apart at a glance, and light mode is
  where the green is at risk.
- A history list containing a null-odometer row, confirming it renders rather
  than throwing (§8) — this is the failure that blanks the entire list.

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

| #   | Phase                                                                            | Notes                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Nullable odometer + the §8 ripple + the §5.5 foreign-key fix                     | No Evnex code at all. Largest phase; ships a coherent "drafts can be missing an odometer" capability on its own.                                                                                                             |
| 2   | Schema: `evnex_integration`, `evnex_dismissed_sessions`, `external_id`           | Migration only, plus the tombstone write in `?/delete`.                                                                                                                                                                      |
| 3   | `evnex.ts` pure logic + full Vitest suite                                        | No network, no UI.                                                                                                                                                                                                           |
| 4   | `evnex-client.ts` + §5.6 config surfaces + `/settings` section + Test connection | First real API contact. Verify §4.3 (bare token, no `Bearer`) against the live API before building on it. Land `.env.example` and the Unraid variables here, not in phase 6 — the feature cannot be configured without them. |
| 5   | Poll button + `?/pollEvnex`                                                      | The payoff.                                                                                                                                                                                                                  |
| 6   | Playwright verification + §13 documentation updates                              |                                                                                                                                                                                                                              |

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

| #   | Question                                                                                                    | Default if unanswered                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Automatic background polling on app load, in addition to the button?                                        | Manual button only, as specified. Worth revisiting once the failure modes are understood in practice.                                                                                           |
| 2   | A `source` column (`manual` / `evnex` / `import`) instead of deriving provenance from `externalId != null`? | Derive from `externalId`. Add the column if a second integration ever appears.                                                                                                                  |
| 3   | Multiple charge points on one account?                                                                      | One charge point, chosen at setup. The schema change to support several is a table, not a column, so this is deliberately deferred rather than designed around.                                 |
| 4   | Should a genuine 0 kWh session (plugged in, no energy drawn) be imported at all?                            | Import it as a normal session. It is real, it costs $0, and suppressing it would mean the poll silently disagrees with the charger's own history. Revisit if these turn out to be common noise. |
| 5   | This needs an Evnex **Enterprise** account — the client ID/secret live under "My Organisation" in CP-Link.  | Confirm the account tier before starting phase 4. Phases 1–3 are useful regardless, but the feature is dead without API access, and that is worth knowing early.                                |

**Resolved:** credential storage. Earlier drafts stored the client secret in
SQLite. It now comes from the environment (§5.6) and is never persisted, so the
plaintext-at-rest question no longer arises.

---

## 13. Documentation to update

Owed once this lands:

- **CLAUDE.md** — add an Evnex bullet to "Key domain logic": the `externalId`
  dedupe key, the lookback window, the timezone rule in §6.3, the Wh → kWh
  meter-delta derivation (§4.6), and the bare-token header (§4.3). Note
  `evnex.ts` / `evnex-client.ts` in the layering convention.
- **CLAUDE.md "Privacy"** — note that Evnex credentials live in `.env`
  (already gitignored) and deliberately never reach the database, so a copy of
  the SQLite file carries no API access.
- **`.env.example`** — document `EVNEX_CLIENT_ID` and `EVNEX_CLIENT_SECRET`,
  commented out, per §5.6.
- **`unraid/ev-charging-log.xml`** — two `Type="Variable"` entries, the secret
  with `Mask="true"`.
- **README.md** — whatever setup section covers `DATABASE_URL` should mention
  these, including that they require an Evnex Enterprise account (§12.5).
- **CLAUDE.md "Commands"** — the migrations-on-boot paragraph should record
  that foreign keys are disabled around `migrate()` and restored afterwards,
  and why (§5.5). Anyone who later "tidies up" that pragma would reintroduce
  silent data loss on the next table rebuild.
- **PLAN.md §4** — the data model gains two tables and two columns; the
  odometer is no longer mandatory.
- **PLAN.md "Ongoing: Enhancements"** — add the Evnex integration entry.
