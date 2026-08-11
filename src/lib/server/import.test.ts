import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseImportWorkbook } from './import';

// Builds a synthetic workbook matching the documented legacy layout (PLAN.md §2),
// entirely with fabricated data — never derived from the real spreadsheet.
//
// `options.blankRowsBetweenSections` lets tests vary how much blank padding
// separates sections, since real files aren't consistent about this.
interface FixtureOptions {
	blankRowsBefore?: number;
	blankRowsBetweenTables?: number;
	homeRows?: ExcelJS.CellValue[][];
	publicRows?: ExcelJS.CellValue[][];
	/** Real-world files often never repeat the column header row for this table. */
	publicHasHeaderRow?: boolean;
}

async function buildFixture(options: FixtureOptions = {}): Promise<Buffer> {
	const {
		blankRowsBefore = 0,
		blankRowsBetweenTables = 1,
		homeRows = [
			['08:30', new Date('2026-07-01'), 12000, 8.5, 'Test User Garage'],
			['19:15', new Date('2026-07-05'), 12210, 10.2, 'Test User Garage']
		],
		publicRows = [['13:00', new Date('2026-07-10'), 12400, 15.0, '123 Fake St Charger']],
		publicHasHeaderRow = true
	} = options;

	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Sheet1');

	let r = 1;
	for (let i = 0; i < blankRowsBefore; i++) r++;

	sheet.getCell(`A${r}`).value = 'Full Name:';
	sheet.getCell(`B${r}`).value = 'Test User';
	r++;
	sheet.getCell(`A${r}`).value = 'Vin or Vehicle Registration:';
	sheet.getCell(`B${r}`).value = 'TEST-123';
	r++;
	sheet.getCell(`A${r}`).value = 'Starting Date:';
	sheet.getCell(`B${r}`).value = new Date('2026-07-01');
	r++;
	sheet.getCell(`A${r}`).value = 'Closing Date:';
	sheet.getCell(`B${r}`).value = new Date('2026-07-31');
	r++;
	sheet.getCell(`A${r}`).value = 'Claiming kW/h:';
	sheet.getCell(`B${r}`).value = 123.4;
	r++;
	sheet.getCell(`A${r}`).value = 'Rate kW/h:';
	sheet.getCell(`B${r}`).value = 0.28;
	r++;
	r++; // blank spacer row

	// Home table header
	const homeHeaderCols = ['Time', 'Date', 'Odometer', 'kWh Used', 'Location'];
	homeHeaderCols.forEach((label, i) => {
		sheet.getCell(r, i + 1).value = label;
	});
	r++;

	for (const dataRow of homeRows) {
		dataRow.forEach((v, i) => {
			sheet.getCell(r, i + 1).value = v;
		});
		r++;
	}

	for (let i = 0; i < blankRowsBetweenTables; i++) r++;

	sheet.getCell(`A${r}`).value = 'Commercial Charging already claimed through portal';
	r++;
	r++; // blank spacer

	if (publicHasHeaderRow) {
		['Time', 'Date', 'Odometer', 'kWh Used', 'Location'].forEach((label, i) => {
			sheet.getCell(r, i + 1).value = label;
		});
		r++;
	}

	for (const dataRow of publicRows) {
		dataRow.forEach((v, i) => {
			sheet.getCell(r, i + 1).value = v;
		});
		r++;
	}

	r++;
	r++;
	sheet.getCell(`A${r}`).value = 'Total Kwh Used';
	sheet.getCell(`B${r}`).value = 18.7;
	r++;
	sheet.getCell(`A${r}`).value = 'Cost';
	sheet.getCell(`B${r}`).value = 5.24;
	r++;
	sheet.getCell(`A${r}`).value = 'Total Kwh Claimed';
	sheet.getCell(`B${r}`).value = 15.0;
	r++;
	sheet.getCell(`A${r}`).value = 'Percentage of Home charging';
	sheet.getCell(`B${r}`).value = '55%';

	const arrayBuffer = await workbook.xlsx.writeBuffer();
	return Buffer.from(arrayBuffer);
}

