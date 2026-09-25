// Pure logic for the car-odometer integration: validating the companion Home
// Assistant integration's response, pairing its two state histories into
// readings, and deciding which draft sessions a reading fills. Kept
// dependency-free (no fetch, no db import) so it's cheap to unit test —
// `car-odometer-client.ts` talks to the network, `car-odometer-store.ts` and the
// two `car-odometer/+server.ts` endpoints wire this to Drizzle. See
// foundational/BYD-INTEGRATION-PLAN.md §6.
import type { IntegrationAlert } from '$lib/integration-alert';
import { isOdometerBelowLastRecorded, sortByDateTimeAsc, type SessionRow } from './sessions';

/** The only companion response `version` this app understands (plan §4.3). */
export const COMPANION_VERSION = 1;

/** The companion rejects a wider window with a 400 (plan §4.3). */
export const MAX_WINDOW_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far after a telemetry change an odometer change can be recorded and still
 * count as the same Home Assistant poll. `hass-byd-vehicle` updates both
 * entities from one coordinator refresh, but HA writes them as two separate
 * state changes whose `last_changed` differ by milliseconds, in either order.
 * Without this, a poll that brought a new odometer *and* a new car timestamp
 * could pair the new timestamp with the previous odometer value. The poll
 * interval is 300 s, so a few seconds can't reach into the next poll.
 */
export const SAME_POLL_TOLERANCE_MS = 5_000;

export interface CompanionChange {
	state: string;
	at: string;
}

export interface CompanionResponse {
	version: number;
	odometer: { unit: string | null; changes: CompanionChange[] };
	telemetry: { changes: CompanionChange[] };
	oldestRecorded: string | null;
}

export type ParseResult =
	| { ok: true; response: CompanionResponse }
	| { ok: false; reason: 'outdated'; version: unknown }
	| { ok: false; reason: 'malformed'; detail: string };

function isChangeList(value: unknown): value is CompanionChange[] {
	return (
		Array.isArray(value) &&
		value.every(
			(c) =>
				c != null &&
				typeof c === 'object' &&
				typeof (c as CompanionChange).state === 'string' &&
				typeof (c as CompanionChange).at === 'string'
		)
	);
}

/**
 * Validates a decoded companion response body. The `version` check runs first:
 * a companion on a different contract version may have a different shape
 * altogether, and "update the companion" is the useful message then, not
 * "malformed".
 */
export function parseCompanionResponse(body: unknown): ParseResult {
	if (body == null || typeof body !== 'object' || Array.isArray(body)) {
		return { ok: false, reason: 'malformed', detail: 'response is not a JSON object' };
	}
	const b = body as Record<string, unknown>;
	if (b.version !== COMPANION_VERSION) {
		return { ok: false, reason: 'outdated', version: b.version };
	}

	const odometer = b.odometer as Record<string, unknown> | null | undefined;
	const telemetry = b.telemetry as Record<string, unknown> | null | undefined;
	if (odometer == null || typeof odometer !== 'object' || !isChangeList(odometer.changes)) {
		return { ok: false, reason: 'malformed', detail: 'missing or invalid "odometer"' };
	}
	if (telemetry == null || typeof telemetry !== 'object' || !isChangeList(telemetry.changes)) {
		return { ok: false, reason: 'malformed', detail: 'missing or invalid "telemetry"' };
	}
	if (odometer.unit != null && typeof odometer.unit !== 'string') {
		return { ok: false, reason: 'malformed', detail: 'invalid "odometer.unit"' };
	}
	if (b.oldestRecorded != null && typeof b.oldestRecorded !== 'string') {
		return { ok: false, reason: 'malformed', detail: 'invalid "oldestRecorded"' };
	}

	return {
		ok: true,
		response: {
			version: COMPANION_VERSION,
			odometer: { unit: (odometer.unit as string | null) ?? null, changes: odometer.changes },
			telemetry: { changes: telemetry.changes },
			oldestRecorded: (b.oldestRecorded as string | null) ?? null
		}
	};
}

