import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { evnexIntegration } from '$lib/server/db/schema';
import {
	EvnexApiError,
	EvnexNetworkError as EvnexClientNetworkError,
	fetchChargePoints,
	fetchOrgId,
	type EvnexChargePointInfo
} from '$lib/server/evnex-client';
import { EvnexNetworkError as EvnexAuthNetworkError } from '$lib/server/evnex-auth';
import { ensureAccessToken } from '$lib/server/evnex-token';
import type { RequestHandler } from './$types';

// Fetched client-side by /settings after the page has already rendered (see
// +page.svelte), rather than from /settings' own `load` — this hits the Evnex API
// (token refresh + org lookup + charge-point list), and awaiting it in `load` used
// to block the whole page behind a flaky, unofficial third-party API.
export const GET: RequestHandler = async () => {
	const [integration] = await db.select().from(evnexIntegration).limit(1);
	if (!integration || integration.refreshToken == null) {
		return json({ chargePoints: [], chargePointsError: null });
	}

	try {
		const accessToken = await ensureAccessToken(integration);
		let orgId = integration.orgId;
		if (orgId == null) {
			orgId = await fetchOrgId(accessToken);
			await db
				.update(evnexIntegration)
				.set({ orgId })
				.where(eq(evnexIntegration.id, integration.id));
		}
		const chargePoints: EvnexChargePointInfo[] = await fetchChargePoints(accessToken, orgId);
		return json({ chargePoints, chargePointsError: null });
	} catch (err) {
		// Never let a flaky Evnex API error the whole /settings page — fall back to
		// showing just the already-selected charger (if any) and a note. Surface the
		// real error (status + correlation id, never a raw token) rather than a
		// generic string, and log it server-side too — this endpoint contract is
		// unverified against a live account (see evnex-client.ts's module doc
		// comment), so a specific message here is the only way to diagnose it.
		console.error('[evnex] /settings/charge-points failed:', err);
		const chargePointsError =
			err instanceof EvnexApiError
				? `Could not list charge points: ${err.message}${err.correlationId ? ` (ref: ${err.correlationId})` : ''}`
				: err instanceof EvnexClientNetworkError || err instanceof EvnexAuthNetworkError
					? `Could not reach Evnex to list charge points: ${err.message}`
					: `Something went wrong listing charge points: ${err instanceof Error ? err.message : String(err)}`;
		const chargePoints: EvnexChargePointInfo[] =
			integration.chargePointId && integration.chargePointName
				? [
						{
							id: integration.chargePointId,
							name: integration.chargePointName,
							timeZone: integration.chargePointTimeZone ?? ''
						}
					]
				: [];
		return json({ chargePoints, chargePointsError });
	}
};
