// The only place in the app that calls fetch() against the Evnex consumer Cloud API
// (client-api.evnex.io). Talks in the wire shapes documented in
// foundational/EVNEX-INTEGRATION-PLAN.md §4.4-4.7 and normalises them into the flat
// shapes evnex.ts and the route expect. Token acquisition/refresh lives in
// evnex-auth.ts (Cognito) — this file only ever uses an already-issued access token.
//
// UNVERIFIED AGAINST A LIVE ACCOUNT. This API is unofficial and has no published spec
// (plan §4.0) — the shapes below are taken from the plan, which states they were
// derived from hardbyte/python-evnex and cross-checked against the Enterprise OpenAPI
// definitions where the two overlap. Every parse below is defensive (skip a malformed
// item rather than crash the whole poll, per plan §4.0/§6.5) precisely because this
// hasn't been confirmed against a real response yet. Before trusting this integration
// against a real account: sign in once, capture one real charge-points response and
// one real sessions response, and confirm the field names below actually match —
// plan §10 phase 4 calls this out as the first thing to do, before anything else.
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
		throw new EvnexApiError('Evnex user response has no organisations.', 502);
	}
	return (first as { id: string }).id;
}

export interface EvnexChargePointInfo {
	id: string;
	name: string;
	/** IANA timezone, e.g. "Pacific/Auckland" (plan §6.3). Empty string if the list
	 *  response didn't carry one — see the module doc comment; this is one of the
	 *  unverified shapes. The caller must not proceed with an empty timezone. */
	timeZone: string;
}

/** GET /v2/apps/organisations/{orgId}/charge-points */
export async function fetchChargePoints(
	accessToken: string,
	orgId: string
): Promise<EvnexChargePointInfo[]> {
	const body = await evnexFetch(`/v2/apps/organisations/${orgId}/charge-points`, accessToken);
	const items = (body as { data?: unknown })?.data;
	if (!Array.isArray(items)) {
		throw new EvnexApiError('Evnex charge-points response was not a list.', 502);
	}

	const points: EvnexChargePointInfo[] = [];
	for (const item of items) {
		const record = item as { id?: unknown; attributes?: { name?: unknown; timeZone?: unknown } };
		if (typeof record?.id !== 'string' || typeof record.attributes?.name !== 'string') {
			continue; // malformed entry — skip rather than crash the whole poll (plan §4.0)
		}
		points.push({
			id: record.id,
			name: record.attributes.name,
			timeZone: typeof record.attributes.timeZone === 'string' ? record.attributes.timeZone : ''
		});
	}
	return points;
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
