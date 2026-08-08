// Wipes and reseeds the dev database with ~6 months of realistic-looking demo
// data: settings, two versioned rate plans, a run of monthly billing periods
// (submitted, except the current in-progress one), and home/public charging
// sessions across them. Exists so a dev DB wipe (delete the sqlite file, or
// just run this) gets you back to a usable demo environment in one step,
// instead of manually clicking through the app to create test data.
//
// Run via `npm run db:seed`. Destructive: clears settings/ratePlans/
// billingPeriods/chargingSessions first (never touches evnexIntegration/
// evnexDismissedSessions — that's live credential state, not demo data).
// Refuses to run without an interactive confirmation unless --yes is passed.
import { createInterface } from 'node:readline/promises';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
	billingPeriods,
	chargingSessions,
	ratePlans,
	settings
} from '../src/lib/server/db/schema.ts';

if (!process.env.DATABASE_URL) {
	throw new Error(
		'DATABASE_URL is not set (this script reads it the same way the app does — see .env).'
	);
}

const HOME_LOCATION = '42 Example Street, Melbourne VIC 3000';
const HOME_FLAT_RATE_OLD = 0.28;
const HOME_FLAT_RATE_NEW = 0.32;

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function ymd(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthStart(year: number, month: number): Date {
	return new Date(year, month, 1);
}

function monthEnd(year: number, month: number): Date {
	return new Date(year, month + 1, 0);
}

function addDays(d: Date, days: number): Date {
	const copy = new Date(d);
	copy.setDate(copy.getDate() + days);
	return copy;
}

function monthLabel(d: Date): string {
	return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(d);
}

// Small deterministic PRNG (mulberry32) so re-running the script produces the
// same shape of demo data (times, kWh, odometer deltas) rather than a fresh
// random mess every time — only the *dates* shift, tied to today.
function mulberry32(seed: number) {
	let a = seed;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rng = mulberry32(20260808);
function randRange(min: number, max: number): number {
	return min + rng() * (max - min);
}
function pick<T>(items: T[]): T {
	return items[Math.floor(rng() * items.length)];
}
function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

async function confirm(message: string): Promise<boolean> {
	if (process.argv.includes('--yes') || process.argv.includes('-y')) return true;
	if (!process.stdin.isTTY) {
		console.error('Refusing to run non-interactively without --yes.');
		return false;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await rl.question(message);
	rl.close();
	return answer.trim().toLowerCase() === 'y';
}

async function main() {
	const databaseUrl = process.env.DATABASE_URL as string;
	mkdirSync(dirname(databaseUrl), { recursive: true });
	const client = new Database(databaseUrl);
	client.pragma('foreign_keys = OFF');
	const db = drizzle(client);
	migrate(db, { migrationsFolder: 'drizzle' });
	client.pragma('foreign_keys = ON');

	const proceed = await confirm(
		`This will WIPE settings/rate plans/billing periods/charging sessions in ${databaseUrl} and reseed ~6 months of demo data. Continue? (y/N) `
	);
	if (!proceed) {
		console.log('Aborted.');
		client.close();
		return;
	}

	db.delete(chargingSessions).run();
	db.delete(billingPeriods).run();
	db.delete(ratePlans).run();
	db.delete(settings).run();

	db.insert(settings)
		.values({
			fullName: 'Demo User',
			vehicleLabel: 'DEMO-EV1',
			homeAddress: HOME_LOCATION
		})
		.run();

	const today = new Date();
	const currentMonthStart = monthStart(today.getFullYear(), today.getMonth());

	// 6 completed calendar months before the current one, oldest first, plus the
	// current (partial, unsubmitted) month.
	const pastMonths = Array.from({ length: 6 }, (_, i) => {
		const offset = 6 - i;
		const d = new Date(today.getFullYear(), today.getMonth() - offset, 1);
		return {
			start: monthStart(d.getFullYear(), d.getMonth()),
			end: monthEnd(d.getFullYear(), d.getMonth())
		};
	});
	const months = [
		...pastMonths,
		{ start: currentMonthStart, end: monthEnd(today.getFullYear(), today.getMonth()) }
	];

	// Rate plan history: an older flat rate, then a bump partway through the
	// seeded range, so `resolveRatePlan` has something real to demonstrate.
	const rateChangeDate = ymd(pastMonths[3].start);
	db.insert(ratePlans)
		.values([
			{
				effectiveFrom: ymd(
					monthStart(pastMonths[0].start.getFullYear() - 1, pastMonths[0].start.getMonth())
				),
				type: 'flat',
				flatRate: HOME_FLAT_RATE_OLD
			},
			{ effectiveFrom: rateChangeDate, type: 'flat', flatRate: HOME_FLAT_RATE_NEW }
		])
		.run();

	function rateFor(date: string): number {
		return date >= rateChangeDate ? HOME_FLAT_RATE_NEW : HOME_FLAT_RATE_OLD;
	}

	const periodIds: { start: Date; end: Date; id: number }[] = [];
	for (const m of months) {
		const isCurrent = m.start.getTime() === currentMonthStart.getTime();
		const [row] = db
			.insert(billingPeriods)
			.values({
				label: monthLabel(m.start),
				startDate: ymd(m.start),
				endDate: ymd(m.end),
				submittedAt: isCurrent ? null : addDays(m.end, 4).toISOString()
			})
			.returning()
			.all();
		periodIds.push({ start: m.start, end: m.end, id: row.id });
	}

	function periodIdFor(date: string): number {
		return periodIds.find((p) => ymd(p.start) <= date && date <= ymd(p.end))!.id;
	}

	// Walk day by day from the start of the seeded range to today, charging at
	// home roughly every 3 days and stopping for a public charge roughly once a
	// month, with a plausible efficiency (km driven per kWh) driving the
	// odometer forward rather than incrementing it arbitrarily.
	type SeedSession = {
		date: string;
		time: string;
		kind: 'home' | 'public';
		odometerKm: number;
		kwhUsed: number;
		location: string;
	};
	const sessions: SeedSession[] = [];
	let odometerKm = 38000 + Math.floor(randRange(0, 2000));
	let cursor = new Date(pastMonths[0].start);
	let daysSinceHome = 0;
	let daysSincePublic = 0;
	while (cursor <= today) {
		daysSinceHome++;
		daysSincePublic++;

		if (daysSinceHome >= 3) {
			const kwhUsed = round2(randRange(20, 42));
			odometerKm += Math.round(kwhUsed * randRange(5.5, 7.5));
			sessions.push({
				date: ymd(cursor),
				time: pick(['18:15', '19:40', '21:05', '22:30', '23:10']),
				kind: 'home',
				odometerKm,
				kwhUsed,
				location: HOME_LOCATION
			});
			daysSinceHome = 0;
		}

		if (daysSincePublic >= 26) {
			const kwhUsed = round2(randRange(15, 28));
			odometerKm += Math.round(kwhUsed * randRange(4, 6));
			sessions.push({
				date: ymd(cursor),
				time: pick(['12:20', '13:45', '16:10']),
				kind: 'public',
				odometerKm,
				kwhUsed,
				location: pick([
					'Chargefox – Ngauranga',
					'ChargeNet – Petone',
					'Tesla Supercharger – Porirua'
				])
			});
			daysSincePublic = 0;
		}

		cursor = addDays(cursor, 1);
	}

	// Leave the most recent session (necessarily in the current, unsubmitted
	// period) as a draft, to demonstrate the "complete a session" flow.
	const lastSession = sessions[sessions.length - 1];
	const draftKwh = lastSession.kwhUsed;

	for (const s of sessions) {
		const isDraft = s === lastSession;
		const kwhUsed = isDraft ? null : s.kwhUsed;
		const cost = !isDraft && s.kind === 'home' ? round2(kwhUsed! * rateFor(s.date)) : null;
		db.insert(chargingSessions)
			.values({
				billingPeriodId: periodIdFor(s.date),
				kind: s.kind,
				date: s.date,
				time: s.time,
				odometerKm: s.odometerKm,
				kwhUsed,
				location: s.location,
				cost,
				notes: null
			})
			.run();
	}

	console.log(
		`Seeded ${sessions.length} sessions across ${months.length} billing periods (${monthLabel(pastMonths[0].start)} – ${monthLabel(currentMonthStart)}). Draft session left at ${lastSession.date} ${lastSession.time} (${draftKwh} kWh pending).`
	);
	client.close();
}

main();
