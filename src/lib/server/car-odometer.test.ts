import { describe, expect, it } from 'vitest';
import {
	SAME_POLL_TOLERANCE_MS,
	carOdometerAlert,
	isBrokenStatus,
	latestReading,
	parseCompanionResponse,
	planOdometerFill,
	requestWindow,
	toReadings,
	validateBaseUrl,
	type CompanionResponse,
	type DraftForFill,
	type Reading
} from './car-odometer';

// Shaped like a redacted overnight capture: the car arrives home with a new
// odometer, sits on the charger while HA keeps recording unchanged reports every
// five minutes, then leaves the next morning.
function response(overrides: Partial<CompanionResponse> = {}): CompanionResponse {
	return {
		version: 1,
		odometer: {
			unit: 'km',
			changes: [
				{ state: '118102', at: '2026-09-21T00:00:00+00:00' },
				{ state: '118204', at: '2026-09-23T08:41:10+00:00' },
				{ state: '118251', at: '2026-09-23T22:10:04+00:00' }
			]
		},
		telemetry: {
			changes: [
				{ state: '2026-09-20T22:59:31+00:00', at: '2026-09-21T00:00:00+00:00' },
				{ state: '2026-09-23T08:40:52+00:00', at: '2026-09-23T08:41:10+00:00' },
				{ state: '2026-09-23T09:15:03+00:00', at: '2026-09-23T09:16:10+00:00' },
				{ state: '2026-09-23T12:30:40+00:00', at: '2026-09-23T12:31:10+00:00' },
				{ state: '2026-09-23T22:09:50+00:00', at: '2026-09-23T22:10:04+00:00' }
			]
		},
		oldestRecorded: '2026-09-14T03:00:00+00:00',
		...overrides
	};
}

describe('parseCompanionResponse', () => {
	it('accepts a version 1 response', () => {
		const result = parseCompanionResponse(response());
		expect(result.ok).toBe(true);
	});

	it('reports a different version as outdated, before looking at the shape', () => {
		expect(parseCompanionResponse({ version: 2 })).toEqual({
			ok: false,
			reason: 'outdated',
			version: 2
		});
		expect(parseCompanionResponse({ odometer: {} })).toMatchObject({
			ok: false,
			reason: 'outdated'
		});
	});

	it('rejects a non-object body as malformed', () => {
		expect(parseCompanionResponse('<html>')).toMatchObject({ ok: false, reason: 'malformed' });
		expect(parseCompanionResponse(null)).toMatchObject({ ok: false, reason: 'malformed' });
		expect(parseCompanionResponse([])).toMatchObject({ ok: false, reason: 'malformed' });
	});

	it('rejects missing or badly-typed change lists as malformed', () => {
		expect(parseCompanionResponse({ ...response(), telemetry: undefined })).toMatchObject({
			ok: false,
			reason: 'malformed'
		});
		expect(
			parseCompanionResponse({
				...response(),
				odometer: { unit: 'km', changes: [{ state: 118102, at: 'x' }] }
			})
		).toMatchObject({ ok: false, reason: 'malformed' });
	});

	it('tolerates a null unit and a null oldestRecorded', () => {
		const result = parseCompanionResponse({
			...response(),
			odometer: { unit: null, changes: [] },
			oldestRecorded: null
		});
		expect(result).toMatchObject({ ok: true });
	});
});

