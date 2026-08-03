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
		.orderBy(asc(chargingSessions.date), asc(chargingSessions.time));

	const [settingsRow] = await db.select().from(settings).limit(1);

	const homeSessions = sessions.filter((s) => s.kind === 'home').map(toReportSession);
	const publicSessions = sessions.filter((s) => s.kind === 'public').map(toReportSession);

	const buffer = await generateReport(
		{ label: period.label, startDate: period.startDate, endDate: period.endDate },
		homeSessions,
		publicSessions,
		settingsRow
			? { fullName: settingsRow.fullName, vehicleLabel: settingsRow.vehicleLabel }
			: undefined
	);

	const filename = `${period.label.replace(/[^a-z0-9]+/gi, '-')}-home-charging-report.xlsx`;

	// Mark the period as submitted once the report has actually been generated.
	await db
		.update(billingPeriods)
		.set({ submittedAt: new Date().toISOString() })
		.where(eq(billingPeriods.id, id));

	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'Content-Disposition': `attachment; filename="${filename}"`
		}
	});
};
