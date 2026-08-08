// The only place in the app that calls fetch() against the Evnex consumer Cloud API
// (client-api.evnex.io). Talks in the wire shapes documented in
// foundational/EVNEX-INTEGRATION-PLAN.md §4.4-4.7 and normalises them into the flat
// shapes evnex.ts and the route expect. Token acquisition/refresh lives in
// evnex-auth.ts (Cognito) — this file only ever uses an already-issued access token.
//
// This API is unofficial and has no published spec (plan §4.0). fetchOrgId, the
// charge-points list envelope in fetchChargePoints, and the charge-point detail
// envelope in fetchChargePointDetailTimeZone are now CONFIRMED against a live account
// (2026-08) — see each function's doc comment for its exact shape; notably the list
// endpoint is flat objects under `data.items` while the detail endpoint is JSON:API
// `data.attributes.{…}`, so the two are NOT parsed the same way. fetchSessions remains
// UNVERIFIED. Every parse below stays defensive (skip a malformed item rather than
// crash the whole poll, per plan §4.0/§6.5) since the API can change without notice
// regardless.
import type { EvnexSessionPayload, EvnexSessionStatus } from './evnex';

const API_BASE = 'https://client-api.evnex.io';

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

/**
 * A 401 specifically. The caller (the `?/pollEvnex` route) should refresh the access
 * token via evnex-auth.ts and retry the same call exactly once, then give up — never
 * loop (plan §4.3/§6.6 step 2/4). A token can be invalidated before its nominal
 * expiry, so this can fire even when `isTokenExpired` said the token was still good.
 */
export class EvnexUnauthorizedError extends EvnexApiError {
	constructor(options?: { correlationId?: string }) {
		super('Evnex rejected the access token (401).', 401, options);
		this.name = 'EvnexUnauthorizedError';
	}
}

export class EvnexNetworkError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'EvnexNetworkError';
	}
}

