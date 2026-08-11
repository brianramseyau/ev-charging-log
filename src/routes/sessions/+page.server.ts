import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	billingPeriods,
	chargingSessions,
	evnexDismissedSessions,
	evnexIntegration,
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
import { importWindow, planImport, type DraftFromEvnex } from '$lib/server/evnex';
import { EvnexNetworkError, EvnexRefreshExpiredError } from '$lib/server/evnex-auth';
import {
	EvnexApiError,
	clientFor,
	fetchChargePoints,
	fetchOrgId,
	fetchSessions
} from '$lib/server/evnex-client';
import { recordAuthFailure, sessionFor } from '$lib/server/evnex-token';

export const load: PageServerLoad = async () => {
	const [sessions, periods, [settingsRow], [integration]] = await Promise.all([
		db.select().from(chargingSessions),
		db.select().from(billingPeriods),
		db.select().from(settings).limit(1),
		db.select().from(evnexIntegration).limit(1)
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

	// Drives the "Pull from charger" button's enabled/disabled state (plan §7.2) —
	// configured means signed in, a charger picked, a known timezone, and the
	// integration switched on.
	const evnexReady = Boolean(
		integration?.refreshToken &&
		integration.chargePointId &&
		integration.chargePointTimeZone &&
		integration.enabled
	);

	return { sessions: rows, homeAddress: settingsRow?.homeAddress ?? null, evnexReady };
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

function classifyPollError(err: unknown): 'network_error' | 'api_error' {
	return err instanceof EvnexNetworkError ? 'network_error' : 'api_error';
}

function pollErrorMessage(err: unknown): string {
	if (err instanceof EvnexApiError) {
		return err.correlationId ? `${err.message} (ref: ${err.correlationId})` : err.message;
	}
	return err instanceof Error ? err.message : 'Something went wrong talking to Evnex.';
}

async function recordPollResult(
	id: number,
	status: 'ok' | 'network_error' | 'api_error',
	error: string | null
) {
	await db
		.update(evnexIntegration)
		.set({ lastPolledAt: new Date().toISOString(), lastPollStatus: status, lastPollError: error })
		.where(eq(evnexIntegration.id, id));
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
		if (session.kwhUsed != null && session.odometerKm != null) {
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

		// A draft is missing kWh, an odometer reading, or both (the last case only
		// arises for an Evnex import still mid-charge) — only require whichever this
		// particular session is actually missing (plan §7.3).
		let kwhUsed = session.kwhUsed;
		if (kwhUsed == null) {
			const kwhRaw = form.get('kwhUsed')?.toString() ?? '';
			const parsed = kwhRaw ? Number(kwhRaw) : NaN;
			if (!kwhRaw || Number.isNaN(parsed) || parsed <= 0) {
				return fail(400, { completeError: 'Enter kWh used, greater than 0.', completeId: id });
			}
			kwhUsed = parsed;
		}

		let odometerKm = session.odometerKm;
		let odometerWarning = false;
		if (odometerKm == null) {
			const odoRaw = form.get('odometerKm')?.toString() ?? '';
			const parsed = odoRaw ? Number(odoRaw) : NaN;
			if (!odoRaw || Number.isNaN(parsed) || parsed < 0) {
				return fail(400, {
					completeError: 'Enter a valid odometer reading (km).',
					completeId: id
				});
			}
			odometerKm = parsed;
			const existingSessions = await db.select().from(chargingSessions);
			odometerWarning = isOdometerBelowLastRecorded(odometerKm, existingSessions);
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

		await db
			.update(chargingSessions)
			.set({ kwhUsed, odometerKm, cost })
			.where(eq(chargingSessions.id, id));

		return { completed: true, completedId: id, noRatePlan, odometerWarning };
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
	},

	pollEvnex: async () => {
		const [integration] = await db.select().from(evnexIntegration).limit(1);

		if (!integration || integration.refreshToken == null) {
			return fail(400, { pollError: 'Connect an Evnex account first, in Settings.' });
		}
		if (!integration.chargePointId || !integration.chargePointTimeZone) {
			return fail(400, { pollError: 'Choose a charge point in Settings first.' });
		}
		if (!integration.enabled) {
			return fail(400, {
				pollError: 'The Evnex integration is switched off — enable it in Settings.'
			});
		}

		const client = clientFor(sessionFor(integration));

		let orgId = integration.orgId;
		let chargePoints: Awaited<ReturnType<typeof fetchChargePoints>>;
		let remoteSessions: Awaited<ReturnType<typeof fetchSessions>>;
		try {
			if (orgId == null) {
				orgId = await fetchOrgId(client);
				await db
					.update(evnexIntegration)
					.set({ orgId })
					.where(eq(evnexIntegration.id, integration.id));
			}

			chargePoints = await fetchChargePoints(client, orgId);
			remoteSessions = await fetchSessions(client, integration.chargePointId as string);
		} catch (err) {
			if (err instanceof EvnexRefreshExpiredError) {
				await recordAuthFailure(integration.id, err);
				return fail(400, {
					pollError: 'Your Evnex session has expired — reconnect in Settings.'
				});
			}
			const status = classifyPollError(err);
			const message = pollErrorMessage(err);
			await recordPollResult(integration.id, status, message);
			return fail(502, { pollError: message });
		}

		// Refresh the cached name/timezone for the selected charger (plan §6.6 step 3).
		const currentChargePoint = chargePoints.find((p) => p.id === integration.chargePointId);
		const timeZone = (currentChargePoint?.timeZone || integration.chargePointTimeZone) as string;
		if (
			currentChargePoint?.timeZone &&
			(currentChargePoint.name !== integration.chargePointName ||
				currentChargePoint.timeZone !== integration.chargePointTimeZone)
		) {
			await db
				.update(evnexIntegration)
				.set({
					chargePointName: currentChargePoint.name,
					chargePointTimeZone: currentChargePoint.timeZone
				})
				.where(eq(evnexIntegration.id, integration.id));
		}

		const [existingRows, dismissedRows, periods, [settingsRow], plans] = await Promise.all([
			db.select().from(chargingSessions),
			db.select({ externalId: evnexDismissedSessions.externalId }).from(evnexDismissedSessions),
			db.select().from(billingPeriods),
			db.select().from(settings).limit(1),
			db.select().from(ratePlans)
		]);

		const submittedPeriodIds = periods.filter((p) => isPeriodSubmitted(p)).map((p) => p.id);
		const location = settingsRow?.homeAddress || integration.chargePointName || 'Home';
		const { from: windowStart } = importWindow(new Date(), integration.importLookbackDays);

		const planResult = planImport(
			remoteSessions,
			existingRows.map((r) => ({
				id: r.id,
				externalId: r.externalId,
				kwhUsed: r.kwhUsed,
				billingPeriodId: r.billingPeriodId
			})),
			dismissedRows.map((r) => r.externalId),
			{ windowStart, timeZone, location, submittedPeriodIds }
		);

		// planImport's period_submitted rule (plan §6.5 rule 8) only fires for the
		// *update* path — a brand-new insert has no billingPeriodId yet, since that's
		// assigned here, downstream of planImport (plan §6.6 step 8). Apply the same
		// check to inserts now that a period list is available, rather than silently
		// landing a new draft in an already-submitted period.
		const insertsToApply: (DraftFromEvnex & { billingPeriodId: number | null })[] = [];
		let periodSubmittedInsertSkips = 0;
		for (const draft of planResult.insert) {
			const billingPeriodId = findBillingPeriodId(draft.date, periods);
			if (billingPeriodId != null && submittedPeriodIds.includes(billingPeriodId)) {
				periodSubmittedInsertSkips++;
				continue;
			}
			insertsToApply.push({ ...draft, billingPeriodId });
		}

		const invalidAfterImportSessions = planResult.skipped
			.filter((s) => s.reason === 'invalid_after_import' || s.reason === 'zero_energy_after_import')
			.map((s) => {
				const existing = existingRows.find((r) => r.externalId === s.externalId);
				return existing ? `${existing.date} ${existing.time}` : s.externalId;
			});

		// planImport tombstones both Invalid sessions and zero-energy ones (plan-equivalent
		// rules 1 and 2) — record which is which rather than always writing 'invalid', so
		// evnex_dismissed_sessions stays an honest audit trail of *why* a session never
		// reappears.
		const tombstoneReasonByExternalId = new Map<string, 'invalid' | 'zero_energy'>();
		for (const s of planResult.skipped) {
			if (s.reason === 'invalid' || s.reason === 'invalid_after_import') {
				tombstoneReasonByExternalId.set(s.externalId, 'invalid');
			} else if (s.reason === 'zero_energy' || s.reason === 'zero_energy_after_import') {
				tombstoneReasonByExternalId.set(s.externalId, 'zero_energy');
			}
		}

		db.transaction((tx) => {
			for (const externalId of planResult.tombstone) {
				tx.insert(evnexDismissedSessions)
					.values({
						externalId,
						dismissedAt: new Date().toISOString(),
						reason: tombstoneReasonByExternalId.get(externalId) ?? 'invalid'
					})
					.onConflictDoNothing()
					.run();
			}

			for (const draft of insertsToApply) {
				let cost: number | null = null;
				if (draft.kwhUsed != null) {
					const ratePlan = resolveRatePlan(draft.date, plans);
					if (ratePlan) {
						cost = calculateSessionCost(
							{ date: draft.date, time: draft.time, kwhUsed: draft.kwhUsed },
							ratePlan
						);
					}
				}
				tx.insert(chargingSessions)
					.values({
						billingPeriodId: draft.billingPeriodId,
						kind: draft.kind,
						date: draft.date,
						time: draft.time,
						odometerKm: draft.odometerKm,
						kwhUsed: draft.kwhUsed,
						location: draft.location,
						cost,
						notes: draft.notes,
						externalId: draft.externalId
					})
					.run();
			}

			for (const update of planResult.update) {
				const existing = existingRows.find((r) => r.id === update.id);
				if (!existing) continue;
				let cost: number | null = null;
				if (existing.kind === 'home') {
					const ratePlan = resolveRatePlan(existing.date, plans);
					if (ratePlan) {
						cost = calculateSessionCost(
							{ date: existing.date, time: existing.time, kwhUsed: update.kwhUsed },
							ratePlan
						);
					}
				}
				tx.update(chargingSessions)
					.set({ kwhUsed: update.kwhUsed, cost })
					.where(eq(chargingSessions.id, update.id))
					.run();
			}
		});

		await recordPollResult(integration.id, 'ok', null);

		return {
			pollSummary: {
				inserted: insertsToApply.length,
				updated: planResult.update.length,
				tombstoned: planResult.tombstone.length,
				skipped: planResult.skipped.length + periodSubmittedInsertSkips,
				invalidAfterImport: invalidAfterImportSessions
			}
		};
	}
};
