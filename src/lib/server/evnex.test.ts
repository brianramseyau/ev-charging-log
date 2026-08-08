import { describe, expect, it } from 'vitest';
import {
	importWindow,
	isTokenExpired,
	planImport,
	toDraftSession,
	type EvnexSessionPayload,
	type ExistingSessionForImport
} from './evnex';

function payload(overrides: Partial<EvnexSessionPayload> = {}): EvnexSessionPayload {
	return {
		id: 'evnex-session-1',
		startDate: '2026-08-08T10:00:00.000Z',
		sessionStatus: 'Completed',
		energyKwh: 10,
		...overrides
	};
}

function existingRow(overrides: Partial<ExistingSessionForImport> = {}): ExistingSessionForImport {
	return {
		id: 1,
		externalId: 'evnex-session-1',
		kwhUsed: null,
		billingPeriodId: null,
		...overrides
	};
}

const baseOpts = {
	windowStart: '2026-08-01T00:00:00.000Z',
	timeZone: 'Australia/Sydney',
	location: '123 Home St',
	submittedPeriodIds: [] as number[]
};

describe('importWindow', () => {
	it('subtracts exactly lookbackDays * 24h from now, as instants', () => {
		const now = new Date('2026-08-08T10:00:00.000Z');
		const { from, to } = importWindow(now, 3);
		expect(to).toBe('2026-08-08T10:00:00.000Z');
		expect(from).toBe('2026-08-05T10:00:00.000Z');
	});

	it('crosses a month boundary correctly', () => {
		const now = new Date('2026-03-01T00:00:00.000Z');
		const { from } = importWindow(now, 3);
		expect(from).toBe('2026-02-26T00:00:00.000Z');
	});

	it('crosses a year boundary correctly', () => {
		const now = new Date('2026-01-01T00:00:00.000Z');
		const { from } = importWindow(now, 2);
		expect(from).toBe('2025-12-30T00:00:00.000Z');
	});

	it('is immune to DST edges since it works purely in UTC instants', () => {
		// Sydney moves clocks forward for DST on 2026-10-04. A lookback window
		// spanning that date must still be exactly lookbackDays * 24h in
		// instant terms, regardless of the local wall-clock jump.
		const now = new Date('2026-10-06T10:00:00.000Z');
		const { from, to } = importWindow(now, 3);
		expect(new Date(to).getTime() - new Date(from).getTime()).toBe(3 * 24 * 60 * 60 * 1000);
		expect(from).toBe('2026-10-03T10:00:00.000Z');
	});
});