describe('toReadings', () => {
	it('pairs each telemetry change with the odometer in effect at its `at`', () => {
		expect(toReadings(response())).toEqual([
			{ km: 118102, carReportedAt: '2026-09-20T22:59:31.000Z' },
			{ km: 118204, carReportedAt: '2026-09-23T08:40:52.000Z' },
			{ km: 118204, carReportedAt: '2026-09-23T09:15:03.000Z' },
			{ km: 118204, carReportedAt: '2026-09-23T12:30:40.000Z' },
			{ km: 118251, carReportedAt: '2026-09-23T22:09:50.000Z' }
		]);
	});

	it('uses an odometer change recorded just before the telemetry change', () => {
		const r = response({
			odometer: {
				unit: 'km',
				changes: [
					{ state: '100', at: '2026-09-23T08:00:00Z' },
					{ state: '200', at: '2026-09-23T08:59:59Z' }
				]
			},
			telemetry: { changes: [{ state: '2026-09-23T08:59:00Z', at: '2026-09-23T09:00:00Z' }] }
		});
		expect(toReadings(r)).toEqual([{ km: 200, carReportedAt: '2026-09-23T08:59:00.000Z' }]);
	});

	it('uses an odometer change recorded at exactly the same instant', () => {
		const r = response({
			odometer: {
				unit: 'km',
				changes: [
					{ state: '100', at: '2026-09-23T08:00:00Z' },
					{ state: '200', at: '2026-09-23T09:00:00Z' }
				]
			},
			telemetry: { changes: [{ state: '2026-09-23T08:59:00Z', at: '2026-09-23T09:00:00Z' }] }
		});
		expect(toReadings(r)[0].km).toBe(200);
	});

	it('treats an odometer change written milliseconds after as the same HA poll', () => {
		const r = response({
			odometer: {
				unit: 'km',
				changes: [
					{ state: '100', at: '2026-09-23T08:00:00Z' },
					{ state: '200', at: '2026-09-23T09:00:00.004Z' }
				]
			},
			telemetry: { changes: [{ state: '2026-09-23T08:59:00Z', at: '2026-09-23T09:00:00Z' }] }
		});
		expect(toReadings(r)[0].km).toBe(200);
	});

	it('does not use an odometer change recorded after the same-poll tolerance', () => {
		const later = new Date(Date.parse('2026-09-23T09:00:00Z') + SAME_POLL_TOLERANCE_MS + 1);
		const r = response({
			odometer: {
				unit: 'km',
				changes: [
					{ state: '100', at: '2026-09-23T08:00:00Z' },
					{ state: '200', at: later.toISOString() }
				]
			},
			telemetry: { changes: [{ state: '2026-09-23T08:59:00Z', at: '2026-09-23T09:00:00Z' }] }
		});
		expect(toReadings(r)[0].km).toBe(100);
	});

	it.each(['unavailable', 'unknown', '0', '-1', ''])('drops an odometer state of %j', (state) => {
		const r = response({
			odometer: { unit: 'km', changes: [{ state, at: '2026-09-23T08:00:00Z' }] },
			telemetry: { changes: [{ state: '2026-09-23T08:59:00Z', at: '2026-09-23T09:00:00Z' }] }
		});
		expect(toReadings(r)).toEqual([]);
	});

	it.each(['unavailable', 'unknown', 'not a date'])('drops a telemetry state of %j', (state) => {
		const r = response({
			telemetry: { changes: [{ state, at: '2026-09-23T09:00:00Z' }] }
		});
		expect(toReadings(r)).toEqual([]);
	});

	it.each(['mi', 'm', null])('returns nothing when the unit is %j', (unit) => {
		const r = response();
		r.odometer.unit = unit;
		expect(toReadings(r)).toEqual([]);
	});

	it('collapses duplicate car reports into one reading', () => {
		const r = response({
			telemetry: {
				changes: [
					{ state: '2026-09-23T08:40:52Z', at: '2026-09-23T08:41:10Z' },
					{ state: '2026-09-23T08:40:52Z', at: '2026-09-23T08:46:10Z' },
					{ state: '2026-09-23T08:40:52Z', at: '2026-09-23T08:51:10Z' }
				]
			}
		});
		expect(toReadings(r)).toEqual([{ km: 118204, carReportedAt: '2026-09-23T08:40:52.000Z' }]);
	});

	it("dates a stale re-poll by the car's timestamp, not HA's recorded time", () => {
		// HA recorded this at 10:00, inside a 09:30–11:00 charge, but the car
		// produced the data at 07:00 — before the charge.
		const r = response({
			odometer: { unit: 'km', changes: [{ state: '118204', at: '2026-09-23T06:00:00Z' }] },
			telemetry: { changes: [{ state: '2026-09-23T07:00:00Z', at: '2026-09-23T10:00:00Z' }] }
		});
		const readings = toReadings(r);
		expect(readings).toEqual([{ km: 118204, carReportedAt: '2026-09-23T07:00:00.000Z' }]);

		const plan = planOdometerFill(
			[draft({ startedAt: '2026-09-23T09:30:00Z', endedAt: '2026-09-23T11:00:00Z' })],
			readings,
			[],
			null,
			NOW
		);
		expect(plan.fill).toEqual([]);
		expect(plan.suggest).toHaveLength(1);
	});
});

