// The only place in the app that calls the car-odometer companion Home Assistant
// integration (brianramseyau/ev-charging-log-hass): one GET, a 10 s timeout, and
// response validation via car-odometer.ts's `parseCompanionResponse`. The HTTP
// contract is documented in the companion's README and in
// foundational/BYD-INTEGRATION-PLAN.md §4.3 — nothing else couples the two repos.
//
// The secret goes in the Authorization header and nowhere else: never into a URL,
// an error message, or a log line.
import { randomBytes } from 'node:crypto';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { COMPANION_VERSION, parseCompanionResponse, type CompanionResponse } from './car-odometer';

/** Generous for a LAN call, because the desktop app away from home goes via the HA Cloud relay. */
const TIMEOUT_MS = 10_000;

export type CarOdometerFailure =
	'auth_failed' | 'companion_missing' | 'companion_outdated' | 'unreachable';

export class CarOdometerError extends Error {
	status: CarOdometerFailure;
	constructor(status: CarOdometerFailure, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'CarOdometerError';
		this.status = status;
	}
}

/** 32 random bytes, base64url: 43 characters, above the companion's 32-character minimum. */
export function generateSecret(): string {
	return randomBytes(32).toString('base64url');
}

/**
 * Asks the companion for odometer history. With no `start`/`end`, the companion
 * returns just the current state (Read from car). Throws `CarOdometerError`,
 * whose `status` is what the caller records on the integration row.
 */
export async function fetchOdometerHistory(
	baseUrl: string,
	secret: string,
	window?: { start: string; end: string }
): Promise<CompanionResponse> {
	if (dev && env.CAR_ODOMETER_FAKE) return fakeResponse(env.CAR_ODOMETER_FAKE, window);

	const url = new URL(`${baseUrl}/api/ev_charging_log/odometer`);
	if (window) {
		url.searchParams.set('start', window.start);
		url.searchParams.set('end', window.end);
	}

	let res: Response;
	try {
		res = await fetch(url, {
			headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
			redirect: 'error'
		});
	} catch (err) {
		throw new CarOdometerError('unreachable', describeFetchError(err), { cause: err });
	}

	if (res.status === 401) {
		throw new CarOdometerError(
			'auth_failed',
			"Home Assistant rejected the secret — paste it again in the companion's settings in Home Assistant."
		);
	}
	if (res.status === 404) {
		throw new CarOdometerError(
			'companion_missing',
			"The Home Assistant companion isn't installed or set up (Home Assistant returned 404)."
		);
	}
	if (!res.ok) {
		throw new CarOdometerError('unreachable', `Home Assistant returned ${res.status}.`);
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch (err) {
		throw new CarOdometerError(
			'unreachable',
			"Home Assistant's response wasn't JSON — is the URL pointing at Home Assistant?",
			{ cause: err }
		);
	}

	const parsed = parseCompanionResponse(body);
	if (!parsed.ok) {
		throw new CarOdometerError(
			'companion_outdated',
			parsed.reason === 'outdated'
				? `Update the Home Assistant companion — it answered with response version ${JSON.stringify(parsed.version ?? null)}, and this app needs version ${COMPANION_VERSION}.`
				: `Update the Home Assistant companion — its response wasn't understood (${parsed.detail}).`
		);
	}
	return parsed.response;
}

function describeFetchError(err: unknown): string {
	if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
		return `Home Assistant unreachable — no answer within ${TIMEOUT_MS / 1000} s.`;
	}
	// undici puts the useful part (ENOTFOUND, ECONNREFUSED, a certificate error)
	// on `cause`. Neither carries the request headers, so the secret can't leak here.
	const cause = err instanceof Error ? (err.cause as { code?: string; message?: string }) : null;
	const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : '');
	return `Home Assistant unreachable${detail ? ` (${detail})` : ''}.`;
}

// --- Dev-only fake (plan §9) ----------------------------------------------------
//
// `CAR_ODOMETER_FAKE` in .env, dev server only — never read by a production build,
// and not a deployment setting. `1` serves a synthetic history; `401`, `404`,
// `outdated` and `unreachable` simulate each failure, so every UI state can be
// screenshotted without a real Home Assistant.

const FAKE_BASE_KM = Number(env.CAR_ODOMETER_FAKE_KM) || 45_000;
const FAKE_DAILY_KM = 42;
const FAKE_POLL_MS = 5 * 60 * 1000;
const FAKE_EPOCH = Date.parse('2026-01-01T00:00:00Z');

/**
 * The car drives once a day, at 06:00 UTC (late afternoon in Australia), and
 * sits still otherwise — so an overnight home charge sees a steady odometer.
 */
function fakeKmAt(ms: number): number {
	const drives = Math.floor((ms - FAKE_EPOCH - 6 * 3600_000) / (24 * 3600_000));
	return FAKE_BASE_KM + Math.max(0, drives) * FAKE_DAILY_KM;
}

async function fakeResponse(
	mode: string,
	window?: { start: string; end: string }
): Promise<CompanionResponse> {
	await new Promise((resolve) => setTimeout(resolve, 400));
	if (mode === '401') throw new CarOdometerError('auth_failed', 'Fake: secret rejected (401).');
	if (mode === '404')
		throw new CarOdometerError('companion_missing', 'Fake: companion missing (404).');
	if (mode === 'outdated') {
		throw new CarOdometerError('companion_outdated', 'Fake: companion response version 2.');
	}
	if (mode === 'unreachable') {
		throw new CarOdometerError('unreachable', 'Home Assistant unreachable (fake).');
	}

	const now = Date.now();
	const end = window ? Date.parse(window.end) : now;
	const start = window ? Date.parse(window.start) : end;
	// The car's own clock runs a few minutes behind HA's poll.
	const lag = 7 * 60 * 1000;
	const odometer: CompanionResponse['odometer']['changes'] = [];
	const telemetry: CompanionResponse['telemetry']['changes'] = [];
	for (let t = start; t <= end; t += FAKE_POLL_MS) {
		const at = new Date(t).toISOString();
		const km = String(fakeKmAt(t - lag));
		if (odometer.length === 0 || odometer[odometer.length - 1].state !== km) {
			odometer.push({ state: km, at });
		}
		telemetry.push({ state: new Date(t - lag).toISOString(), at });
		if (telemetry.length > 20_000) break;
	}
	return {
		version: COMPANION_VERSION,
		odometer: { unit: 'km', changes: odometer },
		telemetry: { changes: telemetry },
		oldestRecorded: new Date(now - 10 * 24 * 3600_000).toISOString()
	};
}
