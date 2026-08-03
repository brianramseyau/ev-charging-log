import { describe, expect, it } from 'vitest';
import {
	computeEfficiencySeries,
	computeKpis,
	computePeriodSplits,
	type DashboardPeriod,
	type DashboardSession
} from './dashboard';

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
});

describe('computePeriodSplits', () => {
	const periods: DashboardPeriod[] = [
		{ id: 1, label: 'July 2026', startDate: '2026-07-01', endDate: '2026-07-31' },
		{ id: 2, label: 'June 2026', startDate: '2026-06-01', endDate: '2026-06-30' }
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
		const kpis = computeKpis([], [], []);
		expect(kpis).toEqual({
			lifetimeHomeKwh: 0,
			lifetimeCost: 0,
			avgEfficiency: null,
			currentPeriod: null
		});
	});

	it('sums lifetime home kWh/cost (ignoring public) and averages efficiency', () => {
		const sessions: DashboardSession[] = [
			session({ id: 1, kind: 'home', kwhUsed: 10, cost: 3 }),
			session({ id: 2, kind: 'public', kwhUsed: 100, cost: null }),
			session({ id: 3, kind: 'home', kwhUsed: 20, cost: 6 })
		];
		const efficiencySeries = [
			{ sessionId: 1, date: '2026-01-01', kmPerKwh: 8 },
			{ sessionId: 3, date: '2026-01-08', kmPerKwh: 12 }
		];
		const kpis = computeKpis(sessions, [], efficiencySeries);
		expect(kpis.lifetimeHomeKwh).toBe(30);
		expect(kpis.lifetimeCost).toBe(9);
		expect(kpis.avgEfficiency).toBe(10);
		expect(kpis.currentPeriod).toBeNull();
	});

	it('picks the most recent period (by end date) for the current-period % home', () => {
		const periods: DashboardPeriod[] = [
			{ id: 1, label: 'June 2026', startDate: '2026-06-01', endDate: '2026-06-30' },
			{ id: 2, label: 'July 2026', startDate: '2026-07-01', endDate: '2026-07-31' }
		];
		const sessions: DashboardSession[] = [
			session({ id: 1, billingPeriodId: 2, kind: 'home', kwhUsed: 30 }),
			session({ id: 2, billingPeriodId: 2, kind: 'public', kwhUsed: 10 })
		];
		const kpis = computeKpis(sessions, periods, []);
		expect(kpis.currentPeriod).toEqual({ label: 'July 2026', homePct: 0.75 });
	});
});
