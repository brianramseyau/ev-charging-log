// Calls the car-odometer companion and records the outcome on the integration row.
// Like evnex-token.ts, a deliberate, narrow exception to AGENTS.md's "only routes
// import $lib/server/db" convention: both car-odometer endpoints (/settings' Test
// and /sessions' Read from car / auto-fill) must record every call identically —
// the §7.3 banner, nav dot and paused-calls rule are all driven by what's recorded
// here — so it lives in one place instead of two copies that could drift.
import { eq } from 'drizzle-orm';
import { db } from './db';
import { carOdometerIntegration } from './db/schema';
import {
	toReadings,
	type CarOdometerStatus,
	type CompanionResponse,
	type Reading
} from './car-odometer';
import { CarOdometerError, fetchOdometerHistory } from './car-odometer-client';

export type CarOdometerRow = typeof carOdometerIntegration.$inferSelect;

export async function getCarOdometerIntegration(): Promise<CarOdometerRow | undefined> {
	const [row] = await db.select().from(carOdometerIntegration).limit(1);
	return row;
}

export type CompanionReadResult =
	| { ok: true; response: CompanionResponse; readings: Reading[] }
	| { ok: false; status: Exclude<CarOdometerStatus, 'ok'>; message: string };

const NO_DATA_MESSAGE =
	"The companion answered, but had no usable odometer reading — check the Odometer sensor reports in km and isn't excluded from Home Assistant's recorder.";

/**
 * One call to the companion, recorded as `lastReadStatus`/`lastReadError` (and
 * `lastSuccessAt` on success). A response with no usable readings is recorded as
 * `no_data`, which is neither broken nor unreachable (plan §7.3).
 */
export async function readCompanion(
	row: CarOdometerRow & { baseUrl: string; secret: string },
	window?: { start: string; end: string }
): Promise<CompanionReadResult> {
	const now = new Date().toISOString();
	let result: CompanionReadResult;
	try {
		const response = await fetchOdometerHistory(row.baseUrl, row.secret, window);
		const readings = toReadings(response);
		result =
			readings.length > 0
				? { ok: true, response, readings }
				: { ok: false, status: 'no_data', message: NO_DATA_MESSAGE };
	} catch (err) {
		if (!(err instanceof CarOdometerError)) {
			console.error('[car-odometer] unexpected failure:', err);
		}
		result =
			err instanceof CarOdometerError
				? { ok: false, status: err.status, message: err.message }
				: { ok: false, status: 'unreachable', message: 'Something went wrong reading the car.' };
	}

	await db
		.update(carOdometerIntegration)
		.set(
			result.ok
				? { lastReadAt: now, lastSuccessAt: now, lastReadStatus: 'ok', lastReadError: null }
				: { lastReadAt: now, lastReadStatus: result.status, lastReadError: result.message }
		)
		.where(eq(carOdometerIntegration.id, row.id));

	return result;
}
