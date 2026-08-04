import { fail } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { chargingSessions, ratePlans } from '$lib/server/db/schema';
import { recalculateSessionCosts } from '$lib/server/rates';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const plans = await db.query.ratePlans.findMany({
		orderBy: [asc(ratePlans.effectiveFrom)]
	});

	// Newest effective-from first, matching how the list should read on the page.
	plans.reverse();

	return { plans };
};

/**
 * Recomputes cost for every home session against the current rate plans and
 * writes back only the ones that changed. Called after any rate plan
 * create/update/delete so a plan added or changed after sessions already
 * exist (or a plan being removed) is reflected retroactively, instead of
 * costs only ever being set once at session-creation time.
 */
async function recalculateAndPersistCosts(): Promise<number> {
	const [homeSessions, plans] = await Promise.all([
		db.select().from(chargingSessions).where(eq(chargingSessions.kind, 'home')),
		db.select().from(ratePlans)
	]);

	// Drafts have no kWh yet, so there's nothing to price until they're completed.
	const completedHomeSessions = homeSessions
		.filter((s) => !s.isDraft && s.kwhUsed != null)
		.map((s) => ({ ...s, kwhUsed: s.kwhUsed as number }));

	const updates = recalculateSessionCosts(completedHomeSessions, plans);

	for (const update of updates) {
		await db
			.update(chargingSessions)
			.set({ cost: update.cost })
			.where(eq(chargingSessions.id, update.id));
	}

	return updates.length;
}

type ParsedPlan = typeof ratePlans.$inferInsert;

/** Shared validation for the create and update forms, which use identical fields. */
function parsePlanInput(formData: FormData): { error: string } | { plan: ParsedPlan } {
	const type = formData.get('type');
	const effectiveFrom = formData.get('effectiveFrom');
	const flatRateRaw = formData.get('flatRate');
	const peakRateRaw = formData.get('peakRate');
	const offpeakRateRaw = formData.get('offpeakRate');
	const windowStarts = formData.getAll('windowStart').map(String);
	const windowEnds = formData.getAll('windowEnd').map(String);

	if (type !== 'flat' && type !== 'peak_offpeak') {
		return { error: 'Choose a rate plan type.' };
	}

	if (typeof effectiveFrom !== 'string' || !effectiveFrom) {
		return { error: 'Effective-from date is required.' };
	}

	if (type === 'flat') {
		const flatRate = flatRateRaw ? Number(flatRateRaw) : NaN;
		if (!Number.isFinite(flatRate) || flatRate <= 0) {
			return { error: 'Enter a valid flat rate ($/kWh).' };
		}

		return {
			plan: {
				type: 'flat',
				effectiveFrom,
				flatRate,
				peakRate: null,
				offpeakRate: null,
				offpeakWindows: null
			}
		};
	}

	// peak_offpeak
	const peakRate = peakRateRaw ? Number(peakRateRaw) : NaN;
	const offpeakRate = offpeakRateRaw ? Number(offpeakRateRaw) : NaN;

	if (!Number.isFinite(peakRate) || peakRate <= 0) {
		return { error: 'Enter a valid peak rate ($/kWh).' };
	}
	if (!Number.isFinite(offpeakRate) || offpeakRate <= 0) {
		return { error: 'Enter a valid off-peak rate ($/kWh).' };
	}

	const windows = windowStarts
		.map((start, i) => ({ start, end: windowEnds[i] ?? '' }))
		.filter((w) => w.start && w.end);

	if (windows.length === 0) {
		return { error: 'Add at least one off-peak window.' };
	}

	const timePattern = /^\d{2}:\d{2}$/;
	for (const w of windows) {
		if (!timePattern.test(w.start) || !timePattern.test(w.end)) {
			return { error: 'Off-peak window times must be in HH:mm format.' };
		}
	}

	return {
		plan: {
			type: 'peak_offpeak',
			effectiveFrom,
			flatRate: null,
			peakRate,
			offpeakRate,
			offpeakWindows: windows
		}
	};
}

export const actions: Actions = {
	create: async ({ request }) => {
		const formData = await request.formData();
		const result = parsePlanInput(formData);

		if ('error' in result) {
			return fail(400, { error: result.error });
		}

		await db.insert(ratePlans).values(result.plan);
		const recalculated = await recalculateAndPersistCosts();

		return { success: true, recalculated };
	},

	update: async ({ request }) => {
		const formData = await request.formData();
		const id = Number(formData.get('id'));

		if (!Number.isFinite(id)) {
			return fail(400, { error: 'Invalid rate plan id.' });
		}

		const result = parsePlanInput(formData);

		if ('error' in result) {
			return fail(400, { error: result.error });
		}

		await db.update(ratePlans).set(result.plan).where(eq(ratePlans.id, id));
		const recalculated = await recalculateAndPersistCosts();

		return { success: true, recalculated };
	},

	delete: async ({ request }) => {
		const formData = await request.formData();
		const id = Number(formData.get('id'));

		if (!Number.isFinite(id)) {
			return fail(400, { error: 'Invalid rate plan id.' });
		}

		await db.delete(ratePlans).where(eq(ratePlans.id, id));
		const recalculated = await recalculateAndPersistCosts();

		return { success: true, recalculated };
	}
};
