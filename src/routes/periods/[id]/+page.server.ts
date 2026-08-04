import { db } from '$lib/server/db';
import { billingPeriods, chargingSessions } from '$lib/server/db/schema';
import { hasUnresolvedDrafts } from '$lib/server/sessions';
import { asc, eq, sql } from 'drizzle-orm';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

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

	// Drafts (kWh not yet recorded) are shown separately and left out of the
	// report totals, since there's nothing to sum yet. Completed sessions always
	// have kwhUsed set, so it's safe to default the type down to non-null here.
	const draftSessions = sessions.filter((s) => s.isDraft);
	const completedSessions = sessions
		.filter((s) => !s.isDraft)
		.map((s) => ({ ...s, kwhUsed: s.kwhUsed ?? 0 }));
	const homeSessions = completedSessions.filter((s) => s.kind === 'home');
	const publicSessions = completedSessions.filter((s) => s.kind === 'public');

	const homeKwhTotal = homeSessions.reduce((sum, s) => sum + s.kwhUsed, 0);
	const homeCostTotal = homeSessions.reduce((sum, s) => sum + (s.cost ?? 0), 0);
	const publicKwhTotal = publicSessions.reduce((sum, s) => sum + s.kwhUsed, 0);
	const homePercentage =
		homeKwhTotal + publicKwhTotal > 0 ? homeKwhTotal / (homeKwhTotal + publicKwhTotal) : null;

	return {
		period,
		homeSessions,
		publicSessions,
		draftSessions,
		totals: {
			homeKwhTotal,
			homeCostTotal,
			publicKwhTotal,
			homePercentage
		}
	};
};

export const actions: Actions = {
	submit: async ({ params }) => {
		const id = Number(params.id);
		if (!Number.isInteger(id)) throw error(404, 'Billing period not found');

		const sessions = await db
			.select({
				billingPeriodId: chargingSessions.billingPeriodId,
				isDraft: chargingSessions.isDraft
			})
			.from(chargingSessions)
			.where(eq(chargingSessions.billingPeriodId, id));

		if (hasUnresolvedDrafts(id, sessions)) {
			return fail(400, {
				error:
					'This period has draft sessions still missing kWh. Complete them before submitting, so the report includes their cost.'
			});
		}

		await db
			.update(billingPeriods)
			.set({ submittedAt: new Date().toISOString() })
			.where(eq(billingPeriods.id, id));

		return { success: true };
	},

	unsubmit: async ({ params }) => {
		const id = Number(params.id);
		if (!Number.isInteger(id)) throw error(404, 'Billing period not found');

		await db.update(billingPeriods).set({ submittedAt: null }).where(eq(billingPeriods.id, id));

		return { success: true };
	},

	delete: async ({ params }) => {
		const id = Number(params.id);
		if (!Number.isInteger(id)) throw error(404, 'Billing period not found');

		const [{ count }] = await db
			.select({ count: sql<number>`count(*)` })
			.from(chargingSessions)
			.where(eq(chargingSessions.billingPeriodId, id));

		if (count > 0) {
			return fail(400, {
				error: 'This period has charging sessions logged against it and cannot be deleted.'
			});
		}

		await db.delete(billingPeriods).where(eq(billingPeriods.id, id));
		throw redirect(303, '/periods');
	}
};