export interface Reading {
	km: number;
	/** ISO UTC instant — when the *car* produced this data, not when HA recorded it. */
	carReportedAt: string;
}

function toInstant(value: string): number | null {
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function parseKm(state: string): number | null {
	if (state.trim() === '') return null;
	const km = Number(state);
	// `0` and `-1` are pyBYD's "no data" placeholders; `unavailable`/`unknown` are NaN.
	return Number.isFinite(km) && km > 0 ? km : null;
}

/**
 * Pairs the companion's two change lists into one reading per telemetry change
 * (plan §6.1):
 *
 * - `carReportedAt` is the telemetry change's *state* (the car's own timestamp),
 *   never its `at`. HA re-polls and re-records stale cloud data while the car
 *   sleeps; only the car's timestamp says when the car was in that state.
 * - `km` is the odometer state in effect at the telemetry change's `at`, allowing
 *   for `SAME_POLL_TOLERANCE_MS` of write ordering within one HA poll.
 * - Unusable states are dropped, and the whole list is empty unless the unit is
 *   exactly `km` — a miles/km mixup on a lease report is worse than a gap.
 * - Duplicate `carReportedAt` values collapse to one reading (the last recorded).
 *
 * Returned in ascending `carReportedAt` order.
 */
export function toReadings(response: CompanionResponse): Reading[] {
	if (response.odometer.unit !== 'km') return [];

	const odometer = response.odometer.changes
		.map((c) => ({ at: toInstant(c.at), km: parseKm(c.state) }))
		.filter((c): c is { at: number; km: number | null } => c.at != null)
		.sort((a, b) => a.at - b.at);

	const byReportedAt = new Map<number, Reading>();
	const telemetry = response.telemetry.changes
		.map((c) => ({ at: toInstant(c.at), reportedAt: toInstant(c.state) }))
		.filter((c): c is { at: number; reportedAt: number } => c.at != null && c.reportedAt != null)
		.sort((a, b) => a.at - b.at);

	for (const change of telemetry) {
		let km: number | null = null;
		for (const o of odometer) {
			if (o.at > change.at + SAME_POLL_TOLERANCE_MS) break;
			km = o.km;
		}
		if (km == null) continue;
		byReportedAt.set(change.reportedAt, {
			km,
			carReportedAt: new Date(change.reportedAt).toISOString()
		});
	}

	return [...byReportedAt.values()].sort((a, b) => a.carReportedAt.localeCompare(b.carReportedAt));
}

/** The most recent reading the car produced, or null. For Read from car. */
export function latestReading(readings: Reading[]): Reading | null {
	return readings.length === 0 ? null : readings[readings.length - 1];
}

export interface DraftForFill {
	id: number;
	date: string;
	time: string;
	startedAt: string;
	/** Null while the charge is still running — treated as `now`. */
	endedAt: string | null;
}

export type FillSkipReason = 'too_old' | 'no_data' | 'inconsistent' | 'below_previous';

export interface OdometerFillPlan {
	/** Proven: the car reported this odometer while the charge was running. */
	fill: { id: number; km: number; carReportedAt: string }[];
	/** Unproven: the latest reading before plug-in. Pre-filled, never saved automatically. */
	suggest: { id: number; km: number; carReportedAt: string }[];
	skip: { id: number; reason: FillSkipReason }[];
}

/**
 * Decides, per draft, whether a reading provably belongs to it (plan §6.2).
 *
 * The car can't move while it's charging, so a reading the car reported inside
 * `[startedAt, endedAt]` (inclusive) is that session's plug-in odometer:
 *
 * - `fill` — at least one reading inside the window, all with the same km, and
 *   not below the previous session's odometer.
 * - `suggest` — no reading inside the window, but the latest one before it
 *   passes the same neighbour check.
 * - `skip` — `too_old` (the window starts before `oldestRecorded`), `no_data`,
 *   `inconsistent` (readings disagree inside the window), or `below_previous`.
 *
 * Everything is compared as instants, never local wall-clock time. The BYD
 * charging-state sensors are deliberately not used as evidence (plan §6.2).
 *
 * `neighbours` is every session in the log; each draft is checked only against
 * those logged before it, since a later session's higher odometer is expected.
 */
export function planOdometerFill(
	drafts: DraftForFill[],
	readings: Reading[],
	neighbours: (SessionRow & { id: number })[],
	oldestRecorded: string | null,
	now: Date
): OdometerFillPlan {
	const plan: OdometerFillPlan = { fill: [], suggest: [], skip: [] };
	const oldest = oldestRecorded == null ? null : toInstant(oldestRecorded);
	const timed = readings
		.map((r) => ({ ...r, t: toInstant(r.carReportedAt) as number }))
		.filter((r) => Number.isFinite(r.t));
	const ordered = sortByDateTimeAsc(neighbours);

	for (const draft of drafts) {
		const start = toInstant(draft.startedAt);
		const end = draft.endedAt == null ? now.getTime() : toInstant(draft.endedAt);
		if (start == null || end == null) {
			plan.skip.push({ id: draft.id, reason: 'no_data' });
			continue;
		}
		if (oldest != null && start < oldest) {
			plan.skip.push({ id: draft.id, reason: 'too_old' });
			continue;
		}

		const inside = timed.filter((r) => r.t >= start && r.t <= end);
		let candidate: { km: number; carReportedAt: string };
		let outcome: 'fill' | 'suggest';
		if (inside.length > 0) {
			if (inside.some((r) => r.km !== inside[0].km)) {
				plan.skip.push({ id: draft.id, reason: 'inconsistent' });
				continue;
			}
			candidate = inside[0];
			outcome = 'fill';
		} else {
			const before = timed.filter((r) => r.t <= start);
			if (before.length === 0) {
				plan.skip.push({ id: draft.id, reason: 'no_data' });
				continue;
			}
			candidate = before[before.length - 1];
			outcome = 'suggest';
		}

		const draftIndex = ordered.findIndex((s) => s.id === draft.id);
		const earlier =
			draftIndex >= 0
				? ordered.slice(0, draftIndex)
				: ordered.filter((s) => s.date + s.time < draft.date + draft.time);
		if (isOdometerBelowLastRecorded(candidate.km, earlier)) {
			plan.skip.push({ id: draft.id, reason: 'below_previous' });
			continue;
		}

		plan[outcome].push({
			id: draft.id,
			km: candidate.km,
			carReportedAt: candidate.carReportedAt
		});
	}

	return plan;
}

/**
 * The single `[start, end]` request window covering every draft (plan §6.3):
 * from the earliest `startedAt`, clamped to `MAX_WINDOW_DAYS` back, until now.
 * Null when there's nothing to ask for.
 */
export function requestWindow(
	drafts: Pick<DraftForFill, 'startedAt'>[],
	now: Date
): { start: string; end: string } | null {
	const starts = drafts.map((d) => toInstant(d.startedAt)).filter((t): t is number => t != null);
	if (starts.length === 0) return null;
	const floor = now.getTime() - MAX_WINDOW_DAYS * DAY_MS;
	const start = Math.min(Math.max(Math.min(...starts), floor), now.getTime());
	return { start: new Date(start).toISOString(), end: now.toISOString() };
}

// --- URL validation (plan §4.5, §8) -------------------------------------------

function isPrivateIpv4(host: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
	return (
		a === 10 ||
		a === 127 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254)
	);
}

