import { db } from '$lib/server/db';
import { billingPeriods, chargingSessions } from '$lib/server/db/schema';
import {
	computeEfficiencySeries,
	computeKpis,
	computePeriodSplits,
	type DashboardPeriod,
	type DashboardSession
} from '$lib/dashboard';
import type { PageServerLoad } from './$types';

// This route has no separate API layer (per PLAN.md — SvelteKit server routes
// serve as the API directly): it reads sessions + billing periods from SQLite
// and hands the pure calculation helpers in $lib/dashboard.ts everything they
// need to produce the personal dashboard (§5.5). Not part of the lease report.
export const load: PageServerLoad = async () => {
	const [sessionRows, periodRows] = await Promise.all([
		db.select().from(chargingSessions),
		db.select().from(billingPeriods)
	]);

	const sessions: DashboardSession[] = sessionRows.map((row) => ({
		id: row.id,
		kind: row.kind,
		date: row.date,
		time: row.time,
		odometerKm: row.odometerKm,
		kwhUsed: row.kwhUsed,
		cost: row.cost,
		billingPeriodId: row.billingPeriodId
	}));

	const periods: DashboardPeriod[] = periodRows.map((row) => ({
		id: row.id,
		label: row.label,
		startDate: row.startDate,
		endDate: row.endDate
	}));

	const efficiencySeries = computeEfficiencySeries(sessions);
	const periodSplits = computePeriodSplits(periods, sessions);
	const kpis = computeKpis(sessions, periods, efficiencySeries);

	return { efficiencySeries, periodSplits, kpis };
};
