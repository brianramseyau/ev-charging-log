// The only place in the app that calls the Evnex consumer Cloud API — via the
// `evnex-client` npm package's `Evnex` client, not a hand-rolled fetch wrapper.
// `clientFor` turns an `EvnexAuth` (built by `evnex-token.ts`'s `sessionFor`, which
// owns persisting refreshed tokens back to the database) into a client whose calls
// authenticate, proactively/reactively refresh, and retry-once-on-401 entirely
// inside the SDK — this file has no token-refresh logic of its own any more.
//
// This is an unofficial, undocumented API (there is no published spec) that can
// change without notice; the package's own parsing (zod schemas) is what stays
// defensive against that now, rather than the hand-written shape-guards this file
// used to contain.
import {
	Evnex,
	EvnexAuthError,
	EvnexHttpError,
	EvnexTimeoutError,
	sessionEnergyWh
} from 'evnex-client';
import type { EvnexAuth } from 'evnex-client/auth';
import { EvnexNetworkError, EvnexRefreshExpiredError } from './evnex-auth';
import type { EvnexSessionPayload, EvnexSessionStatus } from './evnex';

export class EvnexApiError extends Error {
	status: number;
	correlationId?: string;
	constructor(
		message: string,
		status: number,
		options?: { cause?: unknown; correlationId?: string }
	) {
		super(message, options);
		this.name = 'EvnexApiError';
		this.status = status;
		this.correlationId = options?.correlationId;
	}
}

export function clientFor(auth: EvnexAuth): Evnex {
	return new Evnex({ auth });
}

/**
 * Maps a package-level failure onto this file's own error classes.
 * `EvnexAuthError` (most commonly `ReauthenticationRequiredError`, from the SDK's
 * own exhausted refresh-and-retry) becomes `EvnexRefreshExpiredError` — the same
 * terminal "reconnect" signal `evnex-auth.ts` already produces for a failed
 * resumed-session refresh, so callers only ever branch on one class regardless of
 * which layer detected it.
 */
function toClientError(err: unknown, path: string): Error {
	if (err instanceof EvnexHttpError) {
		return new EvnexApiError(`Evnex returned ${err.status} for ${path}.`, err.status, {
			cause: err,
			correlationId: err.correlationId
		});
	}
	if (err instanceof EvnexTimeoutError) {
		return new EvnexNetworkError(`Could not reach Evnex (${path}).`, { cause: err });
	}
	if (err instanceof EvnexAuthError) {
		return new EvnexRefreshExpiredError({ cause: err });
	}
	return new EvnexNetworkError(`Could not reach Evnex (${path}).`, { cause: err });
}

/**
 * The account's organisations, via the package's `getUserDetail`. Takes the first
 * unless the account has several. Cached by the caller on the integration row so a
 * poll doesn't need this extra round trip every time.
 */
export async function fetchOrgId(client: Evnex): Promise<string> {
	try {
		const detail = await client.getUserDetail();
		const first = detail.organisations[0];
		if (!first) {
			throw new EvnexApiError('Evnex user response has no organisations.', 502);
		}
		return first.id;
	} catch (err) {
		if (err instanceof EvnexApiError) throw err;
		throw toClientError(err, '/v2/apps/user');
	}
}

export interface EvnexChargePointInfo {
	id: string;
	name: string;
	/** IANA timezone, e.g. "Pacific/Auckland" (plan §6.3). Empty string if the detail
	 *  fetch for this charger failed or didn't carry one. The caller must not proceed
	 *  with an empty timezone. */
	timeZone: string;
}

/**
 * The org's charge points, via the package's `getOrgChargePoints`. No `timeZone`
 * field anywhere on the list item — see `fetchChargePointDetailTimeZone` below.
 */
export async function fetchChargePoints(
	client: Evnex,
	orgId: string
): Promise<EvnexChargePointInfo[]> {
	let chargePoints;
	try {
		chargePoints = await client.getOrgChargePoints(orgId);
	} catch (err) {
		throw toClientError(err, `/v2/apps/organisations/${orgId}/charge-points`);
	}

	// The list endpoint carries no timeZone, matching the plan's fallback at §4.5:
	// fetch each charger's detail instead. A home setup has one charger, so this is
	// at most a couple of extra round trips.
	return Promise.all(
		chargePoints.map(async ({ id, name }) => ({
			id,
			name,
			timeZone: await fetchChargePointDetailTimeZone(client, id)
		}))
	);
}

/**
 * A single charge point's detail, via the package's `getChargePointDetailV3`. Never
 * throws: a charger with an unreachable or malformed detail response just gets an
 * empty timezone, which `saveEvnex` already refuses to persist.
 */
async function fetchChargePointDetailTimeZone(
	client: Evnex,
	chargePointId: string
): Promise<string> {
	try {
		const detail = await client.getChargePointDetailV3(chargePointId);
		return detail.data.attributes.timeZone || '';
	} catch (err) {
		console.error(`[evnex] charge-point ${chargePointId} detail fetch failed:`, err);
		return '';
	}
}

const KNOWN_STATUSES: readonly EvnexSessionStatus[] = [
	'Pending',
	'Authorized',
	'Active',
	'Closed',
	'Completed',
	'Invalid'
];

function asKnownStatus(value: string | null | undefined): EvnexSessionStatus | null {
	return typeof value === 'string' && (KNOWN_STATUSES as readonly string[]).includes(value)
		? (value as EvnexSessionStatus)
		: null;
}

/**
 * A charge point's recent sessions, via the package's `getChargePointSessions`.
 * Takes no parameters: no date range, no pagination — the lookback window is
 * enforced entirely client-side by `planImport` (plan §4.4/§6.2).
 *
 * Energy is the package's own `sessionEnergyWh` (the authoritative meter-delta
 * figure, watt-hours — divided by 1000 here for this app's kWh field), never the
 * undocumented `totalEnergyUsage` figure; same null-while-charging and
 * zero-is-a-real-reading semantics as before (plan §4.6/§4.7).
 */
export async function fetchSessions(
	client: Evnex,
	chargePointId: string
): Promise<EvnexSessionPayload[]> {
	let sessions;
	try {
		sessions = await client.getChargePointSessions(chargePointId);
	} catch (err) {
		throw toClientError(err, `/charge-points/${chargePointId}/sessions`);
	}

	return sessions.map((session) => {
		const wh = sessionEnergyWh(session);
		return {
			id: session.id,
			// The package parses startDate as a real Date (z.coerce.date()), unlike this
			// app's own EvnexSessionPayload, which keeps it as the raw ISO string
			// toLocalDateTime (evnex.ts) expects — convert back.
			startDate: session.attributes.startDate?.toISOString() ?? null,
			sessionStatus: asKnownStatus(session.attributes.sessionStatus),
			energyKwh: wh === null ? null : wh / 1000
		};
	});
}
