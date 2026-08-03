import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import { db } from '$lib/server/db';
import { billingPeriods, chargingSessions } from '$lib/server/db/schema';
import { parseImportWorkbook, type ImportIssue } from '$lib/server/import';

interface ReviewRow {
	time: string;
	date: string;
	odometerKm: string;
	kwhUsed: string;
	location: string;
	excluded: boolean;
}

interface ReviewState {
	fullName: string;
	vehicleLabel: string;
	startDate: string;
	endDate: string;
	periodLabel: string;
	claimingKwh: string;
	rateKwh: string;
	homeRows: ReviewRow[];
	publicRows: ReviewRow[];
	issues: ImportIssue[];
}

export type UploadFormResult =
	{ step: 'review'; review: ReviewState } | { step: 'done'; label: string; sessionCount: number };

function suggestLabel(startDate: string | null): string {
	if (!startDate) return '';
	const d = new Date(startDate);
	if (Number.isNaN(d.getTime())) return '';
	return new Intl.DateTimeFormat('en-US', {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	}).format(d);
}

export const actions: Actions = {
	upload: async ({ request }) => {
		const formData = await request.formData();
		const file = formData.get('file');

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { step: 'upload' as const, error: 'Choose a .xlsx file to upload.' });
		}

		let buffer: Buffer;
		try {
			buffer = Buffer.from(await file.arrayBuffer());
		} catch {
			return fail(400, { step: 'upload' as const, error: 'Could not read the uploaded file.' });
		}

		let parsed;
		try {
			parsed = await parseImportWorkbook(buffer);
		} catch (err) {
			return fail(400, {
				step: 'upload' as const,
				error: `Could not parse the workbook: ${err instanceof Error ? err.message : String(err)}`
			});
		}

		const review: ReviewState = {
			fullName: parsed.header.fullName ?? '',
			vehicleLabel: parsed.header.vehicleLabel ?? '',
			startDate: parsed.header.startDate ?? '',
			endDate: parsed.header.endDate ?? '',
			periodLabel: suggestLabel(parsed.header.startDate),
			claimingKwh: parsed.header.claimingKwh?.toString() ?? '',
			rateKwh: parsed.header.rateKwh?.toString() ?? '',
			homeRows: parsed.homeSessions.map((s) => ({
				time: s.time ?? '',
				date: s.date ?? '',
				odometerKm: s.odometerKm?.toString() ?? '',
				kwhUsed: s.kwhUsed?.toString() ?? '',
				location: s.location ?? '',
				excluded: false
			})),
			publicRows: parsed.publicSessions.map((s) => ({
				time: s.time ?? '',
				date: s.date ?? '',
				odometerKm: s.odometerKm?.toString() ?? '',
				kwhUsed: s.kwhUsed?.toString() ?? '',
				location: s.location ?? '',
				excluded: false
			})),
			issues: parsed.issues
		};

		return { step: 'review' as const, review };
	},

	commit: async ({ request }) => {
		const formData = await request.formData();

		const label = String(formData.get('periodLabel') ?? '').trim();
		const startDate = String(formData.get('startDate') ?? '').trim();
		const endDate = String(formData.get('endDate') ?? '').trim();

		if (!label || !startDate || !endDate) {
			return fail(400, {
				step: 'commit-error' as const,
				error: 'Period label, start date, and end date are all required to commit the import.'
			});
		}

		function readRows(kind: 'home' | 'public') {
			const count = Number(formData.get(`${kind}Count`) ?? 0);
			const rows: {
				kind: 'home' | 'public';
				date: string;
				time: string;
				odometerKm: number;
				kwhUsed: number;
				location: string;
			}[] = [];

			for (let i = 0; i < count; i++) {
				const excluded = formData.get(`${kind}-${i}-excluded`) === 'on';
				if (excluded) continue;

				const date = String(formData.get(`${kind}-${i}-date`) ?? '').trim();
				const time = String(formData.get(`${kind}-${i}-time`) ?? '').trim();
				const odometerKm = Number(formData.get(`${kind}-${i}-odometerKm`) ?? '');
				const kwhUsed = Number(formData.get(`${kind}-${i}-kwhUsed`) ?? '');
				const location = String(formData.get(`${kind}-${i}-location`) ?? '').trim();

				if (!date || !time || Number.isNaN(odometerKm) || Number.isNaN(kwhUsed) || !location) {
					// Skip rows still missing required data rather than failing the whole
					// import — the user was shown these as flagged issues on the review screen.
					continue;
				}

				rows.push({ kind, date, time, odometerKm, kwhUsed, location });
			}

			return rows;
		}

		const homeRows = readRows('home');
		const publicRows = readRows('public');

		if (homeRows.length === 0 && publicRows.length === 0) {
			return fail(400, {
				step: 'commit-error' as const,
				error: 'No valid session rows to import — fix the flagged rows and try again.'
			});
		}

		const sessionCount = db.transaction((tx) => {
			const period = tx
				.insert(billingPeriods)
				.values({ label, startDate, endDate })
				.returning()
				.get();

			const allRows = [...homeRows, ...publicRows];
			for (const row of allRows) {
				tx.insert(chargingSessions)
					.values({
						billingPeriodId: period.id,
						kind: row.kind,
						date: row.date,
						time: row.time,
						odometerKm: row.odometerKm,
						kwhUsed: row.kwhUsed,
						location: row.location
					})
					.run();
			}

			return allRows.length;
		});

		return { step: 'done' as const, label, sessionCount };
	}
};
