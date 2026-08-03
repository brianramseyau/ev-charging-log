import { db } from '$lib/server/db';
import { billingPeriods, chargingSessions } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) throw error(404, 'Billing period not found');

	const [period] = await db.select().from(billingPeriods).where(eq(billingPeriods.id, id));
	if (!period) throw error(404, 'Billing period not found');

	const sessions = await db
		.select()
		.from(chargingSessions)
		.where(eq(chargingSessions.billingPeriodId, id))
		.orderBy(asc(chargingSessions.date), asc(chargingSessions.time));

	const homeSessions = sessions.filter((s) => s.kind === 'home');
	const publicSessions = sessions.filter((s) => s.kind === 'public');

	const homeKwhTotal = homeSessions.reduce((sum, s) => sum + s.kwhUsed, 0);
	const homeCostTotal = homeSessions.reduce((sum, s) => sum + (s.cost ?? 0), 0);
	const publicKwhTotal = publicSessions.reduce((sum, s) => sum + s.kwhUsed, 0);
	const homePercentage =
		homeKwhTotal + publicKwhTotal > 0 ? homeKwhTotal / (homeKwhTotal + publicKwhTotal) : null;

	return {
		period,
		homeSessions,
		publicSessions,
		totals: {
			homeKwhTotal,
			homeCostTotal,
			publicKwhTotal,
			homePercentage
		}
	};
};
