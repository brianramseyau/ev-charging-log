// Pure helper logic for charging-session bookkeeping: odometer validation,
// billing-period auto-assignment, and km/kWh efficiency. Kept dependency-free
// (no db import) so it's cheap to unit test; `+page.server.ts` wires it to Drizzle.

export interface SessionDateTime {
	date: string; // ISO date, e.g. "2026-08-03"
	time: string; // "HH:mm"
}

export interface SessionRow extends SessionDateTime {
	id: number;
	odometerKm: number | null; // null for draft sessions where the charger hasn't reported an odometer reading yet
	kwhUsed: number | null; // null for draft sessions, whose kWh isn't known yet
}

export interface BillingPeriodRange {
	id: number;
	startDate: string;
	endDate: string;
}

export interface SubmittableBillingPeriod {
	label: string;
	submittedAt: string | null;
}

/**
 * True if a session belonging to this period should be blocked from being
 * added or deleted. `null` means the session isn't assigned to any period
 * (never blocked — nothing to have been submitted).
 */
export function isPeriodSubmitted(period: SubmittableBillingPeriod | null | undefined): boolean {
	return period?.submittedAt != null;
}

/** Sorts sessions chronologically (ascending) by date then time. */
export function sortByDateTimeAsc<T extends SessionDateTime>(rows: T[]): T[] {
	return [...rows].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/** Sorts sessions reverse-chronologically (descending) by date then time. */
export function sortByDateTimeDesc<T extends SessionDateTime>(rows: T[]): T[] {
	return sortByDateTimeAsc(rows).reverse();
}

/**
 * Odometer reading of the most recent session that actually has one, across
 * all sessions (any kind), skipping sessions with a null (not-yet-known)
 * odometer. Null if there are no sessions yet, or none of them have a
 * recorded odometer.
 */
export function mostRecentOdometer<T extends SessionRow>(rows: T[]): number | null {
	const desc = sortByDateTimeDesc(rows);
	for (const row of desc) {
		if (row.odometerKm != null) return row.odometerKm;
	}
	return null;
}

/**
 * True if `odometerKm` is lower than the most recent recorded odometer reading
 * (across all sessions) — a soft warning, not a hard validation failure, since
 * odometer entry typos or vehicle swaps shouldn't block logging a session.
 */
export function isOdometerBelowLastRecorded<T extends SessionRow>(
	odometerKm: number,
	existingSessions: T[]
): boolean {
	const last = mostRecentOdometer(existingSessions);
	return last != null && odometerKm < last;
}

/**
 * Finds the billing period whose date range contains `date`
 * (startDate <= date <= endDate). Returns null if none matches.
 * If ranges overlap (shouldn't normally happen), the first match wins.
 */
export function findBillingPeriodId(date: string, periods: BillingPeriodRange[]): number | null {
	const match = periods.find((period) => period.startDate <= date && date <= period.endDate);
	return match?.id ?? null;
}

/**
 * Attaches a km/kWh efficiency figure to each session: the distance travelled
 * since the previous session (by date/time order, any kind) divided by this
 * session's kWh used. Null for the first session, a draft session (no kWh
 * recorded yet), when kWh used is 0, or when either this session's or the
 * immediately-preceding session's odometer reading is null (not yet known —
 * e.g. an unresolved Evnex draft). A null odometer is never carried forward
 * from an earlier reading: doing so would attribute two intervals' distance
 * to one session's kWh and silently understate efficiency.
 *
 * Returns sessions in ascending chronological order.
 */
export function withEfficiency<T extends SessionRow>(
	rows: T[]
): (T & { efficiencyKmPerKwh: number | null })[] {
	const asc = sortByDateTimeAsc(rows);
	return asc.map((curr, i) => {
		const prev = asc[i - 1];
		const efficiencyKmPerKwh =
			prev &&
			curr.kwhUsed != null &&
			curr.kwhUsed > 0 &&
			curr.odometerKm != null &&
			prev.odometerKm != null
				? (curr.odometerKm - prev.odometerKm) / curr.kwhUsed
				: null;
		return { ...curr, efficiencyKmPerKwh };
	});
}

/**
 * True if any session in `sessions` belonging to billing period `periodId`
 * is still a draft (kWh not yet recorded — see SessionRow.kwhUsed). Used to
 * block submitting a period whose report would otherwise silently omit that
 * session's kWh/cost.
 */
export function hasUnresolvedDrafts<
	T extends { billingPeriodId: number | null; kwhUsed: number | null }
>(periodId: number, sessions: T[]): boolean {
	return sessions.some((s) => s.billingPeriodId === periodId && s.kwhUsed == null);
}
