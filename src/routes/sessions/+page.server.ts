import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { billingPeriods, chargingSessions, ratePlans } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	findBillingPeriodId,
	isOdometerBelowLastRecorded,
	sortByDateTimeDesc,
	withEfficiency
} from '$lib/server/sessions';
// TODO: swap this import for '$lib/server/rates' once that module lands on main
// (see the note at the top of rates-stub.ts for details).
import { calculateSessionCost, resolveRatePlan } from '$lib/server/rates-stub';

export const load: PageServerLoad = async () => {
	const [sessions, periods] = await Promise.all([
		db.select().from(chargingSessions),
		db.select().from(billingPeriods)
	]);

	const periodLabelById = new Map(periods.map((period) => [period.id, period.label]));

	const rows = sortByDateTimeDesc(withEfficiency(sessions)).map((session) => ({
		...session,
		billingPeriodLabel: session.billingPeriodId
			? (periodLabelById.get(session.billingPeriodId) ?? null)
			: null
	}));

	return { sessions: rows };
};

type FormValues = {
	kind: string | null;
	date: string | null;
	time: string | null;
	odometerKm: string | null;
	kwhUsed: string | null;
	location: string | null;
	notes: string | null;
};

function readForm(form: FormData): FormValues {
	return {
		kind: form.get('kind')?.toString() ?? null,
		date: form.get('date')?.toString() ?? null,
		time: form.get('time')?.toString() ?? null,
		odometerKm: form.get('odometerKm')?.toString() ?? null,
		kwhUsed: form.get('kwhUsed')?.toString() ?? null,
		location: form.get('location')?.toString() ?? null,
		notes: form.get('notes')?.toString() ?? null
	};
}

export const actions: Actions = {
	create: async ({ request }) => {
		const values = readForm(await request.formData());
		const errors: Partial<Record<keyof FormValues, string>> = {};

		if (values.kind !== 'home' && values.kind !== 'public') {
			errors.kind = 'Choose home or public.';
		}
		if (!values.date) errors.date = 'Date is required.';
		if (!values.time) errors.time = 'Time is required.';

		const odometerKm = values.odometerKm ? Number(values.odometerKm) : NaN;
		if (!values.odometerKm || Number.isNaN(odometerKm) || odometerKm < 0) {
			errors.odometerKm = 'Enter a valid odometer reading (km).';
		}

		const kwhUsed = values.kwhUsed ? Number(values.kwhUsed) : NaN;
		if (!values.kwhUsed || Number.isNaN(kwhUsed) || kwhUsed <= 0) {
			errors.kwhUsed = 'Enter kWh used, greater than 0.';
		}

		const location = values.location?.trim();
		if (!location) errors.location = 'Location is required.';

		if (Object.keys(errors).length > 0) {
			return fail(400, { errors, values });
		}

		const kind = values.kind as 'home' | 'public';
		const date = values.date as string;
		const time = values.time as string;
		const notes = values.notes?.trim() || null;
		const validatedLocation = location as string;

		const existingSessions = await db.select().from(chargingSessions);
		const odometerWarning = isOdometerBelowLastRecorded(odometerKm, existingSessions);

		const periods = await db.select().from(billingPeriods);
		const billingPeriodId = findBillingPeriodId(date, periods);

		let cost: number | null = null;
		if (kind === 'home') {
			const plans = await db.select().from(ratePlans);
			const plan = resolveRatePlan(date, plans);
			cost = calculateSessionCost({ date, time, kwhUsed }, plan);
		}

		await db.insert(chargingSessions).values({
			billingPeriodId,
			kind,
			date,
			time,
			odometerKm,
			kwhUsed,
			location: validatedLocation,
			cost,
			notes
		});

		return {
			success: true,
			odometerWarning,
			unassigned: billingPeriodId == null
		};
	},

	delete: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!id || Number.isNaN(id)) {
			return fail(400, { error: 'Missing or invalid session id.' });
		}
		await db.delete(chargingSessions).where(eq(chargingSessions.id, id));
		return { deleted: true };
	}
};