function isPrivateIpv6(host: string): boolean {
	// URL.hostname keeps the brackets for IPv6 literals.
	const h = host.replace(/^\[|\]$/g, '').toLowerCase();
	return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/**
 * Normalises and validates the Home Assistant base URL. `https://` is required;
 * plain `http://` is accepted only for `localhost` or a private-range IP address,
 * so the secret (sent as a header) can never cross the internet in plaintext.
 * Returns the URL without a trailing slash, path, query or fragment.
 */
export function validateBaseUrl(
	raw: string
): { ok: true; baseUrl: string } | { ok: false; error: string } {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return { ok: false, error: 'Enter a full URL, like https://ha.example.com.' };
	}
	if (url.username || url.password) {
		return { ok: false, error: "Don't put a username or password in the URL." };
	}
	if (url.protocol === 'http:') {
		const host = url.hostname.toLowerCase();
		if (host !== 'localhost' && !isPrivateIpv4(host) && !isPrivateIpv6(host)) {
			return {
				ok: false,
				error:
					'Use https:// — plain http:// is only allowed for localhost or a private IP address, so the secret never crosses the internet unencrypted.'
			};
		}
	} else if (url.protocol !== 'https:') {
		return { ok: false, error: 'The URL must start with https://.' };
	}
	const path = url.pathname.replace(/\/+$/, '');
	return { ok: true, baseUrl: `${url.protocol}//${url.host}${path}` };
}

