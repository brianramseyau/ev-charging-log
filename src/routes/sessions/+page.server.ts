import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	billingPeriods,
	chargingSessions,
	evnexDismissedSessions,
	ratePlans,
	settings
} from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	findBillingPeriodId,
	isOdometerBelowLastRecorded,
	isPeriodSubmitted,
	sortByDateTimeDesc,
	withEfficiency
} from '$lib/server/sessions';
import { calculateSessionCost, resolveRatePlan } from '$lib/server/rates';

export const load: PageServerLoad = async () => {
	const [sessions, periods, [settingsRow]] = await Promise.all([
		db.select().from(chargingSessions),
		db.select().from(billingPeriods),
		db.select().from(settings).limit(1)
	]);

	const periodById = new Map(periods.map((period) => [period.id, period]));

	const rows = sortByDateTimeDesc(withEfficiency(sessions)).map((session) => {
		const period = session.billingPeriodId ? periodById.get(session.billingPeriodId) : undefined;
		return {
			...session,
			billingPeriodLabel: period?.label ?? null,
			periodSubmitted: isPeriodSubmitted(period)
		};
	});

	return { sessions: rows, homeAddress: settingsRow?.homeAddress ?? null };
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

		// kWh is optional: leaving it blank saves the session as a draft (just the
		// bits known when plugging in — date/time/odometer/location), to be
		// completed with kWh once charging finishes. If something was typed, though,
		// it has to be a valid amount.
		const kwhRaw = values.kwhUsed?.trim();
		let kwhUsed: number | null = null;
		if (kwhRaw) {
			kwhUsed = Number(kwhRaw);
			if (Number.isNaN(kwhUsed) || kwhUsed <= 0) {
				errors.kwhUsed = 'Enter kWh used, greater than 0, or leave blank to save as a draft.';
			}
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

		const matchedPeriod = periods.find((p) => p.id === billingPeriodId);
		if (matchedPeriod && isPeriodSubmitted(matchedPeriod)) {
			return fail(400, {
				error: `"${matchedPeriod.label}" has already been submitted and can't accept new sessions. Unsubmit it first if you need to add one.`,
				values
			});
		}

		let cost: number | null = null;
		let noRatePlan = false;
		if (kwhUsed != null && kind === 'home') {
			const plans = await db.select().from(ratePlans);
			const plan = resolveRatePlan(date, plans);
			if (plan) {
				cost = calculateSessionCost({ date, time, kwhUsed }, plan);
			} else {
				noRatePlan = true;
			}
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
			isDraft: kwhUsed == null,
			odometerWarning,
			unassigned: billingPeriodId == null,
			noRatePlan
		};
	},

	complete: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!id || Number.isNaN(id)) {
			return fail(400, { completeError: 'Missing or invalid session id.', completeId: id });
		}

		const [session] = await db.select().from(chargingSessions).where(eq(chargingSessions.id, id));
		if (!session) {
			return fail(400, { completeError: 'Session not found.', completeId: id });
		}
		if (session.kwhUsed != null) {
			return fail(400, { completeError: 'Session is already complete.', completeId: id });
		}

		if (session.billingPeriodId != null) {
			const [period] = await db
				.select()
				.from(billingPeriods)
				.where(eq(billingPeriods.id, session.billingPeriodId));
			if (isPeriodSubmitted(period)) {
				return fail(400, {
					completeError: `"${period.label}" has already been submitted and can't accept changes. Unsubmit it first if you need to complete this session.`,
					completeId: id
				});
			}
		}

		const kwhRaw = form.get('kwhUsed')?.toString() ?? '';
		const kwhUsed = kwhRaw ? Number(kwhRaw) : NaN;
		if (!kwhRaw || Number.isNaN(kwhUsed) || kwhUsed <= 0) {
			return fail(400, {
				completeError: 'Enter kWh used, greater than 0.',
				completeId: id
			});
		}

		let cost: number | null = null;
		let noRatePlan = false;
		if (session.kind === 'home') {
			const plans = await db.select().from(ratePlans);
			const plan = resolveRatePlan(session.date, plans);
			if (plan) {
				cost = calculateSessionCost({ date: session.date, time: session.time, kwhUsed }, plan);
			} else {
				noRatePlan = true;
			}
		}

		await db.update(chargingSessions).set({ kwhUsed, cost }).where(eq(chargingSessions.id, id));

		return { completed: true, completedId: id, noRatePlan };
	},

	delete: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!id || Number.isNaN(id)) {
			return fail(400, { error: 'Missing or invalid session id.' });
		}

		const [session] = await db.select().from(chargingSessions).where(eq(chargingSessions.id, id));
		if (!session) {
			return fail(400, { error: 'Session not found.' });
		}

		if (session.billingPeriodId != null) {
			const [period] = await db
				.select()
				.from(billingPeriods)
				.where(eq(billingPeriods.id, session.billingPeriodId));
			if (isPeriodSubmitted(period)) {
				return fail(400, {
					error: `"${period.label}" has already been submitted and its sessions can't be deleted. Unsubmit it first if you need to remove one.`
				});
			}
		}

		await db.delete(chargingSessions).where(eq(chargingSessions.id, id));

		// Tombstone the Evnex session so a later poll doesn't re-import it — it's
		// still inside the lookback window and the charger has no idea it was
		// deleted here. Ignore-on-conflict since a poll can tombstone the same
		// session first (reason 'invalid') before the user ever deletes it.
		if (session.externalId != null) {
			await db
				.insert(evnexDismissedSessions)
				.values({
					externalId: session.externalId,
					dismissedAt: new Date().toISOString(),
					reason: 'user_deleted'
				})
				.onConflictDoNothing();
		}

		return { deleted: true };
	}
};
