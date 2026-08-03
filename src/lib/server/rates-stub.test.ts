import { describe, expect, it } from 'vitest';
import { calculateSessionCost, resolveRatePlan, type RatePlan } from './rates-stub';

function flatPlan(overrides: Partial<RatePlan> = {}): RatePlan {
	return {
		id: 1,
		effectiveFrom: '2026-01-01',
		type: 'flat',
		flatRate: 0.3,
		peakRate: null,
		offpeakRate: null,
		offpeakWindows: null,
		...overrides
	};
}

describe('resolveRatePlan', () => {
	it('returns null when no plan is effective yet', () => {
		const plans = [flatPlan({ effectiveFrom: '2026-09-01' })];
		expect(resolveRatePlan('2026-08-01', plans)).toBeNull();
	});

	it('picks the plan with the latest effectiveFrom that is still <= date', () => {
		const older = flatPlan({ id: 1, effectiveFrom: '2026-01-01', flatRate: 0.25 });
		const newer = flatPlan({ id: 2, effectiveFrom: '2026-06-01', flatRate: 0.32 });
		expect(resolveRatePlan('2026-08-01', [older, newer])?.id).toBe(2);
		expect(resolveRatePlan('2026-03-01', [older, newer])?.id).toBe(1);
	});
});

describe('calculateSessionCost', () => {
	const session = { date: '2026-08-01', time: '20:00', kwhUsed: 10 };

	it('returns null when no plan applies', () => {
		expect(calculateSessionCost(session, null)).toBeNull();
	});

	it('computes flat-rate cost as kWh x rate', () => {
		expect(calculateSessionCost(session, flatPlan({ flatRate: 0.3 }))).toBeCloseTo(3, 5);
	});

	it('approximates peak/off-peak cost using the off-peak rate when set', () => {
		const plan = flatPlan({
			type: 'peak_offpeak',
			flatRate: null,
			peakRate: 0.4,
			offpeakRate: 0.2
		});
		expect(calculateSessionCost(session, plan)).toBeCloseTo(2, 5);
	});

	it('falls back to the peak rate when no off-peak rate is set', () => {
		const plan = flatPlan({
			type: 'peak_offpeak',
			flatRate: null,
			peakRate: 0.4,
			offpeakRate: null
		});
		expect(calculateSessionCost(session, plan)).toBeCloseTo(4, 5);
	});
});