// --- Status → alert (plan §7.3) -----------------------------------------------

export type CarOdometerStatus =
	'ok' | 'auth_failed' | 'unreachable' | 'companion_missing' | 'companion_outdated' | 'no_data';

export type BrokenStatus = 'auth_failed' | 'companion_missing' | 'companion_outdated';

/** Days without a successful read before a transient failure gets a banner. */
export const UNREACHABLE_ESCALATION_DAYS = 3;

/**
 * Broken statuses need the user to fix something and won't fix themselves.
 * While one is recorded, automatic calls to the companion stop until a
 * successful Test (plan §7.1).
 */
export function isBrokenStatus(status: CarOdometerStatus | null): status is BrokenStatus {
	return (
		status === 'auth_failed' || status === 'companion_missing' || status === 'companion_outdated'
	);
}

const BROKEN_REASONS: Record<BrokenStatus, string> = {
	auth_failed: 'Home Assistant rejected the secret',
	companion_missing: "The Home Assistant companion isn't installed or set up",
	companion_outdated: 'Update the Home Assistant companion'
};

const BANNER_REASONS: Record<BrokenStatus, string> = {
	auth_failed: 'Home Assistant rejected the secret',
	companion_missing: "the Home Assistant companion isn't installed or set up",
	companion_outdated: 'the Home Assistant companion needs updating'
};

/** Plain-words reason for a broken status, shared by the banner and the buttons. */
export function brokenReason(status: BrokenStatus): string {
	return BROKEN_REASONS[status];
}

export function carOdometerAlert(
	row:
		| {
				enabled: boolean;
				secret: string | null;
				lastReadStatus: CarOdometerStatus | null;
				lastSuccessAt: string | null;
		  }
		| undefined,
	now: Date
): IntegrationAlert | null {
	if (!row || !row.enabled || row.secret == null) return null;
	const status = row.lastReadStatus;

	if (isBrokenStatus(status)) {
		return {
			kind: 'broken',
			status,
			message: `Car odometer paused — ${BANNER_REASONS[status]}. Odometers won't fill from the car until it's fixed.`,
			since: null,
			href: '/settings'
		};
	}

	if (status === 'unreachable' && row.lastSuccessAt != null) {
		const lastSuccess = toInstant(row.lastSuccessAt);
		if (
			lastSuccess != null &&
			now.getTime() - lastSuccess >= UNREACHABLE_ESCALATION_DAYS * DAY_MS
		) {
			return {
				kind: 'unreachable',
				status,
				message: "Can't reach Home Assistant since",
				since: row.lastSuccessAt,
				href: '/settings'
			};
		}
	}

	return null;
}
