import { describe, expect, it } from 'vitest';
import {
	findBillingPeriodId,
	hasUnresolvedDrafts,
	isOdometerBelowLastRecorded,
	isPeriodSubmitted,
	mostRecentOdometer,
	sortByDateTimeAsc,
	sortByDateTimeDesc,
	withEfficiency
} from './sessions';

const s = (
	id: number,
	date: string,
	time: string,
	odometerKm: number | null,
	kwhUsed: number | null
) => ({
	id,
	date,
	time,
	odometerKm,
	kwhUsed
});

describe('sortByDateTimeAsc / sortByDateTimeDesc', () => {
	it('sorts chronologically by date then time', () => {
		const rows = [
			s(1, '2026-08-02', '09:00', 100, 10),
			s(2, '2026-08-01', '20:00', 90, 10),
			s(3, '2026-08-02', '07:00', 95, 10)
		];
		expect(sortByDateTimeAsc(rows).map((r) => r.id)).toEqual([2, 3, 1]);
		expect(sortByDateTimeDesc(rows).map((r) => r.id)).toEqual([1, 3, 2]);
	});

	it('does not mutate the input array', () => {
		const rows = [s(1, '2026-08-02', '09:00', 100, 10), s(2, '2026-08-01', '20:00', 90, 10)];
		const original = [...rows];
		sortByDateTimeAsc(rows);
		expect(rows).toEqual(original);
	});
});

describe('mostRecentOdometer', () => {
	it('returns null for an empty list', () => {
		expect(mostRecentOdometer([])).toBeNull();
	});

	it('returns the odometer of the chronologically latest session', () => {
		const rows = [s(1, '2026-08-01', '09:00', 1000, 10), s(2, '2026-08-05', '09:00', 1200, 10)];
		expect(mostRecentOdometer(rows)).toBe(1200);
	});

	it('skips a null-odometer row to find the next most recent real reading', () => {
		const rows = [
			s(1, '2026-08-01', '09:00', 1000, 10),
			s(2, '2026-08-05', '09:00', null, null) // draft, odometer not yet known
		];
		expect(mostRecentOdometer(rows)).toBe(1000);
	});

	it('returns null when every row has a null odometer', () => {
		const rows = [s(1, '2026-08-01', '09:00', null, null), s(2, '2026-08-05', '09:00', null, null)];
		expect(mostRecentOdometer(rows)).toBeNull();
	});
});

describe('isOdometerBelowLastRecorded', () => {
	it('warns when the new odometer is lower than the last recorded one', () => {
		const existing = [s(1, '2026-08-01', '09:00', 1000, 10)];
		expect(isOdometerBelowLastRecorded(999, existing)).toBe(true);
	});

	it('does not warn when equal or higher', () => {
		const existing = [s(1, '2026-08-01', '09:00', 1000, 10)];
		expect(isOdometerBelowLastRecorded(1000, existing)).toBe(false);
		expect(isOdometerBelowLastRecorded(1001, existing)).toBe(false);
	});

	it('does not warn when there are no prior sessions', () => {
		expect(isOdometerBelowLastRecorded(500, [])).toBe(false);
	});
});

describe('findBillingPeriodId', () => {
	const periods = [
		{ id: 1, startDate: '2026-06-01', endDate: '2026-06-30' },
		{ id: 2, startDate: '2026-07-01', endDate: '2026-07-31' }
	];

	it('finds the period whose range contains the date', () => {
		expect(findBillingPeriodId('2026-07-15', periods)).toBe(2);
	});

	it('matches on the boundary dates (inclusive)', () => {
		expect(findBillingPeriodId('2026-06-01', periods)).toBe(1);
		expect(findBillingPeriodId('2026-06-30', periods)).toBe(1);
	});

	it('returns null when no period matches', () => {
		expect(findBillingPeriodId('2026-08-01', periods)).toBeNull();
	});
});