async function evnexFetch(path: string, accessToken: string): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE}${path}`, {
			headers: {
				// The single most surprising trait of this API (plan §4.3): the BARE
				// access token, never `Bearer <token>`. Adding the conventional Bearer
				// prefix is the single most likely cause of an otherwise-inexplicable
				// 401 — do not "fix" this to look more standard.
				Authorization: accessToken
			}
		});
	} catch (err) {
		throw new EvnexNetworkError(`Could not reach Evnex (${path}).`, { cause: err });
	}

	const correlationId = response.headers.get('x-correlation-id') ?? undefined;

	if (response.status === 401) {
		throw new EvnexUnauthorizedError({ correlationId });
	}
	if (!response.ok) {
		// A summarised message plus the correlation id only — never the raw response
		// body. This is rendered directly on /settings as `lastPollError` (plan
		// §7.1's "never send secrets to the browser"), and some APIs echo request
		// details (potentially including headers) back in error payloads.
		throw new EvnexApiError(`Evnex returned ${response.status} for ${path}.`, response.status, {
			correlationId
		});
	}

	try {
		return await response.json();
	} catch (err) {
		throw new EvnexApiError(
			`Evnex returned an unparseable response for ${path}.`,
			response.status,
			{ cause: err, correlationId }
		);
	}
}

/**
 * GET /v2/apps/user — the account's organisations. Takes the first unless the account
 * has several (plan §4.4). Cached by the caller on the integration row so a poll
 * doesn't need this extra round trip every time.
 */
export async function fetchOrgId(accessToken: string): Promise<string> {
	const body = await evnexFetch('/v2/apps/user', accessToken);
	const organisations = (body as { data?: { organisations?: unknown } })?.data?.organisations;
	const first = Array.isArray(organisations) ? organisations[0] : undefined;
	if (!first || typeof (first as { id?: unknown }).id !== 'string') {
		// Shape mismatch against a live account — this endpoint contract is unverified
		// (see the module doc comment). Log the actual body server-side (never rendered
		// to the browser) so the real shape can be diagnosed from container logs.
		console.error('[evnex] unexpected /v2/apps/user response shape:', JSON.stringify(body));
		throw new EvnexApiError('Evnex user response has no organisations.', 502);
	}
	return (first as { id: string }).id;
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
 * GET /v2/apps/organisations/{orgId}/charge-points — confirmed live shape (2026-08):
 * `{ data: { items: [ { id, name, location, connectors, details, … } ] } }`, flat
 * fields, NOT the plan's original JSON:API `{ data: [ { attributes: {…} } ] }` guess.
 * No `timeZone` field anywhere on the list item — see fetchChargePointDetail.
 */
export async function fetchChargePoints(
	accessToken: string,
	orgId: string
): Promise<EvnexChargePointInfo[]> {
	const body = await evnexFetch(`/v2/apps/organisations/${orgId}/charge-points`, accessToken);
	const items = (body as { data?: { items?: unknown } })?.data?.items;
	if (!Array.isArray(items)) {
		// See the matching comment in fetchOrgId — same reasoning, same log-don't-render
		// approach so the real shape can be read from container logs.
		console.error('[evnex] unexpected charge-points response shape:', JSON.stringify(body));
		throw new EvnexApiError('Evnex charge-points response was not a list.', 502);
	}

	const ids: { id: string; name: string }[] = [];
	for (const item of items) {
		const record = item as { id?: unknown; name?: unknown };
		if (typeof record?.id !== 'string' || typeof record.name !== 'string') {
			continue; // malformed entry — skip rather than crash the whole poll (plan §4.0)
		}
		ids.push({ id: record.id, name: record.name });
	}

	// The list endpoint carries no timeZone (confirmed live, see the doc comment above),
	// matching the plan's fallback at §4.5: fetch each charger's detail instead. A home
	// setup has one charger, so this is at most a couple of extra round trips.
	return Promise.all(
		ids.map(async ({ id, name }) => ({
			id,
			name,
			timeZone: await fetchChargePointDetailTimeZone(accessToken, id)
		}))
	);
}

/**
 * GET /charge-points/{chargePointId} — note NO `/v2/apps` prefix (same asymmetry as
 * fetchSessions, per plan §4.4). Confirmed live (2026-08): unlike the flat list
 * envelope in fetchChargePoints, this endpoint IS JSON:API-shaped —
 * `data.attributes.timeZone` (e.g. "Australia/Melbourne"), a sibling of `name`/
 * `serial`/`model`. python-evnex's `loadSchedule.timezone` field does not appear in
 * the real response; ignore that model for this purpose. Never throws: a charger with
 * an unreachable or malformed detail response just gets an empty timezone, which
 * `saveEvnex` already refuses to persist.
 */
async function fetchChargePointDetailTimeZone(
	accessToken: string,
	chargePointId: string
): Promise<string> {
	try {
		const body = await evnexFetch(`/charge-points/${chargePointId}`, accessToken);
		const timeZone = (body as { data?: { attributes?: { timeZone?: unknown } } })?.data?.attributes
			?.timeZone;
		if (typeof timeZone !== 'string' || !timeZone) {
			console.error(
				`[evnex] charge-point ${chargePointId} detail response has no attributes.timeZone:`,
				JSON.stringify(body)
			);
			return '';
		}
		return timeZone;
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

function asKnownStatus(value: unknown): EvnexSessionStatus | null {
	return typeof value === 'string' && (KNOWN_STATUSES as readonly string[]).includes(value)
		? (value as EvnexSessionStatus)
		: null;
}

/**
 * kWh = (transaction.meterStop − transaction.meterStart) / 1000, in watt-hours (plan
 * §4.6/§4.7) — NOT the undocumented `totalEnergyUsage` figure, whose unit is unknown.
 * Null when there's no `transaction` object at all, or `meterStop` is absent (charging
 * still in progress) — both mean "not known yet," never "zero." `meterStart`/
 * `meterStop` of `0` are legitimate register readings, not falsy sentinels, so this
 * only treats *missing* fields as absent, not zero ones.
 */
function deriveEnergyKwh(transaction: unknown): number | null {
	if (transaction == null || typeof transaction !== 'object') return null;
	const t = transaction as { meterStart?: unknown; meterStop?: unknown };
	if (typeof t.meterStart !== 'number' || typeof t.meterStop !== 'number') return null;
	return (t.meterStop - t.meterStart) / 1000;
}

/**
 * GET /charge-points/{chargePointId}/sessions — note NO `/v2/apps` prefix, unlike the
 * other two endpoints (plan §4.4, confirmed real asymmetry not a transcription slip).
 * Takes no parameters: no date range, no pagination — the lookback window is enforced
 * entirely client-side by `planImport` (plan §4.4/§6.2).
 */
export async function fetchSessions(
	accessToken: string,
	chargePointId: string
): Promise<EvnexSessionPayload[]> {
	const body = await evnexFetch(`/charge-points/${chargePointId}/sessions`, accessToken);
	const items = (body as { data?: unknown })?.data;
	if (!Array.isArray(items)) {
		// See the matching comment in fetchOrgId — same reasoning, same log-don't-render
		// approach so the real shape can be read from container logs.
		console.error('[evnex] unexpected sessions response shape:', JSON.stringify(body));
		throw new EvnexApiError('Evnex sessions response was not a list.', 502);
	}

	const sessions: EvnexSessionPayload[] = [];
	for (const item of items) {
		const record = item as {
			id?: unknown;
			attributes?: { startDate?: unknown; sessionStatus?: unknown; transaction?: unknown };
		};
		if (typeof record?.id !== 'string') continue; // unusable without an id to dedupe on
		const attrs = record.attributes ?? {};
		sessions.push({
			id: record.id,
			startDate: typeof attrs.startDate === 'string' ? attrs.startDate : null,
			sessionStatus: asKnownStatus(attrs.sessionStatus),
			energyKwh: deriveEnergyKwh(attrs.transaction)
		});
	}
	return sessions;
}
