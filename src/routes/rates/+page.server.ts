import { fail } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { ratePlans } from '$lib/server/db/schema';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const plans = await db.query.ratePlans.findMany({
		orderBy: [asc(ratePlans.effectiveFrom)]
	});

	// Newest effective-from first, matching how the list should read on the page.
	plans.reverse();

	return { plans };
};

export const actions: Actions = {
	create: async ({ request }) => {
		const formData = await request.formData();

		const type = formData.get('type');
		const effectiveFrom = formData.get('effectiveFrom');
		const flatRateRaw = formData.get('flatRate');
		const peakRateRaw = formData.get('peakRate');
		const offpeakRateRaw = formData.get('offpeakRate');
		const windowStarts = formData.getAll('windowStart').map(String);
		const windowEnds = formData.getAll('windowEnd').map(String);

		if (type !== 'flat' && type !== 'peak_offpeak') {
			return fail(400, { error: 'Choose a rate plan type.' });
		}

		if (typeof effectiveFrom !== 'string' || !effectiveFrom) {
			return fail(400, { error: 'Effective-from date is required.' });
		}

		if (type === 'flat') {
			const flatRate = flatRateRaw ? Number(flatRateRaw) : NaN;
			if (!Number.isFinite(flatRate) || flatRate <= 0) {
				return fail(400, { error: 'Enter a valid flat rate ($/kWh).' });
			}

			await db.insert(ratePlans).values({
				type: 'flat',
				effectiveFrom,
				flatRate,
				peakRate: null,
				offpeakRate: null,
				offpeakWindows: null
			});

			return { success: true };
		}

		// peak_offpeak
		const peakRate = peakRateRaw ? Number(peakRateRaw) : NaN;
		const offpeakRate = offpeakRateRaw ? Number(offpeakRateRaw) : NaN;

		if (!Number.isFinite(peakRate) || peakRate <= 0) {
			return fail(400, { error: 'Enter a valid peak rate ($/kWh).' });
		}
		if (!Number.isFinite(offpeakRate) || offpeakRate <= 0) {
			return fail(400, { error: 'Enter a valid off-peak rate ($/kWh).' });
		}

		const windows = windowStarts
			.map((start, i) => ({ start, end: windowEnds[i] ?? '' }))
			.filter((w) => w.start && w.end);

		if (windows.length === 0) {
			return fail(400, { error: 'Add at least one off-peak window.' });
		}

		const timePattern = /^\d{2}:\d{2}$/;
		for (const w of windows) {
			if (!timePattern.test(w.start) || !timePattern.test(w.end)) {
				return fail(400, { error: 'Off-peak window times must be in HH:mm format.' });
			}
		}

		await db.insert(ratePlans).values({
			type: 'peak_offpeak',
			effectiveFrom,
			flatRate: null,
			peakRate,
			offpeakRate,
			offpeakWindows: windows
		});

		return { success: true };
	},

	delete: async ({ request }) => {
		const formData = await request.formData();
		const id = Number(formData.get('id'));

		if (!Number.isFinite(id)) {
			return fail(400, { error: 'Invalid rate plan id.' });
		}

		await db.delete(ratePlans).where(eq(ratePlans.id, id));

		return { success: true };
	}
};
