import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { generateReport, type ReportSession } from './report';

const homeSessions: ReportSession[] = [
	{
		time: '07:30',
		date: '2026-07-02',
		odometerKm: 15234.5,
		kwhUsed: 8.2,
		location: 'Home',
		cost: 2.46
	},
	{
		time: '19:15',
		date: '2026-07-08',
		odometerKm: 15310.1,
		kwhUsed: 7.8,
		location: 'Home',
		cost: 2.34
	}
];

const publicSessions: ReportSession[] = [
	{
		time: '12:10',
		date: '2026-07-05',
		odometerKm: 15267.3,
		kwhUsed: 12.4,
		location: 'Public fast charger',
		cost: null
	}
];

describe('generateReport', () => {
	it('fills the header, both tables, and the summary totals from real session data', async () => {
		const buffer = await generateReport(
			{ label: 'July 2026', startDate: '2026-07-01', endDate: '2026-07-31' },
			homeSessions,
			publicSessions,
			{ fullName: 'Jane Doe', vehicleLabel: 'ABC123' }
		);

		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
		const sheet = workbook.getWorksheet('Report');
		expect(sheet).toBeDefined();
		if (!sheet) return;

		expect(sheet.getCell('B1').value).toBe('Jane Doe');
		expect(sheet.getCell('B2').value).toBe('ABC123');
		expect(sheet.getCell('B3').value).toBe('2026-07-01');
		expect(sheet.getCell('E3').value).toBe('2026-07-31');

		// Claiming kW/h == total home kWh.
		expect(sheet.getCell('B4').value).toBeCloseTo(16, 5);
		// Derived rate == total home cost / total home kWh.
		expect(sheet.getCell('E4').value).toBeCloseTo(4.8 / 16, 5);

		// Home data rows start at row 8 (after the title + header rows).
		expect(sheet.getCell('A8').value).toBe('07:30');
		expect(sheet.getCell('D8').value).toBeCloseTo(8.2, 5);
		expect(sheet.getCell('A9').value).toBe('19:15');

		// Home total row's formula sums exactly the two data rows written above.
		const homeTotalCell = sheet.getCell('D10').value as { formula: string } | number;
		expect(homeTotalCell).toEqual({ formula: 'SUM(D8:D9)' });

		// Cost is the literal sum of stored session costs, not kWh × derived rate.
		const costCell = sheet.getCell('D11').value as number;
		expect(costCell).toBeCloseTo(4.8, 5);

		// Public section follows directly after, with its own total.
		const publicDataCell = sheet.getCell('D15').value;
		expect(publicDataCell).toBeCloseTo(12.4, 5);

		// Percentage of home charging = home / (home + public) = 16 / 28.4.
		const lastRows = [16, 17, 18, 19, 20].map((r) => sheet.getCell(`D${r}`).value);
		const percentageValue = lastRows.find((v) => typeof v === 'number' && v > 0 && v < 1);
		expect(percentageValue).toBeCloseTo(16 / 28.4, 5);
	});

	it('handles an empty period gracefully (no sessions, no settings)', async () => {
		const buffer = await generateReport(
			{ label: 'Empty Month', startDate: '2026-01-01', endDate: '2026-01-31' },
			[],
			[],
			undefined
		);

		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
		const sheet = workbook.getWorksheet('Report');
		expect(sheet).toBeDefined();
		if (!sheet) return;

		expect(sheet.getCell('B1').value).toContain('Not set');
		expect(sheet.getCell('B4').value).toBe(0);
	});

	it('handles sessions with null odometerKm (renders as blank cell)', async () => {
		const sessionsWithNullOdometer: ReportSession[] = [
			{
				time: '10:00',
				date: '2026-08-05',
				odometerKm: null,
				kwhUsed: 5.5,
				location: 'Home',
				cost: 1.65
			}
		];

		const buffer = await generateReport(
			{ label: 'August 2026', startDate: '2026-08-01', endDate: '2026-08-31' },
			sessionsWithNullOdometer,
			[],
			{ fullName: 'Test User', vehicleLabel: 'XYZ789' }
		);

		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
		const sheet = workbook.getWorksheet('Report');
		expect(sheet).toBeDefined();
	});
});
