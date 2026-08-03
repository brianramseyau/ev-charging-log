import { db } from '$lib/server/db';
import { billingPeriods, chargingSessions } from '$lib/server/db/schema';
import { and, between, desc, isNull } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const periods = await db.select().from(billingPeriods).orderBy(desc(billingPeriods.startDate));
	return { periods };
};

export const actions: Actions = {
	create: async ({ request }) => {
		const data = await request.formData();
		const label = String(data.get('label') ?? '').trim();
		const startDate = String(data.get('startDate') ?? '').trim();
		const endDate = String(data.get('endDate') ?? '').trim();

		if (!label) return fail(400, { error: 'Label is required.', label, startDate, endDate });
		if (!startDate || !endDate)
			return fail(400, { error: 'Start and end date are required.', label, startDate, endDate });
		if (endDate < startDate)
			return fail(400, {
				error: 'End date must be on or after the start date.',
				label,
				startDate,
				endDate
			});

		const [period] = await db
			.insert(billingPeriods)
			.values({ label, startDate, endDate })
			.returning();

		// Retroactively claim any sessions that fell outside every period's range
		// at the time they were logged but are now covered by this new one.
		await db
			.update(chargingSessions)
			.set({ billingPeriodId: period.id })
			.where(
				and(
					isNull(chargingSessions.billingPeriodId),
					between(chargingSessions.date, startDate, endDate)
				)
			);

		return { success: true };
	}
};
