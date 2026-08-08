import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	fullName: text('full_name').notNull(),
	vehicleLabel: text('vehicle_label').notNull(), // rego or VIN, as printed on the report
	homeAddress: text('home_address') // pre-populates the Location field for home sessions
});

export const ratePlans = sqliteTable('rate_plans', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	effectiveFrom: text('effective_from').notNull(), // ISO date; this plan applies from this date onward
	type: text('type', { enum: ['flat', 'peak_offpeak'] }).notNull(),
	flatRate: real('flat_rate'), // $/kWh, set when type = 'flat'
	peakRate: real('peak_rate'), // $/kWh, set when type = 'peak_offpeak'
	offpeakRate: real('offpeak_rate'), // $/kWh, set when type = 'peak_offpeak'
	// JSON array of { start: "HH:mm", end: "HH:mm" } off-peak windows
	offpeakWindows: text('offpeak_windows', { mode: 'json' }).$type<
		{ start: string; end: string }[]
	>()
});

export const billingPeriods = sqliteTable('billing_periods', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	label: text('label').notNull(), // e.g. "July 2026"
	startDate: text('start_date').notNull(),
	endDate: text('end_date').notNull(),
	submittedAt: text('submitted_at') // set once the report has been generated/submitted
});

export const chargingSessions = sqliteTable('charging_sessions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	billingPeriodId: integer('billing_period_id').references(() => billingPeriods.id),
	kind: text('kind', { enum: ['home', 'public'] }).notNull(),
	date: text('date').notNull(),
	time: text('time').notNull(),
	// Null only on a session imported from the Evnex charger integration
	// (externalId set) — the charger has no way to know the odometer. Manual
	// creation still requires it; enforced in code, not a CHECK constraint.
	odometerKm: real('odometer_km'),
	// Null means the session is a draft: kWh isn't known until charging finishes,
	// so a session can be logged with just what's known when plugging in
	// (date/time/odometer/location) and completed later by filling this in.
	kwhUsed: real('kwh_used'),
	location: text('location').notNull(),
	cost: real('cost'), // computed at save time from the active rate plan (home sessions)
	notes: text('notes'),
	// Evnex session UUID (see foundational/EVNEX-INTEGRATION-PLAN.md §5.3). Null for
	// manually-logged sessions. Unique so a repeat poll can't double-insert if two
	// polls race. SQLite permits multiple NULLs in a UNIQUE index, so this is fine.
	externalId: text('external_id').unique()
});

// Single-row, same pattern as `settings`. Kept separate because `settings` is report
// identity (name, vehicle, address) and this is integration state with a very
// different lifecycle. See EVNEX-INTEGRATION-PLAN.md §5.1.
export const evnexIntegration = sqliteTable('evnex_integration', {
	id: integer('id').primaryKey({ autoIncrement: true }),

	// User-chosen, via /settings. The password is deliberately absent: it is used
	// once at sign-in and never persisted.
	email: text('email'), // shown in /settings so the user knows which account
	orgId: text('org_id'), // from GET /v2/apps/user, cached
	chargePointId: text('charge_point_id'), // UUID of the home charger
	chargePointName: text('charge_point_name'), // cached for display
	chargePointTimeZone: text('charge_point_time_zone'), // IANA, cached
	importLookbackDays: integer('import_lookback_days').notNull().default(3),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),

	// Generated at sign-in, never user-entered, never sent to the client. Cognito
	// token set. The refresh token is a real credential — it can mint access tokens
	// for as long as the pool allows, so it is as sensitive as the password and must
	// never be logged or rendered.
	accessToken: text('access_token'),
	accessTokenExpiresAt: text('access_token_expires_at'), // ISO datetime
	refreshToken: text('refresh_token'),

	// Last poll outcome, for the status line in /settings
	lastPolledAt: text('last_polled_at'),
	lastPollStatus: text('last_poll_status', {
		enum: ['ok', 'auth_failed', 'network_error', 'api_error']
	}),
	lastPollError: text('last_poll_error')
});

// A tombstone list of Evnex sessions that must never be (re-)imported. Without it,
// deleting an unwanted imported draft is futile: the next poll sees the same Evnex
// session still inside the lookback window and re-imports it. Deliberately has NO
// foreign key to charging_sessions.externalId — its entire purpose is to outlive the
// session row it describes, and an FK (especially ON DELETE CASCADE) would delete the
// tombstone at the exact moment it starts being needed. See EVNEX-INTEGRATION-PLAN.md
// §5.2.
export const evnexDismissedSessions = sqliteTable('evnex_dismissed_sessions', {
	externalId: text('external_id').primaryKey(),
	dismissedAt: text('dismissed_at').notNull(),
	// Why this session is tombstoned. Not load-bearing for the import decision —
	// presence in this table is enough — but it's the only way to answer "why does
	// this session never appear?" without guessing.
	reason: text('reason', { enum: ['user_deleted', 'invalid'] }).notNull()
});