describe('parseImportWorkbook', () => {
	it('parses header fields and both session tables in the normal case', async () => {
		const buffer = await buildFixture();
		const result = await parseImportWorkbook(buffer);

		expect(result.header.fullName).toBe('Test User');
		expect(result.header.vehicleLabel).toBe('TEST-123');
		expect(result.header.startDate).toBe('2026-07-01');
		expect(result.header.endDate).toBe('2026-07-31');
		expect(result.header.claimingKwh).toBeCloseTo(123.4);
		expect(result.header.rateKwh).toBeCloseTo(0.28);

		expect(result.homeSessions).toHaveLength(2);
		expect(result.homeSessions[0]).toMatchObject({
			kind: 'home',
			date: '2026-07-01',
			odometerKm: 12000,
			kwhUsed: 8.5,
			location: 'Test User Garage'
		});
		expect(result.homeSessions[1]).toMatchObject({
			kind: 'home',
			date: '2026-07-05',
			odometerKm: 12210,
			kwhUsed: 10.2
		});

		expect(result.publicSessions).toHaveLength(1);
		expect(result.publicSessions[0]).toMatchObject({
			kind: 'public',
			date: '2026-07-10',
			odometerKm: 12400,
			kwhUsed: 15,
			location: '123 Fake St Charger'
		});

		expect(result.issues).toHaveLength(0);
	});

	it('flags a row with a missing field instead of throwing', async () => {
		const buffer = await buildFixture({
			homeRows: [
				['08:30', new Date('2026-07-01'), 12000, 8.5, 'Test User Garage'],
				// missing odometer and location
				['19:15', new Date('2026-07-05'), null, 10.2, null]
			]
		});

		const result = await parseImportWorkbook(buffer);

		expect(result.homeSessions).toHaveLength(2);
		expect(result.homeSessions[1].odometerKm).toBeNull();
		expect(result.homeSessions[1].location).toBeNull();

		const rowIssues = result.issues.filter((i) => i.section === 'home');
		expect(rowIssues.length).toBeGreaterThan(0);
		expect(rowIssues[0].message).toMatch(/missing/i);
	});

	it('finds sections correctly despite extra blank rows between them', async () => {
		const buffer = await buildFixture({
			blankRowsBefore: 3,
			blankRowsBetweenTables: 4
		});

		const result = await parseImportWorkbook(buffer);

		expect(result.header.fullName).toBe('Test User');
		expect(result.homeSessions).toHaveLength(2);
		expect(result.publicSessions).toHaveLength(1);
		expect(result.issues).toHaveLength(0);
	});

	it('parses the public table when it has no header row of its own (real-world layout)', async () => {
		// Matches the actual legacy file layout: the public/commercial table
		// reuses the home table's column order but never repeats the header
		// row, and its "Total"/"Percentage" summary rows put their label in
		// the date/odometer columns rather than the time column.
		const buffer = await buildFixture({ publicHasHeaderRow: false });
		const result = await parseImportWorkbook(buffer);

		expect(result.issues.filter((i) => i.section === 'public')).toHaveLength(0);
		expect(result.publicSessions).toHaveLength(1);
		expect(result.publicSessions[0]).toMatchObject({
			kind: 'public',
			date: '2026-07-10',
			odometerKm: 12400,
			kwhUsed: 15,
			location: '123 Fake St Charger'
		});
	});

	it('stops a session table at a summary row even when the label lands outside the time column', async () => {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('Sheet1');
		sheet.getCell('A1').value = 'Full Name:';
		sheet.getCell('B1').value = 'Test User';

		['Time', 'Date', 'Odometer', 'kWh Used', 'Location'].forEach((label, i) => {
			sheet.getCell(3, i + 1).value = label;
		});
		sheet.getCell('A4').value = '08:30';
		sheet.getCell('B4').value = new Date('2026-07-01');
		sheet.getCell('C4').value = 12000;
		sheet.getCell('D4').value = 8.5;
		sheet.getCell('E4').value = 'Test User Garage';

		// Summary row: label sits in columns B/C (date/odometer), not A (time),
		// mirroring the real spreadsheet's "Total Kwh Used" / "Total Kwh Used" pair.
		sheet.getCell('B5').value = 'Total Kwh Used';
		sheet.getCell('C5').value = 'Total Kwh Used';
		sheet.getCell('D5').value = 8.5;

		const arrayBuffer = await workbook.xlsx.writeBuffer();
		const buffer = Buffer.from(arrayBuffer);

		const result = await parseImportWorkbook(buffer);

		expect(result.homeSessions).toHaveLength(1);
		expect(result.issues.filter((i) => i.section === 'home')).toHaveLength(0);
	});

	it('parses dates and times cached as formula results, not just bare values', async () => {
		// Legacy files frequently fill session dates/times by dragging a formula
		// down from the row above (e.g. `=B4+1`). ExcelJS returns these as
		// `{ formula, result }` rather than a bare Date, even when the cached
		// result is a Date — this must still resolve to a valid date/time.
		const buffer = await buildFixture({
			homeRows: [
				[
					{ formula: 'A1', result: new Date(Date.UTC(1899, 11, 31, 8, 30)) },
					new Date('2026-07-01'),
					12000,
					8.5,
					'Test User Garage'
				],
				[
					{ formula: 'A2+1', result: new Date(Date.UTC(1899, 11, 31, 19, 15)) },
					{ formula: 'B4+1', result: new Date('2026-07-05') },
					12210,
					10.2,
					'Test User Garage'
				]
			]
		});

		const result = await parseImportWorkbook(buffer);

		expect(result.issues.filter((i) => i.section === 'home')).toHaveLength(0);
		expect(result.homeSessions).toHaveLength(2);
		expect(result.homeSessions[0]).toMatchObject({ time: '08:30', date: '2026-07-01' });
		expect(result.homeSessions[1]).toMatchObject({ time: '19:15', date: '2026-07-05' });
	});

	it('normalizes 12-hour AM/PM time text instead of silently dropping it', async () => {
		// Some months' files enter times as 12-hour text ("8:30 AM") instead of
		// an Excel time value. `<input type="time">` requires 24-hour HH:MM, so
		// this must be converted rather than passed through as-is.
		const buffer = await buildFixture({
			homeRows: [
				['8:30 AM', new Date('2026-07-01'), 12000, 8.5, 'Test User Garage'],
				['7:15 PM', new Date('2026-07-05'), 12210, 10.2, 'Test User Garage'],
				['12:00 AM', new Date('2026-07-10'), 12300, 5.0, 'Test User Garage'],
				['12:30 PM', new Date('2026-07-12'), 12400, 6.0, 'Test User Garage']
			]
		});

		const result = await parseImportWorkbook(buffer);

		expect(result.issues.filter((i) => i.section === 'home')).toHaveLength(0);
		expect(result.homeSessions).toHaveLength(4);
		expect(result.homeSessions[0].time).toBe('08:30');
		expect(result.homeSessions[1].time).toBe('19:15');
		expect(result.homeSessions[2].time).toBe('00:00');
		expect(result.homeSessions[3].time).toBe('12:30');
	});

	it('flags a row instead of silently dropping unparseable date/time text', async () => {
		const buffer = await buildFixture({
			homeRows: [['not a time', 'not a date', 12000, 8.5, 'Test User Garage']]
		});

		const result = await parseImportWorkbook(buffer);

		expect(result.homeSessions).toHaveLength(1);
		expect(result.homeSessions[0].time).toBeNull();
		expect(result.homeSessions[0].date).toBeNull();

		const rowIssues = result.issues.filter((i) => i.section === 'home');
		expect(rowIssues.length).toBeGreaterThan(0);
		expect(rowIssues[0].message).toMatch(/missing/i);
	});

	it("flags a row whose date falls outside the sheet's own claimed period range", async () => {
		// Simulates a legacy file copied forward from an old template with a
		// stale cell left behind — every field is populated, so nothing else
		// would catch this, but the year is nonsensical for a July 2026 sheet.
		const buffer = await buildFixture({
			homeRows: [
				['08:30', new Date('2026-07-01'), 12000, 8.5, 'Test User Garage'],
				['19:15', new Date('2023-07-05'), 12210, 10.2, 'Test User Garage']
			]
		});

		const result = await parseImportWorkbook(buffer);

		expect(result.homeSessions).toHaveLength(2);
		expect(result.homeSessions[1].date).toBe('2023-07-05');

		const rowIssues = result.issues.filter((i) => i.section === 'home');
		expect(rowIssues).toHaveLength(1);
		expect(rowIssues[0].message).toMatch(/outside the claimed period/i);
		expect(rowIssues[0].row).toBe(result.homeSessions[1].row);
	});

	it('does not flag a date within the claimed period range', async () => {
		const buffer = await buildFixture();
		const result = await parseImportWorkbook(buffer);
		expect(result.issues).toHaveLength(0);
	});

	it('flags an unparseable home table when no table header row exists anywhere', async () => {
		// Build a minimal sheet with only header fields and a malformed table
		// header (missing the Location column) — no valid 5-column header row
		// exists anywhere in the sheet, so the home table can't be located.
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('Sheet1');
		sheet.getCell('A1').value = 'Full Name:';
		sheet.getCell('B1').value = 'Test User';
		sheet.getCell('A2').value = 'Starting Date:';
		sheet.getCell('B2').value = new Date('2026-07-01');
		sheet.getCell('A3').value = 'Closing Date:';
		sheet.getCell('B3').value = new Date('2026-07-31');
		['Time', 'Date', 'Odometer', 'kWh Used'].forEach((label, i) => {
			sheet.getCell(5, i + 1).value = label;
		});
		sheet.getCell('A6').value = '08:30';
		sheet.getCell('B6').value = new Date('2026-07-01');
		sheet.getCell('C6').value = 12000;
		sheet.getCell('D6').value = 8.5;

		const arrayBuffer = await workbook.xlsx.writeBuffer();
		const buffer = Buffer.from(arrayBuffer);

		const result = await parseImportWorkbook(buffer);

		expect(result.issues.some((i) => i.section === 'home')).toBe(true);
		expect(result.homeSessions).toHaveLength(0);
		expect(result.publicSessions).toHaveLength(0);
	});
});