describe('isPeriodSubmitted', () => {
	it('is false when the period has never been submitted', () => {
		expect(isPeriodSubmitted({ label: 'July 2026', submittedAt: null })).toBe(false);
	});

	it('is true once submittedAt is set', () => {
		expect(isPeriodSubmitted({ label: 'July 2026', submittedAt: '2026-08-01T00:00:00.000Z' })).toBe(
			true
		);
	});

	it('is false when there is no matching period (session unassigned)', () => {
		expect(isPeriodSubmitted(null)).toBe(false);
		expect(isPeriodSubmitted(undefined)).toBe(false);
	});
});

describe('withEfficiency', () => {
	it('is null for the first session', () => {
		const rows = [s(1, '2026-08-01', '09:00', 1000, 10)];
		expect(withEfficiency(rows)[0].efficiencyKmPerKwh).toBeNull();
	});

	it('computes km/kWh from the previous session by chronological order', () => {
		const rows = [s(1, '2026-08-01', '09:00', 1000, 10), s(2, '2026-08-05', '09:00', 1150, 15)];
		const result = withEfficiency(rows);
		expect(result[1].efficiencyKmPerKwh).toBeCloseTo(10, 5); // (1150-1000)/15
	});

	it('orders by date/time regardless of input order, and guards against zero kWh', () => {
		const rows = [s(2, '2026-08-05', '09:00', 1150, 0), s(1, '2026-08-01', '09:00', 1000, 10)];
		const result = withEfficiency(rows);
		expect(result.map((r) => r.id)).toEqual([1, 2]);
		expect(result[1].efficiencyKmPerKwh).toBeNull();
	});

	it('is null for a draft session (kWh not yet recorded)', () => {
		const rows = [s(1, '2026-08-01', '09:00', 1000, 10), s(2, '2026-08-05', '09:00', 1150, null)];
		const result = withEfficiency(rows);
		expect(result[1].efficiencyKmPerKwh).toBeNull();
	});

	it("still uses a draft session's odometer as the previous reading for the next session", () => {
		const rows = [
			s(1, '2026-08-01', '09:00', 1000, null), // draft
			s(2, '2026-08-05', '09:00', 1150, 15)
		];
		const result = withEfficiency(rows);
		expect(result[1].efficiencyKmPerKwh).toBeCloseTo(10, 5); // (1150-1000)/15
	});

	it('is null when the current session has no odometer reading yet', () => {
		const rows = [
			s(1, '2026-08-01', '09:00', 1000, 10),
			s(2, '2026-08-05', '09:00', null, 15) // odometer not yet reported (e.g. Evnex draft)
		];
		const result = withEfficiency(rows);
		expect(result[1].efficiencyKmPerKwh).toBeNull();
	});

	it('is null when the immediately-preceding session has no odometer reading, without carrying forward an earlier one', () => {
		const rows = [
			s(1, '2026-08-01', '09:00', 1000, 10),
			s(2, '2026-08-03', '09:00', null, 5), // odometer not yet reported
			s(3, '2026-08-05', '09:00', 1150, 15)
		];
		const result = withEfficiency(rows);
		expect(result[2].efficiencyKmPerKwh).toBeNull();
	});

	it('computes correctly for a normal pair with two non-null odometers', () => {
		const rows = [s(1, '2026-08-01', '09:00', 1000, 10), s(2, '2026-08-05', '09:00', 1150, 15)];
		const result = withEfficiency(rows);
		expect(result[1].efficiencyKmPerKwh).toBeCloseTo(10, 5); // (1150-1000)/15
	});
});

describe('hasUnresolvedDrafts', () => {
	it('is true when a session with no kWh recorded belongs to the period', () => {
		const sessions = [
			{ billingPeriodId: 1, kwhUsed: null },
			{ billingPeriodId: 2, kwhUsed: 10 }
		];
		expect(hasUnresolvedDrafts(1, sessions)).toBe(true);
	});

	it('is false when every session in the period has kWh recorded', () => {
		const sessions = [
			{ billingPeriodId: 1, kwhUsed: 10 },
			{ billingPeriodId: 2, kwhUsed: null }
		];
		expect(hasUnresolvedDrafts(1, sessions)).toBe(false);
	});

	it('is false for an empty session list', () => {
		expect(hasUnresolvedDrafts(1, [])).toBe(false);
	});
});
