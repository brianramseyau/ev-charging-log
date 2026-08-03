// TODO: delete this file and import `resolveRatePlan` / `calculateSessionCost` from
// `$lib/server/rates` once that module lands on main (built on a sibling branch —
// see PLAN.md §8, "rates.ts — rate plan resolution + cost splitting logic").
//
// The two exports below match the real module's intended signatures, so swapping
// them in is a one-line import change in `src/routes/sessions/+page.server.ts`:
//
//   import { resolveRatePlan, calculateSessionCost } from '$lib/server/rates';
//
// The stub logic here is intentionally simple (no proportional peak/off-peak time
// splitting) — it exists only so home-session cost has *something* sane stored
// until the real rate engine is merged.

import type { ratePlans } from '$lib/server/db/schema';

export type RatePlan = typeof ratePlans.$inferSelect;

export interface SessionForCost {
	date: string;
	time: string;
	kwhUsed: number;
}

/**
 * Picks the rate plan in effect for a given date: the plan with the latest
 * `effectiveFrom` that is still `<= date`. Returns null if no plan applies yet.
 */
export function resolveRatePlan(date: string, plans: RatePlan[]): RatePlan | null {
	const applicable = plans
		.filter((plan) => plan.effectiveFrom <= date)
		.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
	return applicable[0] ?? null;
}

/**
 * Computes session cost from a resolved rate plan.
 *
 * Stub behavior: for `flat` plans, cost = kWh × flat rate. For `peak_offpeak`
 * plans, the real module will split the session's minutes across the
 * configured windows; this stub approximates by applying a single rate
 * (off-peak if set, otherwise peak) to the whole session.
 */
export function calculateSessionCost(
	session: SessionForCost,
	plan: RatePlan | null
): number | null {
	if (!plan) return null;

	if (plan.type === 'flat') {
		return plan.flatRate != null ? session.kwhUsed * plan.flatRate : null;
	}

	// peak_offpeak (approximated — see note above)
	const rate = plan.offpeakRate ?? plan.peakRate;
	return rate != null ? session.kwhUsed * rate : null;
}
