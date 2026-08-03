import { describe, expect, it } from 'vitest';
import { calculateSessionCost, resolveRatePlan, type RatePlan } from './rates';

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

function peakOffpeakPlan(overrides: Partial<RatePlan> = {}): RatePlan {
	return {
		id: 2,
		effectiveFrom: '2026-01-01',
		type: 'peak_offpeak',
		flatRate: null,
		peakRate: 0.5,
		offpeakRate: 0.2,
		offpeakWindows: [{ start: '22:00', end: '07:00' }],
		...overrides
	};
}

describe('resolveRatePlan', () => {
	it('returns the only plan when a single plan is effective before the session date', () => {
		const plan = flatPlan({ effectiveFrom: '2026-01-01' });
		const result = resolveRatePlan('2026-06-15', [plan]);
		expect(result).toBe(plan);
	});

	it('picks the plan with the latest effectiveFrom that is still <= the session date', () => {
		const older = flatPlan({ id: 1, effectiveFrom: '2026-01-01', flatRate: 0.25 });
		const newer = flatPlan({ id: 2, effectiveFrom: '2026-06-01', flatRate: 0.3 });

		// Session date falls after the newer plan's effective date -> newer applies.
		expect(resolveRatePlan('2026-07-01', [older, newer])?.id).toBe(2);

		// Session date falls before the newer plan's effective date -> older applies.
		expect(resolveRatePlan('2026-03-01', [older, newer])?.id).toBe(1);
	});

	it('is order-independent in the input array', () => {
		const older = flatPlan({ id: 1, effectiveFrom: '2026-01-01' });
		const newer = flatPlan({ id: 2, effectiveFrom: '2026-06-01' });

		expect(resolveRatePlan('2026-07-01', [newer, older])?.id).toBe(2);
	});

	it('treats effectiveFrom as inclusive: a plan effective exactly on the session date applies', () => {
		const plan = flatPlan({ id: 1, effectiveFrom: '2026-06-01' });
		expect(resolveRatePlan('2026-06-01', [plan])?.id).toBe(1);
	});

	it('returns undefined when no plan is effective on or before the session date', () => {
		const plan = flatPlan({ effectiveFrom: '2026-06-01' });
		expect(resolveRatePlan('2026-01-01', [plan])).toBeUndefined();
	});

	it('returns undefined for an empty plan list', () => {
		expect(resolveRatePlan('2026-06-01', [])).toBeUndefined();
	});
});

describe('calculateSessionCost - flat plans', () => {
	it('multiplies kWh used by the flat rate', () => {
		const plan = flatPlan({ flatRate: 0.35 });
		const cost = calculateSessionCost({ date: '2026-06-01', time: '18:00', kwhUsed: 10 }, plan);
		expect(cost).toBeCloseTo(3.5);
	});

	it('throws if a flat plan is missing its flatRate', () => {
		const plan = flatPlan({ flatRate: null });
		expect(() =>
			calculateSessionCost({ date: '2026-06-01', time: '18:00', kwhUsed: 10 }, plan)
		).toThrow();
	});
});

