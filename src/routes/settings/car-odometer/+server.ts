import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { carOdometerIntegration } from '$lib/server/db/schema';
import { latestReading } from '$lib/server/car-odometer';
import { getCarOdometerIntegration, readCompanion } from '$lib/server/car-odometer-store';
import type { RequestHandler } from './$types';

// The /settings card's Test button. Fetched by the browser rather than run from
// /settings' `load`, for the same reason as ../charge-points/+server.ts: a network
// call to a third party mustn't block page render (BYD-INTEGRATION-PLAN.md §7.1).
//
// Test always calls the companion, even when a broken status has paused automatic
// calls — a successful Test is what clears that pause (plan §7.1, §7.3).
export const POST: RequestHandler = async () => {
	const row = await getCarOdometerIntegration();
	if (!row || !row.baseUrl || !row.secret) {
		return json(
			{
				ok: false,
				status: 'not_configured',
				message: 'Enter the Home Assistant URL and generate a secret first.'
			},
			{ status: 400 }
		);
	}

	const result = await readCompanion({ ...row, baseUrl: row.baseUrl, secret: row.secret });
	if (!result.ok) {
		return json({ ok: false, status: result.status, message: result.message });
	}

	// The first-ever successful Test switches the integration on (plan §3 step 4).
	// Later Tests leave the switch alone, so turning it off sticks.
	if (row.lastSuccessAt == null && !row.enabled) {
		await db
			.update(carOdometerIntegration)
			.set({ enabled: true })
			.where(eq(carOdometerIntegration.id, row.id));
	}

	const reading = latestReading(result.readings);
	return json({ ok: true, km: reading?.km, carReportedAt: reading?.carReportedAt });
};
