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
	notes: text('notes')
});
