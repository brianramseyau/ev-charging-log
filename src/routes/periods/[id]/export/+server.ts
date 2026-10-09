import { db } from '$lib/server/db';
import { billingPeriods, chargingSessions, settings } from '$lib/server/db/schema';
import { generateReport, groupReportSessions } from '$lib/server/report';
import { asc, eq } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

function toReportSession(s: typeof chargingSessions.$inferSelect) {
	return {
		time: s.time,
		date: s.date,
		kind: s.kind,
		odometerKm: s.odometerKm,
		kwhUsed: s.kwhUsed,
		location: s.location,
		cost: s.cost
	};
}

export const GET: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) throw error(404, 'Billing period not found');

	const [period] = await db.select().from(billingPeriods).where(eq(billingPeriods.id, id));
	if (!period) throw error(404, 'Billing period not found');

	const sessions = await db
		.select()
		.from(chargingSessions)
		.where(eq(chargingSessions.billingPeriodId, id))
		.orderBy(asc(chargingSessions.date), asc(chargingSessions.time), asc(chargingSessions.id));

	const [settingsRow] = await db.select().from(settings).limit(1);

	// A charge interrupted by a quick unplug/move/replug yields adjacent sessions
	// reading the same odometer; the later ones would otherwise be 0 km lines in
	// the report. Merge runs of genuinely back-to-back sessions per kind, with a
	// kind change or an incomplete draft acting as a boundary (see
	// groupReportSessions) so a public charge or draft between two home sessions
	// doesn't let them combine. Drafts (no kWh yet) are excluded, as before.
	const { home: homeSessions, public: publicSessions } = groupReportSessions(
		sessions.map(toReportSession)
	);

	const buffer = await generateReport(
		{ label: period.label, startDate: period.startDate, endDate: period.endDate },
		homeSessions,
		publicSessions,
		settingsRow
			? { fullName: settingsRow.fullName, vehicleLabel: settingsRow.vehicleLabel }
			: undefined
	);

	const filename = `${period.label.replace(/[^a-z0-9]+/gi, '-')}-home-charging-report.xlsx`;

	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'Content-Disposition': `attachment; filename="${filename}"`
		}
	});
};
