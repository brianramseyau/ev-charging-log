import { json } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { billingPeriods, chargingSessions } from '$lib/server/db/schema';
import {
	brokenReason,
	isBrokenStatus,
	latestReading,
	planOdometerFill,
	requestWindow,
	type DraftForFill,
	type FillSkipReason
} from '$lib/server/car-odometer';
import {
	getCarOdometerIntegration,
	readCompanion,
	type CarOdometerRow
} from '$lib/server/car-odometer-store';
import { isPeriodSubmitted } from '$lib/server/sessions';
import type { RequestHandler } from './$types';

// Every call to Home Assistant is made here, server-side — the browser only ever
// talks to this endpoint, so the secret never reaches it and what decides whether
// HA is reachable is where this server runs (BYD-INTEGRATION-PLAN.md §2 #7, §4.5).
//
//   POST                      Read from car: the current odometer.
//   POST { draftId }          Read from car on a draft row: the history rule for that
//                             one draft when it has startedAt, else the current value.
//   POST ?apply=1             After Pull from charger: match every open imported draft
//                             against one history request, write the proven fills,
//                             and return the suggestions to pre-fill (plan §6.3, §7.2).
//
// Kept separate from the pollEvnex form action so HA being slow or down can never
// delay or fail an Evnex import.

type Ready = CarOdometerRow & { baseUrl: string; secret: string };

const SKIP_MESSAGES: Record<FillSkipReason, string> = {
	too_old: "This charge is older than Home Assistant's recorded history — read the dash instead.",
	no_data: "The car didn't report an odometer around this charge — read the dash instead.",
	inconsistent: 'The car reported different odometers during this charge — read the dash instead.',
	below_previous:
		"The car's reading is below the previous session's odometer — check the dash instead."
};

/** Guards shared by every mode. A broken status pauses calls until a successful Test. */
async function readyIntegration(): Promise<
	{ ok: true; row: Ready } | { ok: false; response: Response }
> {
	const row = await getCarOdometerIntegration();
	if (!row || !row.baseUrl || !row.secret || !row.enabled) {
		return {
			ok: false,
			response: json({
				ok: false,
				status: 'disabled',
				message: 'The car odometer integration is switched off — set it up in Settings.'
			})
		};
	}
	if (isBrokenStatus(row.lastReadStatus)) {
		return {
			ok: false,
			response: json({
				ok: false,
				status: row.lastReadStatus,
				broken: true,
				message: `${brokenReason(row.lastReadStatus)}. Fix it in Settings, then tap Test.`
			})
		};
	}
	return { ok: true, row: { ...row, baseUrl: row.baseUrl, secret: row.secret } };
}

export const POST: RequestHandler = async ({ request, url }) => {
	const ready = await readyIntegration();
	if (!ready.ok) return ready.response;
	const { row } = ready;

	if (url.searchParams.get('apply') === '1') return applyToDrafts(row);

	let draftId: number | null = null;
	const text = await request.text();
	if (text) {
		try {
			const body = JSON.parse(text) as { draftId?: unknown };
			if (typeof body.draftId === 'number') draftId = body.draftId;
		} catch {
			return json(
				{ ok: false, status: 'bad_request', message: 'Invalid request.' },
				{ status: 400 }
			);
		}
	}

	if (draftId != null) {
		const [draft] = await db
			.select()
			.from(chargingSessions)
			.where(eq(chargingSessions.id, draftId));
		if (!draft) {
			return json(
				{ ok: false, status: 'bad_request', message: 'Session not found.' },
				{ status: 404 }
			);
		}
		if (draft.startedAt != null) return readForDraft(row, { ...draft, startedAt: draft.startedAt });
	}

	const result = await readCompanion(row);
	if (!result.ok) return json({ ok: false, status: result.status, message: result.message });
	const reading = latestReading(result.readings);
	return json({
		ok: true,
		match: 'current',
		km: reading?.km,
		carReportedAt: reading?.carReportedAt
	});
};

async function readForDraft(row: Ready, draft: DraftForFill) {
	const now = new Date();
	const result = await readCompanion(row, requestWindow([draft], now) ?? undefined);
	if (!result.ok) return json({ ok: false, status: result.status, message: result.message });

	const neighbours = await db.select().from(chargingSessions);
	const plan = planOdometerFill(
		[draft],
		result.readings,
		neighbours,
		result.response.oldestRecorded,
		now
	);
	const hit = plan.fill[0] ?? plan.suggest[0];
	if (!hit) {
		const reason = plan.skip[0]?.reason ?? 'no_data';
		return json({ ok: false, status: 'skip', reason, message: SKIP_MESSAGES[reason] });
	}
	return json({
		ok: true,
		match: plan.fill.length > 0 ? 'fill' : 'suggest',
		km: hit.km,
		carReportedAt: hit.carReportedAt
	});
}

async function applyToDrafts(row: Ready) {
	const [sessions, periods] = await Promise.all([
		db.select().from(chargingSessions),
		db.select().from(billingPeriods)
	]);
	const submitted = new Set(periods.filter((p) => isPeriodSubmitted(p)).map((p) => p.id));

	// Open imported drafts only: a manually-logged session always has an odometer,
	// and a draft without startedAt (imported before that column existed, and not
	// seen by a poll since) has no instants to match against.
	const drafts: DraftForFill[] = sessions
		.filter(
			(s) =>
				s.odometerKm == null &&
				s.startedAt != null &&
				(s.billingPeriodId == null || !submitted.has(s.billingPeriodId))
		)
		.map((s) => ({
			id: s.id,
			date: s.date,
			time: s.time,
			startedAt: s.startedAt as string,
			endedAt: s.endedAt
		}));

	const now = new Date();
	const window = requestWindow(drafts, now);
	if (!window) return json({ ok: true, filled: 0, suggestions: [], skipped: 0 });

	const result = await readCompanion(row, window);
	if (!result.ok) {
		// no_data here means the companion answered but had nothing for these charges —
		// every draft is simply left for the user, which isn't a failure to report loudly.
		if (result.status === 'no_data') {
			return json({ ok: true, filled: 0, suggestions: [], skipped: drafts.length });
		}
		return json({ ok: false, status: result.status, message: result.message });
	}

	const plan = planOdometerFill(
		drafts,
		result.readings,
		sessions,
		result.response.oldestRecorded,
		now
	);

	db.transaction((tx) => {
		for (const { id, km } of plan.fill) {
			tx.update(chargingSessions)
				.set({ odometerKm: km, odometerSource: 'car' })
				// Never over a value the user entered while HA was answering.
				.where(and(eq(chargingSessions.id, id), isNull(chargingSessions.odometerKm)))
				.run();
		}
	});

	return json({
		ok: true,
		filled: plan.fill.length,
		suggestions: plan.suggest,
		skipped: plan.skip.length
	});
}
