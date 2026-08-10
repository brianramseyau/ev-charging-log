import { describe, expect, it } from 'vitest';
import {
	computeCurrentPeriodStats,
	computeEfficiencySeries,
	computeKpis,
	computePeriodSplits,
	excludeCurrentPeriod,
	findCurrentPeriod,
	type DashboardPeriod,
	type DashboardSession
} from './dashboard';

function period(overrides: Partial<DashboardPeriod> & { id: number }): DashboardPeriod {
	return {
		label: 'July 2026',
		startDate: '2026-07-01',
		endDate: '2026-07-31',
		submittedAt: null,
		...overrides
	};
}

function session(overrides: Partial<DashboardSession> & { id: number }): DashboardSession {
	return {
		kind: 'home',
		date: '2026-01-01',
		time: '08:00',
		odometerKm: 0,
		kwhUsed: 10,
		cost: null,
		billingPeriodId: null,
		...overrides
	};
}

describe('computeEfficiencySeries', () => {
	it('skips the very first session (no previous odometer to diff against)', () => {
		const sessions = [session({ id: 1, date: '2026-01-01', odometerKm: 100, kwhUsed: 10 })];
		expect(computeEfficiencySeries(sessions)).toEqual([]);
	});

	it('computes km/kWh as (this odometer - previous odometer) / this kWh', () => {
		const sessions = [
			session({ id: 1, date: '2026-01-01', odometerKm: 100, kwhUsed: 10 }),
			session({ id: 2, date: '2026-01-08', odometerKm: 400, kwhUsed: 30 })
		];
		const points = computeEfficiencySeries(sessions);
		expect(points).toEqual([{ sessionId: 2, date: '2026-01-08', kmPerKwh: 10 }]);
	});

	it('sorts by date/time before diffing, regardless of input order', () => {
		const sessions = [
			session({ id: 2, date: '2026-01-08', odometerKm: 400, kwhUsed: 30 }),
			session({ id: 1, date: '2026-01-01', odometerKm: 100, kwhUsed: 10 })
		];
		const points = computeEfficiencySeries(sessions);
		expect(points).toEqual([{ sessionId: 2, date: '2026-01-08', kmPerKwh: 10 }]);
	});

	it('does not compute a point for public-charging sessions', () => {
		const sessions = [
			session({ id: 1, date: '2026-01-01', odometerKm: 100, kwhUsed: 10 }),
			session({ id: 2, kind: 'public', date: '2026-01-05', odometerKm: 250, kwhUsed: 20 }),
			session({ id: 3, date: '2026-01-10', odometerKm: 550, kwhUsed: 30 })
		];
		const points = computeEfficiencySeries(sessions);
		// session 2 (public) contributes no point of its own, but still counts as the
		// "previous odometer" for session 3's diff.
		expect(points).toEqual([{ sessionId: 3, date: '2026-01-10', kmPerKwh: 10 }]);
	});

	it('skips a session with zero/negative distance instead of plotting a bogus ratio', () => {
		const sessions = [
			session({ id: 1, date: '2026-01-01', odometerKm: 500, kwhUsed: 10 }),
			session({ id: 2, date: '2026-01-08', odometerKm: 480, kwhUsed: 10 }) // odometer went backwards
		];
		expect(computeEfficiencySeries(sessions)).toEqual([]);
	});

	it('skips a session with no kWh recorded', () => {
		const sessions = [
			session({ id: 1, date: '2026-01-01', odometerKm: 100, kwhUsed: 10 }),
			session({ id: 2, date: '2026-01-08', odometerKm: 400, kwhUsed: 0 })
		];
		expect(computeEfficiencySeries(sessions)).toEqual([]);
	});

	it('skips a session with a null odometer, or whose predecessor has a null odometer, instead of crashing or producing NaN', () => {
		const sessions = [
			session({ id: 1, date: '2026-01-01', odometerKm: 100, kwhUsed: 10 }),
			session({ id: 2, date: '2026-01-05', odometerKm: null, kwhUsed: 20 }), // draft, odometer not yet known
			session({ id: 3, date: '2026-01-10', odometerKm: 550, kwhUsed: 30 })
		];
		const points = computeEfficiencySeries(sessions);
		// session 2 produces no point (its own odometer is null), and session 3
		// produces no point either since its predecessor's odometer is null —
		// it is not carried forward from session 1.
		expect(points).toEqual([]);
	});
});

