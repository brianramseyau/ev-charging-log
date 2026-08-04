// Pure helper logic for charging-session bookkeeping: odometer validation,
// billing-period auto-assignment, and km/kWh efficiency. Kept dependency-free
// (no db import) so it's cheap to unit test; `+page.server.ts` wires it to Drizzle.

export interface SessionDateTime {
	date: string; // ISO date, e.g. "2026-08-03"
	time: string; // "HH:mm"
}

export interface SessionRow extends SessionDateTime {
	id: number;
	odometerKm: number;
	kwhUsed: number;
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
 * Odometer reading of the most recent session across all sessions (any kind),
 * or null if there are no sessions yet.
 */
export function mostRecentOdometer<T extends SessionRow>(rows: T[]): number | null {
	const desc = sortByDateTimeDesc(rows);
	return desc[0]?.odometerKm ?? null;
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
 * session's kWh used. Null for the first session, or when kWh used is 0.
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
			prev && curr.kwhUsed > 0 ? (curr.odometerKm - prev.odometerKm) / curr.kwhUsed : null;
		return { ...curr, efficiencyKmPerKwh };
	});
}