describe('latestReading', () => {
	it('returns the most recent car report', () => {
		expect(latestReading(toReadings(response()))).toEqual({
			km: 118251,
			carReportedAt: '2026-09-23T22:09:50.000Z'
		});
	});

	it('returns null with no readings', () => {
		expect(latestReading([])).toBeNull();
	});
});

const NOW = new Date('2026-09-24T09:00:00Z');

function draft(overrides: Partial<DraftForFill> = {}): DraftForFill {
	return {
		id: 10,
		date: '2026-09-23',
		time: '18:45',
		startedAt: '2026-09-23T08:45:00Z',
		endedAt: '2026-09-23T13:00:00Z',
		...overrides
	};
}

function reading(carReportedAt: string, km: number): Reading {
	return { km, carReportedAt };
}

describe('planOdometerFill', () => {
	it('fills from readings the car reported during the charge', () => {
		const plan = planOdometerFill([draft()], toReadings(response()), [], null, NOW);
		expect(plan.fill).toEqual([{ id: 10, km: 118204, carReportedAt: '2026-09-23T09:15:03.000Z' }]);
		expect(plan.suggest).toEqual([]);
		expect(plan.skip).toEqual([]);
	});

	describe('window boundaries are inclusive', () => {
		const start = '2026-09-23T08:45:00.000Z';
		const end = '2026-09-23T13:00:00.000Z';

		it.each([
			['exactly on startedAt', '2026-09-23T08:45:00.000Z', 'fill'],
			['exactly on endedAt', '2026-09-23T13:00:00.000Z', 'fill'],
			['one second before startedAt', '2026-09-23T08:44:59.000Z', 'suggest'],
			['one second after endedAt', '2026-09-23T13:00:01.000Z', 'no_data']
		])('a reading %s', (_label, at, expected) => {
			const plan = planOdometerFill(
				[draft({ startedAt: start, endedAt: end })],
				[reading(at, 118204)],
				[],
				null,
				NOW
			);
			if (expected === 'fill') expect(plan.fill).toHaveLength(1);
			if (expected === 'suggest') expect(plan.suggest).toHaveLength(1);
			if (expected === 'no_data') expect(plan.skip).toEqual([{ id: 10, reason: 'no_data' }]);
		});
	});

	it('skips as inconsistent when readings inside the window disagree', () => {
		const plan = planOdometerFill(
			[draft()],
			[reading('2026-09-23T09:00:00Z', 118204), reading('2026-09-23T10:00:00Z', 118210)],
			[],
			null,
			NOW
		);
		expect(plan.skip).toEqual([{ id: 10, reason: 'inconsistent' }]);
	});

	it('treats a still-charging session as running until now', () => {
		const plan = planOdometerFill(
			[draft({ endedAt: null })],
			[reading('2026-09-24T08:55:00Z', 118204)],
			[],
			null,
			NOW
		);
		expect(plan.fill).toHaveLength(1);
	});

	it('suggests the latest reading before plug-in when none fall inside', () => {
		const plan = planOdometerFill(
			[draft()],
			[reading('2026-09-23T06:00:00Z', 118190), reading('2026-09-23T08:00:00Z', 118204)],
			[],
			null,
			NOW
		);
		expect(plan.suggest).toEqual([{ id: 10, km: 118204, carReportedAt: '2026-09-23T08:00:00Z' }]);
		expect(plan.fill).toEqual([]);
	});

	it('skips as no_data with no readings at all', () => {
		const plan = planOdometerFill([draft()], [], [], null, NOW);
		expect(plan.skip).toEqual([{ id: 10, reason: 'no_data' }]);
	});

	it('skips as too_old when the charge started before recorder history', () => {
		const plan = planOdometerFill(
			[draft({ startedAt: '2026-09-10T08:00:00Z', endedAt: '2026-09-10T12:00:00Z' })],
			[reading('2026-09-10T09:00:00Z', 118000)],
			[],
			'2026-09-14T03:00:00+00:00',
			NOW
		);
		expect(plan.skip).toEqual([{ id: 10, reason: 'too_old' }]);
	});

	it("skips a value below the previous session's odometer", () => {
		const neighbours = [
			{ id: 1, date: '2026-09-20', time: '18:00', odometerKm: 118300, kwhUsed: 20 },
			{ id: 10, date: '2026-09-23', time: '18:45', odometerKm: null, kwhUsed: 12 }
		];
		const plan = planOdometerFill(
			[draft()],
			[reading('2026-09-23T09:00:00Z', 118204)],
			neighbours,
			null,
			NOW
		);
		expect(plan.skip).toEqual([{ id: 10, reason: 'below_previous' }]);
	});

	it("doesn't compare against a session logged after the draft", () => {
		const neighbours = [
			{ id: 1, date: '2026-09-20', time: '18:00', odometerKm: 118100, kwhUsed: 20 },
			{ id: 10, date: '2026-09-23', time: '18:45', odometerKm: null, kwhUsed: 12 },
			{ id: 2, date: '2026-09-24', time: '08:00', odometerKm: 118300, kwhUsed: 5 }
		];
		const plan = planOdometerFill(
			[draft()],
			[reading('2026-09-23T09:00:00Z', 118204)],
			neighbours,
			null,
			NOW
		);
		expect(plan.fill).toHaveLength(1);
	});

	it('also applies the neighbour check to a suggestion', () => {
		const neighbours = [
			{ id: 1, date: '2026-09-20', time: '18:00', odometerKm: 118300, kwhUsed: 20 }
		];
		const plan = planOdometerFill(
			[draft()],
			[reading('2026-09-23T08:00:00Z', 118204)],
			neighbours,
			null,
			NOW
		);
		expect(plan.skip).toEqual([{ id: 10, reason: 'below_previous' }]);
	});

	it('matches several drafts against one response', () => {
		const plan = planOdometerFill(
			[
				draft({ id: 1, startedAt: '2026-09-21T09:00:00Z', endedAt: '2026-09-21T13:00:00Z' }),
				draft({ id: 2 }),
				draft({ id: 3, startedAt: '2026-09-24T02:00:00Z', endedAt: '2026-09-24T05:00:00Z' })
			],
			toReadings(response()),
			[],
			null,
			NOW
		);
		// 1: nothing reported during it, latest before is the start-state reading.
		expect(plan.suggest).toEqual([
			{ id: 1, km: 118102, carReportedAt: '2026-09-20T22:59:31.000Z' },
			{ id: 3, km: 118251, carReportedAt: '2026-09-23T22:09:50.000Z' }
		]);
		expect(plan.fill).toEqual([{ id: 2, km: 118204, carReportedAt: '2026-09-23T09:15:03.000Z' }]);
	});

	it('compares instants across a DST change', () => {
		// Sydney springs forward at 2026-10-04 02:00 local (16:00Z on the 3rd). A
		// charge from 01:30 to 03:30 local wall-clock is only one real hour long.
		const plan = planOdometerFill(
			[
				draft({
					date: '2026-10-04',
					time: '01:30',
					startedAt: '2026-10-03T15:30:00Z',
					endedAt: '2026-10-03T16:30:00Z'
				})
			],
			[reading('2026-10-03T16:15:00Z', 118500), reading('2026-10-03T16:45:00Z', 118520)],
			[],
			null,
			new Date('2026-10-04T00:00:00Z')
		);
		expect(plan.fill).toEqual([{ id: 10, km: 118500, carReportedAt: '2026-10-03T16:15:00Z' }]);
	});
});

