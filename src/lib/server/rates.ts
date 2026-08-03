import type { ratePlans } from './db/schema';

export type RatePlan = typeof ratePlans.$inferSelect;

export interface SessionForCost {
	date: string; // ISO date, "YYYY-MM-DD"
	time: string; // "HH:mm"
	kwhUsed: number;
}

/**
 * Picks the rate plan that applies to a given session date: the plan with the
 * latest `effectiveFrom` that is still <= the session date. Rate plans are
 * versioned this way so that historical sessions keep using the rate that was
 * actually in effect at the time, even after newer plans are added.
 *
 * Returns undefined if no plan has an effectiveFrom on or before the date
 * (e.g. the session predates any recorded rate plan).
 */
export function resolveRatePlan(date: string, plans: RatePlan[]): RatePlan | undefined {
	let best: RatePlan | undefined;

	for (const plan of plans) {
		if (plan.effectiveFrom > date) continue;
		if (!best || plan.effectiveFrom > best.effectiveFrom) {
			best = plan;
		}
	}

	return best;
}

/** Minutes since midnight for an "HH:mm" string. */
function toMinutes(time: string): number {
	const [h, m] = time.split(':').map(Number);
	return h * 60 + m;
}

/**
 * Whether `time` ("HH:mm") falls inside an off-peak window, which may cross
 * midnight (e.g. 22:00-07:00). A window is treated as [start, end) in the
 * same way regardless of whether it wraps: if start <= end it's a same-day
 * range; if start > end it wraps through midnight.
 */
function isInOffpeakWindow(time: string, window: { start: string; end: string }): boolean {
	const t = toMinutes(time);
	const start = toMinutes(window.start);
	const end = toMinutes(window.end);

	if (start === end) {
		// Degenerate window (covers the full 24h) - treat everything as off-peak.
		return true;
	}

	if (start < end) {
		return t >= start && t < end;
	}

	// Wraps midnight, e.g. 22:00-07:00.
	return t >= start || t < end;
}

function isOffpeak(time: string, windows: { start: string; end: string }[]): boolean {
	return windows.some((w) => isInOffpeakWindow(time, w));
}

/**
 * Computes the cost of a single charging session under a given rate plan.
 *
 * For `flat` plans this is simply kwhUsed * flatRate.
 *
 * For `peak_offpeak` plans: the schema only records a session *start* time,
 * not a duration or end time (charging_sessions.time is a single "HH:mm"
 * value), so there's no way to know how the session's energy was actually
 * distributed across a peak/off-peak boundary if charging happened to span
 * one. Rather than guessing a split, we bill the *entire* session's kWh at
 * whichever rate is in effect at the session's start time. This is a
 * reasonable approximation for home charging in particular: sessions are
 * typically kicked off once (e.g. plugging in overnight during an off-peak
 * window, or after arriving home during peak hours) and users would
 * generally log the start time as "when I plugged in", which is the most
 * meaningful single instant to price the session from. If finer-grained
 * (per-minute) splitting is ever needed, the schema would need to capture
 * session duration/end time first.
 */
export function calculateSessionCost(session: SessionForCost, plan: RatePlan): number {
	if (plan.type === 'flat') {
		if (plan.flatRate == null) {
			throw new Error(`Rate plan ${plan.id} is type 'flat' but has no flatRate set`);
		}
		return session.kwhUsed * plan.flatRate;
	}

	// peak_offpeak
	if (plan.peakRate == null || plan.offpeakRate == null) {
		throw new Error(
			`Rate plan ${plan.id} is type 'peak_offpeak' but is missing peak/offpeak rates`
		);
	}

	const windows = plan.offpeakWindows ?? [];
	const rate = isOffpeak(session.time, windows) ? plan.offpeakRate : plan.peakRate;

	return session.kwhUsed * rate;
}