describe('computePeriodSplits', () => {
	const periods: DashboardPeriod[] = [
		period({ id: 1, label: 'July 2026', startDate: '2026-07-01', endDate: '2026-07-31' }),
		period({ id: 2, label: 'June 2026', startDate: '2026-06-01', endDate: '2026-06-30' })
	];

	it('sums home/public kWh and home cost per period, ordered by start date', () => {
		const sessions: DashboardSession[] = [
			session({ id: 1, billingPeriodId: 2, kind: 'home', kwhUsed: 10, cost: 2.5 }),
			session({ id: 2, billingPeriodId: 2, kind: 'public', kwhUsed: 5, cost: null }),
			session({ id: 3, billingPeriodId: 1, kind: 'home', kwhUsed: 20, cost: 5 }),
			session({ id: 4, billingPeriodId: 1, kind: 'home', kwhUsed: 8, cost: 2 })
		];

		const splits = computePeriodSplits(periods, sessions);

		expect(splits.map((s) => s.label)).toEqual(['June 2026', 'July 2026']);
		expect(splits[0]).toMatchObject({ homeKwh: 10, publicKwh: 5, homeCost: 2.5, homePct: 10 / 15 });
		expect(splits[1]).toMatchObject({ homeKwh: 28, publicKwh: 0, homeCost: 7 });
	});

	it('reports homePct as null for a period with no assigned sessions', () => {
		const splits = computePeriodSplits(periods, []);
		expect(splits.every((s) => s.homePct === null)).toBe(true);
		expect(splits.every((s) => s.homeKwh === 0 && s.publicKwh === 0 && s.homeCost === 0)).toBe(
			true
		);
	});

	it('ignores sessions with no billing period assigned', () => {
		const sessions: DashboardSession[] = [
			session({ id: 1, billingPeriodId: null, kind: 'home', kwhUsed: 999 })
		];
		const splits = computePeriodSplits(periods, sessions);
		expect(splits.every((s) => s.homeKwh === 0)).toBe(true);
	});
});

describe('computeKpis', () => {
	it('returns zeros/nulls gracefully on an empty dataset', () => {
		const kpis = computeKpis([], []);
		expect(kpis).toEqual({
			lifetimeHomeKwh: 0,
			lifetimeCost: 0,
			avgEfficiency: null,
			avgKwhPer100Km: null,
			avgCostPerKwh: null,
			avgCostPerKm: null
		});
	});

	it('sums lifetime home kWh/cost (ignoring public), averages efficiency, and derives cost per kWh/km', () => {
		const sessions: DashboardSession[] = [
			session({ id: 1, kind: 'home', kwhUsed: 10, cost: 3 }),
			session({ id: 2, kind: 'public', kwhUsed: 100, cost: null }),
			session({ id: 3, kind: 'home', kwhUsed: 20, cost: 6 })
		];
		const efficiencySeries = [
			{ sessionId: 1, date: '2026-01-01', kmPerKwh: 8 },
			{ sessionId: 3, date: '2026-01-08', kmPerKwh: 12 }
		];
		const kpis = computeKpis(sessions, efficiencySeries);
		expect(kpis.lifetimeHomeKwh).toBe(30);
		expect(kpis.lifetimeCost).toBe(9);
		expect(kpis.avgEfficiency).toBe(10);
		expect(kpis.avgKwhPer100Km).toBe(10);
		expect(kpis.avgCostPerKwh).toBe(0.3);
		expect(kpis.avgCostPerKm).toBeCloseTo(0.03);
	});
});

