import { db } from '$lib/server/db';
import { billingPeriods, chargingSessions, settings } from '$lib/server/db/schema';
import { generateReport, type ReportSession } from '$lib/server/report';
import { asc, eq } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

function toReportSession(s: typeof chargingSessions.$inferSelect): ReportSession {
	return {
		time: s.time,
		date: s.date,
		odometerKm: s.odometerKm,
		kwhUsed: s.kwhUsed ?? 0,
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
		.orderBy(asc(chargingSessions.date), asc(chargingSessions.time));

	const [settingsRow] = await db.select().from(settings).limit(1);

	// Drafts have no kWh/cost yet; ?/submit already blocks submitting a period
	// while any remain, but exclude them here too in case the export link is
	// hit directly on an unsubmitted period.
	const completedSessions = sessions.filter((s) => !s.isDraft);
	const homeSessions = completedSessions.filter((s) => s.kind === 'home').map(toReportSession);
	const publicSessions = completedSessions.filter((s) => s.kind === 'public').map(toReportSession);

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
