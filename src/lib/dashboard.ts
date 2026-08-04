// Pure calculation helpers for the personal dashboard (PLAN.md §5.5).
//
// Kept framework/DB-free so the efficiency/aggregation math can be unit tested
// directly (see dashboard.test.ts) without touching SQLite. `+page.server.ts`
// loads rows from Drizzle, maps them to the plain shapes below, and calls these.

export type SessionKind = 'home' | 'public';

export interface DashboardSession {
	id: number;
	kind: SessionKind;
	date: string; // ISO date, "YYYY-MM-DD"
	time: string; // "HH:mm"
	odometerKm: number;
	kwhUsed: number;
	cost: number | null;
	billingPeriodId: number | null;
}

export interface DashboardPeriod {
	id: number;
	label: string;
	startDate: string;
	endDate: string;
}

export interface EfficiencyPoint {
	sessionId: number;
	date: string;
	kmPerKwh: number;
}

/** Stable chronological order: date, then time, then id as a final tiebreaker. */
function byDateTime(a: DashboardSession, b: DashboardSession): number {
	const aKey = `${a.date}T${a.time}`;
	const bKey = `${b.date}T${b.time}`;
	if (aKey !== bKey) return aKey < bKey ? -1 : 1;
	return a.id - b.id;
}

/**
 * km/kWh per home-charging session = (odometer at this session − odometer at the
 * immediately preceding session, of either kind, in chronological order) ÷ kWh
 * used at this session (PLAN.md §10). The very first session overall has no
 * predecessor to diff against and is skipped, and any session whose distance
 * or kWh can't produce a sane ratio (odometer went backwards, no kWh recorded)
 * is skipped rather than plotted as a misleading spike.
 */
export function computeEfficiencySeries(sessions: DashboardSession[]): EfficiencyPoint[] {
	const sorted = [...sessions].sort(byDateTime);
	const points: EfficiencyPoint[] = [];

	for (let i = 1; i < sorted.length; i++) {
		const current = sorted[i];
		if (current.kind !== 'home') continue;
		if (!(current.kwhUsed > 0)) continue;

		const previous = sorted[i - 1];
		const deltaKm = current.odometerKm - previous.odometerKm;
		if (!Number.isFinite(deltaKm) || deltaKm < 0) continue;

		const kmPerKwh = deltaKm / current.kwhUsed;
		if (!Number.isFinite(kmPerKwh)) continue;

		points.push({ sessionId: current.id, date: current.date, kmPerKwh });
	}

	return points;
}

export interface PeriodSplit {
	periodId: number;
	label: string;
	startDate: string;
	homeKwh: number;
	publicKwh: number;
	homeCost: number;
	homePct: number | null; // null when the period has no charging kWh at all
}

/** Per-billing-period totals, ordered by period start date, for the split & cost charts. */
export function computePeriodSplits(
	periods: DashboardPeriod[],
	sessions: DashboardSession[]
): PeriodSplit[] {
	const totals = new Map<number, { homeKwh: number; publicKwh: number; homeCost: number }>();

	for (const session of sessions) {
		if (session.billingPeriodId == null) continue;
		const entry = totals.get(session.billingPeriodId) ?? {
			homeKwh: 0,
			publicKwh: 0,
			homeCost: 0
		};
		if (session.kind === 'home') {
			entry.homeKwh += session.kwhUsed;
			entry.homeCost += session.cost ?? 0;
		} else {
			entry.publicKwh += session.kwhUsed;
		}
		totals.set(session.billingPeriodId, entry);
	}

	return [...periods]
		.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0))
		.map((period) => {
			const entry = totals.get(period.id) ?? { homeKwh: 0, publicKwh: 0, homeCost: 0 };
			const totalKwh = entry.homeKwh + entry.publicKwh;
			return {
				periodId: period.id,
				label: period.label,
				startDate: period.startDate,
				homeKwh: entry.homeKwh,
				publicKwh: entry.publicKwh,
				homeCost: entry.homeCost,
				homePct: totalKwh > 0 ? entry.homeKwh / totalKwh : null
			};
		});
}

/** NZ government mileage reimbursement rate, in dollars per km, for comparison against actual home-charging cost per km. */
export const GOVERNMENT_RATE_PER_KM = 0.0547;

export interface DashboardKpis {
	lifetimeHomeKwh: number;
	lifetimeCost: number;
	avgEfficiency: number | null;
	avgKwhPer100Km: number | null;
	avgCostPerKwh: number | null;
	avgCostPerKm: number | null;
	currentPeriod: { label: string; homePct: number | null } | null;
}

export function computeKpis(
	sessions: DashboardSession[],
	periods: DashboardPeriod[],
	efficiencySeries: EfficiencyPoint[]
): DashboardKpis {
	let lifetimeHomeKwh = 0;
	let lifetimeCost = 0;
	for (const session of sessions) {
		if (session.kind !== 'home') continue;
		lifetimeHomeKwh += session.kwhUsed;
		lifetimeCost += session.cost ?? 0;
	}

	const avgEfficiency =
		efficiencySeries.length > 0
			? efficiencySeries.reduce((sum, p) => sum + p.kmPerKwh, 0) / efficiencySeries.length
			: null;

	const avgKwhPer100Km = avgEfficiency != null && avgEfficiency > 0 ? 100 / avgEfficiency : null;

	const avgCostPerKwh = lifetimeHomeKwh > 0 ? lifetimeCost / lifetimeHomeKwh : null;
	const avgCostPerKm =
		avgCostPerKwh != null && avgEfficiency != null && avgEfficiency > 0
			? avgCostPerKwh / avgEfficiency
			: null;

	const mostRecent = [...periods].sort((a, b) =>
		a.endDate < b.endDate ? 1 : a.endDate > b.endDate ? -1 : 0
	)[0];

	let currentPeriod: DashboardKpis['currentPeriod'] = null;
	if (mostRecent) {
		const [split] = computePeriodSplits([mostRecent], sessions);
		currentPeriod = { label: split.label, homePct: split.homePct };
	}

	return {
		lifetimeHomeKwh,
		lifetimeCost,
		avgEfficiency,
		avgKwhPer100Km,
		avgCostPerKwh,
		avgCostPerKm,
		currentPeriod
	};
}