describe('calculateSessionCost - peak/offpeak plans', () => {
	it('bills at the off-peak rate when the start time is inside a non-wrapping window', () => {
		const plan = peakOffpeakPlan({
			peakRate: 0.5,
			offpeakRate: 0.2,
			offpeakWindows: [{ start: '10:00', end: '16:00' }]
		});
		const cost = calculateSessionCost({ date: '2026-06-01', time: '12:00', kwhUsed: 10 }, plan);
		expect(cost).toBeCloseTo(2.0);
	});

	it('bills at the peak rate when the start time is outside a non-wrapping window', () => {
		const plan = peakOffpeakPlan({
			peakRate: 0.5,
			offpeakRate: 0.2,
			offpeakWindows: [{ start: '10:00', end: '16:00' }]
		});
		const cost = calculateSessionCost({ date: '2026-06-01', time: '18:00', kwhUsed: 10 }, plan);
		expect(cost).toBeCloseTo(5.0);
	});

	it('handles an off-peak window that crosses midnight - time after start, before midnight', () => {
		const plan = peakOffpeakPlan({
			peakRate: 0.5,
			offpeakRate: 0.2,
			offpeakWindows: [{ start: '22:00', end: '07:00' }]
		});
		const cost = calculateSessionCost({ date: '2026-06-01', time: '23:30', kwhUsed: 10 }, plan);
		expect(cost).toBeCloseTo(2.0);
	});

	it('handles an off-peak window that crosses midnight - time after midnight, before end', () => {
		const plan = peakOffpeakPlan({
			peakRate: 0.5,
			offpeakRate: 0.2,
			offpeakWindows: [{ start: '22:00', end: '07:00' }]
		});
		const cost = calculateSessionCost({ date: '2026-06-01', time: '05:00', kwhUsed: 10 }, plan);
		expect(cost).toBeCloseTo(2.0);
	});

	it('bills at peak rate for a time strictly between a midnight-crossing window', () => {
		const plan = peakOffpeakPlan({
			peakRate: 0.5,
			offpeakRate: 0.2,
			offpeakWindows: [{ start: '22:00', end: '07:00' }]
		});
		const cost = calculateSessionCost({ date: '2026-06-01', time: '14:00', kwhUsed: 10 }, plan);
		expect(cost).toBeCloseTo(5.0);
	});

	it('boundary: start time exactly at the window start is off-peak (inclusive start)', () => {
		const plan = peakOffpeakPlan({
			offpeakWindows: [{ start: '22:00', end: '07:00' }]
		});
		const cost = calculateSessionCost({ date: '2026-06-01', time: '22:00', kwhUsed: 10 }, plan);
		expect(cost).toBeCloseTo(2.0);
	});

	it('boundary: start time exactly at the window end is peak (exclusive end)', () => {
		const plan = peakOffpeakPlan({
			offpeakWindows: [{ start: '22:00', end: '07:00' }]
		});
		const cost = calculateSessionCost({ date: '2026-06-01', time: '07:00', kwhUsed: 10 }, plan);
		expect(cost).toBeCloseTo(5.0);
	});

	it('supports multiple off-peak windows in the same plan', () => {
		const plan = peakOffpeakPlan({
			peakRate: 0.5,
			offpeakRate: 0.2,
			offpeakWindows: [
				{ start: '22:00', end: '07:00' },
				{ start: '11:00', end: '14:00' }
			]
		});
		expect(
			calculateSessionCost({ date: '2026-06-01', time: '12:30', kwhUsed: 5 }, plan)
		).toBeCloseTo(1.0);
		expect(
			calculateSessionCost({ date: '2026-06-01', time: '09:00', kwhUsed: 5 }, plan)
		).toBeCloseTo(2.5);
	});

	it('throws if a peak_offpeak plan is missing peak or offpeak rates', () => {
		const plan = peakOffpeakPlan({ peakRate: null });
		expect(() =>
			calculateSessionCost({ date: '2026-06-01', time: '12:00', kwhUsed: 10 }, plan)
		).toThrow();
	});
});

describe('resolveRatePlan + calculateSessionCost integration', () => {
	it('uses the correct versioned plan for sessions on either side of a rate change', () => {
		const oldPlan = flatPlan({ id: 1, effectiveFrom: '2026-01-01', flatRate: 0.25 });
		const newPlan = flatPlan({ id: 2, effectiveFrom: '2026-06-01', flatRate: 0.32 });
		const plans = [oldPlan, newPlan];

		const beforeChange = resolveRatePlan('2026-05-31', plans)!;
		const afterChange = resolveRatePlan('2026-06-01', plans)!;

		expect(
			calculateSessionCost({ date: '2026-05-31', time: '20:00', kwhUsed: 10 }, beforeChange)
		).toBeCloseTo(2.5);
		expect(
			calculateSessionCost({ date: '2026-06-01', time: '20:00', kwhUsed: 10 }, afterChange)
		).toBeCloseTo(3.2);
	});
});