describe('findCurrentPeriod', () => {
	it('returns null when there are no periods', () => {
		expect(findCurrentPeriod([])).toBeNull();
	});

	it('returns null once every period has been submitted', () => {
		const periods: DashboardPeriod[] = [
			period({ id: 1, startDate: '2026-06-01', submittedAt: '2026-08-01T00:00:00.000Z' }),
			period({ id: 2, startDate: '2026-07-01', submittedAt: '2026-08-02T00:00:00.000Z' })
		];
		expect(findCurrentPeriod(periods)).toBeNull();
	});

	it('picks the unsubmitted period with the latest start date', () => {
		const periods: DashboardPeriod[] = [
			period({ id: 1, startDate: '2026-06-01', submittedAt: '2026-07-01T00:00:00.000Z' }),
			period({ id: 2, startDate: '2026-07-01', submittedAt: null })
		];
		expect(findCurrentPeriod(periods)?.id).toBe(2);
	});

	it('ignores submitted periods even if they start later than the current one', () => {
		const periods: DashboardPeriod[] = [
			period({ id: 1, startDate: '2026-07-01', submittedAt: null }),
			period({ id: 2, startDate: '2026-08-01', submittedAt: '2026-08-15T00:00:00.000Z' })
		];
		expect(findCurrentPeriod(periods)?.id).toBe(1);
	});
});

describe('excludeCurrentPeriod', () => {
	const periods: DashboardPeriod[] = [
		period({ id: 1, label: 'June 2026', submittedAt: '2026-07-01T00:00:00.000Z' }),
		period({ id: 2, label: 'July 2026', submittedAt: null })
	];
	const sessions: DashboardSession[] = [
		session({ id: 1, billingPeriodId: 1 }),
		session({ id: 2, billingPeriodId: 2 })
	];

	it('drops the current period and its sessions', () => {
		const current = findCurrentPeriod(periods);
		const { historicalPeriods, historicalSessions } = excludeCurrentPeriod(
			periods,
			sessions,
			current
		);
		expect(historicalPeriods.map((p) => p.id)).toEqual([1]);
		expect(historicalSessions.map((s) => s.id)).toEqual([1]);
	});

	it('returns everything unchanged when there is no current period', () => {
		const { historicalPeriods, historicalSessions } = excludeCurrentPeriod(periods, sessions, null);
		expect(historicalPeriods).toEqual(periods);
		expect(historicalSessions).toEqual(sessions);
	});
});

describe('computeCurrentPeriodStats', () => {
	it('returns null when there is no current period', () => {
		expect(computeCurrentPeriodStats(null, [], [])).toBeNull();
	});

	it('summarizes home/public kWh, cost, and % home for just the current period', () => {
		const current = period({ id: 2, label: 'July 2026' });
		const sessions: DashboardSession[] = [
			session({ id: 1, billingPeriodId: 2, kind: 'home', kwhUsed: 30, cost: 9 }),
			session({ id: 2, billingPeriodId: 2, kind: 'public', kwhUsed: 10, cost: null }),
			session({ id: 3, billingPeriodId: 1, kind: 'home', kwhUsed: 999, cost: 999 }) // other period, ignored
		];
		const stats = computeCurrentPeriodStats(current, sessions, []);
		expect(stats).toMatchObject({
			label: 'July 2026',
			homeKwh: 30,
			publicKwh: 10,
			homeCost: 9,
			homePct: 0.75
		});
	});

	it('averages efficiency points belonging only to the current period', () => {
		const current = period({ id: 2, label: 'July 2026' });
		const sessions: DashboardSession[] = [
			session({ id: 1, billingPeriodId: 1, kind: 'home' }),
			session({ id: 2, billingPeriodId: 2, kind: 'home' })
		];
		const efficiencySeries = [
			{ sessionId: 1, date: '2026-06-15', kmPerKwh: 4 }, // previous period, excluded
			{ sessionId: 2, date: '2026-07-15', kmPerKwh: 8 }
		];
		const stats = computeCurrentPeriodStats(current, sessions, efficiencySeries);
		expect(stats?.avgEfficiency).toBe(8);
		expect(stats?.avgKwhPer100Km).toBe(12.5);
	});
});