describe('toDraftSession', () => {
	it('converts a UTC timestamp that lands on the previous local day', () => {
		// New York is UTC-4 in August (EDT): 02:00 UTC -> 22:00 the previous day.
		const draft = toDraftSession(payload({ startDate: '2026-08-08T02:00:00.000Z' }), {
			timeZone: 'America/New_York',
			location: 'Home'
		});
		expect(draft.date).toBe('2026-08-07');
		expect(draft.time).toBe('22:00');
	});

	it('converts a UTC timestamp that lands on the next local day', () => {
		// Auckland is UTC+12 in August (NZST, no DST in southern winter):
		// 20:00 UTC -> 08:00 the next day.
		const draft = toDraftSession(payload({ startDate: '2026-08-07T20:00:00.000Z' }), {
			timeZone: 'Pacific/Auckland',
			location: 'Home'
		});
		expect(draft.date).toBe('2026-08-08');
		expect(draft.time).toBe('08:00');
	});

	it('produces date/time in the exact storage format, not just plausible values', () => {
		const draft = toDraftSession(payload({ startDate: '2026-08-08T10:00:00.000Z' }), {
			timeZone: 'Australia/Sydney',
			location: 'Home'
		});
		// A day-first en-AU regression (.format() instead of formatToParts)
		// produces a plausible-looking but wrong string like "08/08/2026" —
		// assert the format directly, not just that the value looks right.
		expect(draft.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(draft.time).toMatch(/^\d{2}:\d{2}$/);
	});

	it('stores a 00:30 local session as 00:30, not 12:30 (hourCycle trap)', () => {
		const draft = toDraftSession(payload({ startDate: '2026-08-08T00:30:00.000Z' }), {
			timeZone: 'UTC',
			location: 'Home'
		});
		expect(draft.date).toBe('2026-08-08');
		expect(draft.time).toBe('00:30');
	});

	it("carries energyKwh straight through unchanged (Wh->kWh is evnex-client.ts's job)", () => {
		const draft = toDraftSession(payload({ energyKwh: 7.532 }), {
			timeZone: 'Australia/Sydney',
			location: 'Home'
		});
		expect(draft.kwhUsed).toBe(7.532);
	});

	it('passes kwhUsed as null when energyKwh is null (meterStop absent / no transaction)', () => {
		const draft = toDraftSession(payload({ energyKwh: null }), {
			timeZone: 'Australia/Sydney',
			location: 'Home'
		});
		expect(draft.kwhUsed).toBeNull();
	});

	it('always sets kind to home, odometerKm to null, notes to null, and uses opts.location', () => {
		const draft = toDraftSession(payload(), { timeZone: 'Australia/Sydney', location: 'Unit 4' });
		expect(draft.kind).toBe('home');
		expect(draft.odometerKm).toBeNull();
		expect(draft.notes).toBeNull();
		expect(draft.location).toBe('Unit 4');
		expect(draft.externalId).toBe('evnex-session-1');
	});

	it('throws rather than inventing a date when startDate is missing', () => {
		expect(() =>
			toDraftSession(payload({ startDate: null }), {
				timeZone: 'Australia/Sydney',
				location: 'Home'
			})
		).toThrow();
		expect(() =>
			toDraftSession(payload({ startDate: undefined }), {
				timeZone: 'Australia/Sydney',
				location: 'Home'
			})
		).toThrow();
	});
});

describe('planImport', () => {
	it('rule 0: no startDate -> unmappable, not tombstoned', () => {
		const result = planImport([payload({ startDate: null })], [], [], baseOpts);
		expect(result.skipped).toEqual([{ externalId: 'evnex-session-1', reason: 'unmappable' }]);
		expect(result.tombstone).toEqual([]);
		expect(result.insert).toEqual([]);
	});

	it('rule 0: undefined startDate also counts as unmappable', () => {
		const result = planImport([payload({ startDate: undefined })], [], [], baseOpts);
		expect(result.skipped).toEqual([{ externalId: 'evnex-session-1', reason: 'unmappable' }]);
		expect(result.tombstone).toEqual([]);
	});

	it('rule 1: Invalid with no existing row -> tombstone + skip reason "invalid"', () => {
		const result = planImport([payload({ sessionStatus: 'Invalid' })], [], [], baseOpts);
		expect(result.tombstone).toEqual(['evnex-session-1']);
		expect(result.skipped).toEqual([{ externalId: 'evnex-session-1', reason: 'invalid' }]);
		expect(result.insert).toEqual([]);
		expect(result.update).toEqual([]);
	});

	it('rule 1: Invalid with an existing row -> tombstone + "invalid_after_import", row untouched', () => {
		const existing = [existingRow({ id: 42, kwhUsed: 5, billingPeriodId: 3 })];
		const result = planImport([payload({ sessionStatus: 'Invalid' })], existing, [], baseOpts);
		expect(result.tombstone).toEqual(['evnex-session-1']);
		expect(result.skipped).toEqual([
			{ externalId: 'evnex-session-1', reason: 'invalid_after_import' }
		]);
		// The existing row must not appear in insert or update.
		expect(result.insert).toEqual([]);
		expect(result.update).toEqual([]);
	});

	it('rule 1: an Invalid session already in dismissed still plans cleanly (still tombstoned)', () => {
		const result = planImport(
			[payload({ sessionStatus: 'Invalid' })],
			[],
			['evnex-session-1'],
			baseOpts
		);
		expect(result.tombstone).toEqual(['evnex-session-1']);
		expect(result.skipped).toEqual([{ externalId: 'evnex-session-1', reason: 'invalid' }]);
	});

	it('no sessionStatus is treated as not-Invalid (never tombstoned by rule 1)', () => {
		const result = planImport([payload({ sessionStatus: undefined })], [], [], baseOpts);
		expect(result.tombstone).toEqual([]);
		expect(result.insert).toHaveLength(1);
	});

	it('rule 2: a session before windowStart -> outside_window', () => {
		const result = planImport(
			[payload({ startDate: '2026-07-31T00:00:00.000Z' })],
			[],
			[],
			baseOpts
		);
		expect(result.skipped).toEqual([{ externalId: 'evnex-session-1', reason: 'outside_window' }]);
		expect(result.insert).toEqual([]);
	});

	it('rule 2: a session exactly at windowStart is inside the window', () => {
		const result = planImport([payload({ startDate: baseOpts.windowStart })], [], [], baseOpts);
		expect(result.insert).toHaveLength(1);
	});

	it('rule 3: an externalId in the dismissed list is skipped', () => {
		const result = planImport([payload()], [], ['evnex-session-1'], baseOpts);
		expect(result.skipped).toEqual([{ externalId: 'evnex-session-1', reason: 'dismissed' }]);
		expect(result.insert).toEqual([]);
	});

	it('rule 4: no existing row -> inserts a draft, even mid-charge (kwhUsed null)', () => {
		const result = planImport([payload({ energyKwh: null })], [], [], baseOpts);
		expect(result.insert).toHaveLength(1);
		expect(result.insert[0]).toMatchObject({ externalId: 'evnex-session-1', kwhUsed: null });
	});

	it('rule 5: existing row with kwhUsed already set -> already_complete, never overwritten', () => {
		const existing = [existingRow({ id: 7, kwhUsed: 12.3 })];
		const result = planImport([payload({ energyKwh: 99 })], existing, [], baseOpts);
		expect(result.skipped).toEqual([{ externalId: 'evnex-session-1', reason: 'already_complete' }]);
		expect(result.update).toEqual([]);
	});

	it('rule 6: existing row, kwhUsed null, energyKwh still null -> still_charging', () => {
		const existing = [existingRow({ id: 7, kwhUsed: null })];
		const result = planImport([payload({ energyKwh: null })], existing, [], baseOpts);
		expect(result.skipped).toEqual([{ externalId: 'evnex-session-1', reason: 'still_charging' }]);
		expect(result.update).toEqual([]);
	});

	it('the falsy trap: energyKwh === 0 is treated as present, not still-charging', () => {
		const existing = [existingRow({ id: 7, kwhUsed: null })];
		const result = planImport([payload({ energyKwh: 0 })], existing, [], baseOpts);
		expect(result.skipped).toEqual([]);
		expect(result.update).toEqual([{ id: 7, kwhUsed: 0 }]);
	});

	it('rule 7: existing row, kwhUsed null, energyKwh present -> update', () => {
		const existing = [existingRow({ id: 7, kwhUsed: null })];
		const result = planImport([payload({ energyKwh: 15.4 })], existing, [], baseOpts);
		expect(result.update).toEqual([{ id: 7, kwhUsed: 15.4 }]);
		expect(result.skipped).toEqual([]);
	});

	it('rule 8: an update whose billing period is already submitted -> period_submitted', () => {
		const existing = [existingRow({ id: 7, kwhUsed: null, billingPeriodId: 99 })];
		const opts = { ...baseOpts, submittedPeriodIds: [99] };
		const result = planImport([payload({ energyKwh: 15.4 })], existing, [], opts);
		expect(result.update).toEqual([]);
		expect(result.skipped).toEqual([{ externalId: 'evnex-session-1', reason: 'period_submitted' }]);
	});

	it('rule 8 does not fire when the billing period is not in submittedPeriodIds', () => {
		const existing = [existingRow({ id: 7, kwhUsed: null, billingPeriodId: 99 })];
		const opts = { ...baseOpts, submittedPeriodIds: [1, 2, 3] };
		const result = planImport([payload({ energyKwh: 15.4 })], existing, [], opts);
		expect(result.update).toEqual([{ id: 7, kwhUsed: 15.4 }]);
	});

	it('processes multiple sessions independently in one call', () => {
		const remote = [
			payload({ id: 'a', startDate: null }), // unmappable
			payload({ id: 'b', sessionStatus: 'Invalid' }), // invalid
			payload({ id: 'c', startDate: '2026-07-01T00:00:00.000Z' }), // outside_window
			payload({ id: 'd' }) // fresh insert
		];
		const result = planImport(remote, [], [], baseOpts);
		expect(result.insert.map((d) => d.externalId)).toEqual(['d']);
		expect(result.tombstone).toEqual(['b']);
		const reasons = Object.fromEntries(result.skipped.map((s) => [s.externalId, s.reason]));
		expect(reasons).toEqual({ a: 'unmappable', b: 'invalid', c: 'outside_window' });
	});

	it('ignores existing rows that are manual (externalId null) when matching', () => {
		const existing = [existingRow({ id: 1, externalId: null, kwhUsed: 20 })];
		const result = planImport([payload()], existing, [], baseOpts);
		// Should be treated as a fresh insert, not matched against the manual row.
		expect(result.insert).toHaveLength(1);
		expect(result.update).toEqual([]);
	});
});

describe('isTokenExpired', () => {
	it('is expired when there is no token at all', () => {
		expect(isTokenExpired(null, new Date('2026-08-08T10:00:00.000Z'))).toBe(true);
	});

	it('is not expired well before expiresAt', () => {
		const expiresAt = '2026-08-08T11:00:00.000Z';
		const now = new Date('2026-08-08T10:00:00.000Z');
		expect(isTokenExpired(expiresAt, now)).toBe(false);
	});

	it('is expired once now is past expiresAt', () => {
		const expiresAt = '2026-08-08T10:00:00.000Z';
		const now = new Date('2026-08-08T10:05:00.000Z');
		expect(isTokenExpired(expiresAt, now)).toBe(true);
	});

	it('treats a token inside the clock-skew margin as expired (proactive refresh)', () => {
		const expiresAt = '2026-08-08T10:00:00.000Z';
		// 20 seconds before nominal expiry - within a 30-60s margin, should refresh now.
		const now = new Date('2026-08-08T09:59:40.000Z');
		expect(isTokenExpired(expiresAt, now)).toBe(true);
	});

	it('is not expired just outside the clock-skew margin', () => {
		const expiresAt = '2026-08-08T10:00:00.000Z';
		// 2 minutes before nominal expiry - safely outside any 30-60s margin.
		const now = new Date('2026-08-08T09:58:00.000Z');
		expect(isTokenExpired(expiresAt, now)).toBe(false);
	});

	it('treats an unparseable expiresAt as expired', () => {
		expect(isTokenExpired('not-a-date', new Date())).toBe(true);
	});
});
