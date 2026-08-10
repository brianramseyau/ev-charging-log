// In-memory cache for the Evnex charge-point list, shared between the
// /settings/charge-points endpoint and the connectEvnex action in
// /settings' +page.server.ts. Module-level state is fine here: this app is a
// single-user, single-process, self-hosted deployment (CLAUDE.md), so there's
// no multi-instance/serverless concern about the cache being process-local.
//
// Only successful fetches are cached — an error result is intentionally never
// stored, so the next normal (non-forced) page load retries automatically
// instead of getting stuck showing a stale failure. Cleared on disconnect so
// reconnecting doesn't show a previous account's charge points.
import type { EvnexChargePointInfo } from './evnex-client';

export interface ChargePointsResult {
	chargePoints: EvnexChargePointInfo[];
	chargePointsError: string | null;
}

let cache: ChargePointsResult | null = null;

export function getCachedChargePoints(): ChargePointsResult | null {
	return cache;
}

export function setCachedChargePoints(result: ChargePointsResult): void {
	cache = result;
}

export function clearCachedChargePoints(): void {
	cache = null;
}
