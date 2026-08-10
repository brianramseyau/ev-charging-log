import { db } from '$lib/server/db';
import { billingPeriods, chargingSessions } from '$lib/server/db/schema';
import {
	computeCurrentPeriodStats,
	computeEfficiencySeries,
	computeKpis,
	computePeriodSplits,
	excludeCurrentPeriod,
	findCurrentPeriod,
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

	// Drafts (kwhUsed not yet recorded) are excluded until completed rather
	// than skewing efficiency, cost, and split figures with incomplete data.
	const sessions: DashboardSession[] = sessionRows
		.filter((row) => row.kwhUsed != null)
		.map((row) => ({
			id: row.id,
			kind: row.kind,
			date: row.date,
			time: row.time,
			odometerKm: row.odometerKm,
			kwhUsed: row.kwhUsed ?? 0,
			cost: row.cost,
			billingPeriodId: row.billingPeriodId
		}));

	const periods: DashboardPeriod[] = periodRows.map((row) => ({
		id: row.id,
		label: row.label,
		startDate: row.startDate,
		endDate: row.endDate,
		submittedAt: row.submittedAt
	}));

	// The current (not-yet-submitted) period is carved out of everything below
	// it: it's still accumulating sessions, so it gets its own stats up top
	// instead of appearing as a misleadingly-partial bar/point in the
	// historical charts.
	const currentPeriod = findCurrentPeriod(periods);
	const efficiencySeriesAll = computeEfficiencySeries(sessions);
	const currentPeriodStats = computeCurrentPeriodStats(
		currentPeriod,
		sessions,
		efficiencySeriesAll
	);

	const { historicalPeriods, historicalSessions } = excludeCurrentPeriod(
		periods,
		sessions,
		currentPeriod
	);
	const efficiencySeries = computeEfficiencySeries(historicalSessions);
	const periodSplits = computePeriodSplits(historicalPeriods, historicalSessions);

	// Lifetime KPIs stay cumulative (including whatever's logged in the
	// current period so far) — only the period-comparison charts above exclude it.
	const kpis = computeKpis(sessions, efficiencySeriesAll);

	return { efficiencySeries, periodSplits, kpis, currentPeriodStats };
};