describe('requestWindow', () => {
	it('spans from the earliest startedAt until now', () => {
		expect(
			requestWindow(
				[{ startedAt: '2026-09-23T08:45:00Z' }, { startedAt: '2026-09-21T09:00:00Z' }],
				NOW
			)
		).toEqual({ start: '2026-09-21T09:00:00.000Z', end: '2026-09-24T09:00:00.000Z' });
	});

	it('clamps to 31 days back', () => {
		expect(requestWindow([{ startedAt: '2026-01-01T00:00:00Z' }], NOW)).toEqual({
			start: '2026-08-24T09:00:00.000Z',
			end: '2026-09-24T09:00:00.000Z'
		});
	});

	it('is null with no drafts', () => {
		expect(requestWindow([], NOW)).toBeNull();
	});
});

describe('validateBaseUrl', () => {
	it.each([
		['https://ha.example.com', 'https://ha.example.com'],
		['https://ha.example.com/', 'https://ha.example.com'],
		['  https://ha.example.com:8443/  ', 'https://ha.example.com:8443'],
		['http://192.168.1.20:8123', 'http://192.168.1.20:8123'],
		['http://10.0.0.5:8123', 'http://10.0.0.5:8123'],
		['http://172.16.0.1:8123', 'http://172.16.0.1:8123'],
		['http://localhost:8123', 'http://localhost:8123'],
		['http://[fd00::1]:8123', 'http://[fd00::1]:8123']
	])('accepts %j', (input, expected) => {
		expect(validateBaseUrl(input)).toEqual({ ok: true, baseUrl: expected });
	});

	it.each([
		'http://ha.example.com',
		'http://homeassistant.local:8123',
		'http://8.8.8.8',
		'http://172.32.0.1',
		'ftp://ha.example.com',
		'ha.example.com',
		'https://user:pass@ha.example.com'
	])('rejects %j', (input) => {
		expect(validateBaseUrl(input).ok).toBe(false);
	});
});

describe('carOdometerAlert', () => {
	const base = {
		enabled: true,
		secret: 's',
		lastReadStatus: 'ok' as const,
		lastSuccessAt: '2026-09-24T08:00:00Z'
	};

	it('is null while healthy, switched off, or not set up', () => {
		expect(carOdometerAlert(base, NOW)).toBeNull();
		expect(carOdometerAlert(undefined, NOW)).toBeNull();
		expect(
			carOdometerAlert({ ...base, enabled: false, lastReadStatus: 'auth_failed' }, NOW)
		).toBeNull();
		expect(
			carOdometerAlert({ ...base, secret: null, lastReadStatus: 'auth_failed' }, NOW)
		).toBeNull();
	});

	it.each(['auth_failed', 'companion_missing', 'companion_outdated'] as const)(
		'is broken for %s',
		(status) => {
			expect(isBrokenStatus(status)).toBe(true);
			expect(carOdometerAlert({ ...base, lastReadStatus: status }, NOW)).toMatchObject({
				kind: 'broken',
				status,
				href: '/settings'
			});
		}
	);

	it('names the rejected secret for auth_failed', () => {
		expect(carOdometerAlert({ ...base, lastReadStatus: 'auth_failed' }, NOW)?.message).toBe(
			"Car odometer paused — Home Assistant rejected the secret. Odometers won't fill from the car until it's fixed."
		);
	});

	it('does not banner a fresh transient failure', () => {
		expect(
			carOdometerAlert(
				{ ...base, lastReadStatus: 'unreachable', lastSuccessAt: '2026-09-22T09:00:01Z' },
				NOW
			)
		).toBeNull();
	});

	it('escalates to a banner after 3 days without a successful read', () => {
		expect(
			carOdometerAlert(
				{ ...base, lastReadStatus: 'unreachable', lastSuccessAt: '2026-09-21T09:00:00Z' },
				NOW
			)
		).toMatchObject({ kind: 'unreachable', since: '2026-09-21T09:00:00Z' });
	});

	it('does not escalate once a read succeeds again', () => {
		expect(
			carOdometerAlert(
				{ ...base, lastReadStatus: 'ok', lastSuccessAt: '2026-09-24T08:59:00Z' },
				NOW
			)
		).toBeNull();
	});

	it('treats no_data as neither broken nor unreachable', () => {
		expect(isBrokenStatus('no_data')).toBe(false);
		expect(
			carOdometerAlert(
				{ ...base, lastReadStatus: 'no_data', lastSuccessAt: '2026-09-01T00:00:00Z' },
				NOW
			)
		).toBeNull();
	});
});
