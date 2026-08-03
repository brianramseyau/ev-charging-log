// Fills the sanitized xlsx template (static/templates/home-charging-template.xlsx,
// see scripts/generate-template.mjs) with a billing period's real session data and
// returns the filled workbook as a Buffer, ready to stream back as a download.
//
// The template's shape mirrors the original lease-company spreadsheet (see
// PLAN.md §2): a header block, a home charging table, a public/commercial
// charging table, and a summary block (home kWh/cost, public kWh, home %).
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ReportSession {
	time: string;
	date: string;
	odometerKm: number;
	kwhUsed: number;
	location: string;
	cost: number | null;
}

export interface ReportPeriod {
	label: string;
	startDate: string;
	endDate: string;
}

export interface ReportSettings {
	fullName: string;
	vehicleLabel: string;
}

const TEMPLATE_PATH = join(process.cwd(), 'static/templates/home-charging-template.xlsx');

const TEAL = 'FF0F766E';
const TEAL_LIGHT = 'FFE0F2F1';
const WHITE = 'FFFFFFFF';
const BORDER_THIN = { style: 'thin' as const, color: { argb: 'FFCBD5E1' } };
const THIN_BORDER = {
	top: BORDER_THIN,
	left: BORDER_THIN,
	bottom: BORDER_THIN,
	right: BORDER_THIN
};

function sumKwh(sessions: ReportSession[]): number {
	return sessions.reduce((total, s) => total + s.kwhUsed, 0);
}

function sumCost(sessions: ReportSession[]): number {
	return sessions.reduce((total, s) => total + (s.cost ?? 0), 0);
}

// The template already has several rows merged (title/total/percentage rows). Since
// the export rebuilds the sheet's row layout to fit the actual number of sessions,
// those merges may now land on different rows than the template had them on — unmerge
// first so re-merging the (possibly shifted) range doesn't throw.
function safeMerge(sheet: ExcelJS.Worksheet, row: number, fromCol: number, toCol: number) {
	try {
		sheet.unMergeCells(row, fromCol, row, toCol);
	} catch {
		// no-op: nothing was merged there yet
	}
	sheet.mergeCells(row, fromCol, row, toCol);
}

function titleRow(sheet: ExcelJS.Worksheet, rowNumber: number, text: string) {
	const row = sheet.getRow(rowNumber);
	safeMerge(sheet, rowNumber, 1, 5);
	const cell = row.getCell(1);
	cell.value = text;
	cell.font = { bold: true, color: { argb: WHITE }, size: 12 };
	cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
	cell.alignment = { vertical: 'middle' };
	row.height = 22;
}

function tableHeaderRow(sheet: ExcelJS.Worksheet, rowNumber: number) {
	const headers = ['Time', 'Date', 'Odometer', 'kWh Used', 'Location'];
	const row = sheet.getRow(rowNumber);
	headers.forEach((h, i) => {
		const cell = row.getCell(i + 1);
		cell.value = h;
		cell.font = { bold: true, color: { argb: 'FF0F766E' } };
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL_LIGHT } };
		cell.border = THIN_BORDER;
		cell.alignment = { horizontal: 'left' };
	});
}

function dataRow(sheet: ExcelJS.Worksheet, rowNumber: number, s: ReportSession) {
	const row = sheet.getRow(rowNumber);
	const values: unknown[] = [s.time, s.date, s.odometerKm, s.kwhUsed, s.location];
	values.forEach((v, i) => {
		const cell = row.getCell(i + 1);
		cell.value = v as ExcelJS.CellValue;
		cell.border = THIN_BORDER;
		if (i === 2) cell.numFmt = '#,##0.0';
		if (i === 3) cell.numFmt = '0.00';
	});
}

function emptyRow(sheet: ExcelJS.Worksheet, rowNumber: number, text: string) {
	const row = sheet.getRow(rowNumber);
	safeMerge(sheet, rowNumber, 1, 5);
	const cell = row.getCell(1);
	cell.value = text;
	cell.font = { italic: true, color: { argb: 'FF64748B' } };
	cell.alignment = { horizontal: 'center' };
}

function totalRow(
	sheet: ExcelJS.Worksheet,
	rowNumber: number,
	label: string,
	formula: string,
	numFmt = '#,##0.00'
) {
	const row = sheet.getRow(rowNumber);
	safeMerge(sheet, rowNumber, 1, 3);
	const labelC = row.getCell(1);
	labelC.value = label;
	labelC.font = { bold: true };
	labelC.alignment = { horizontal: 'right' };
	const valueC = row.getCell(4);
	valueC.value = { formula };
	valueC.font = { bold: true };
	valueC.numFmt = numFmt;
	valueC.border = THIN_BORDER;
}

/**
 * Builds the filled report workbook for a billing period and returns it serialized
 * as a Buffer, suitable for streaming directly in an HTTP response.
 */
export async function generateReport(
	period: ReportPeriod,
	homeSessions: ReportSession[],
	publicSessions: ReportSession[],
	settings: ReportSettings | undefined
): Promise<Buffer> {
	const templateBytes = await readFile(TEMPLATE_PATH);
	const workbook = new ExcelJS.Workbook();
	// exceljs's Buffer type comes from its own bundled @types/node, which can diverge
	// structurally from the project's — safe to bridge since readFile always returns
	// a real Node Buffer.
	await workbook.xlsx.load(templateBytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
	const sheet = workbook.getWorksheet('Report');
	if (!sheet) throw new Error('Report template is missing the "Report" worksheet');

	// The template's home/public tables and summary rows are fixed at specific rows
	// (sized for its 3 sample home + 2 sample public rows), but a real period can have
	// a different number of sessions, which shifts every row below the header block up
	// or down. Wipe everything below the header block first so leftover template rows
	// (or a previous, differently-sized export) never bleed through into the real report.
	const CLEAR_FROM_ROW = 5;
	const clearThroughRow = Math.max(
		sheet.rowCount,
		CLEAR_FROM_ROW + homeSessions.length + publicSessions.length + 20
	);
	for (let r = CLEAR_FROM_ROW; r <= clearThroughRow; r++) {
		try {
			sheet.unMergeCells(r, 1, r, 5);
		} catch {
			// no-op: nothing was merged there
		}
		const row = sheet.getRow(r);
		for (let c = 1; c <= 5; c++) {
			const cell = row.getCell(c);
			cell.value = null;
			cell.style = {};
		}
	}

	// --- Header block ---
	sheet.getCell('B1').value = settings?.fullName ?? '[Not set — add your name in Settings]';
	sheet.getCell('B2').value = settings?.vehicleLabel ?? '[Not set — add your vehicle in Settings]';
	// Dates are stored as ISO date strings; the cells keep the template's date numFmt,
	// which Excel simply ignores for text values.
	sheet.getCell('B3').value = period.startDate;
	sheet.getCell('E3').value = period.endDate;

	const homeKwhTotal = sumKwh(homeSessions);
	const homeCostTotal = sumCost(homeSessions);
	const publicKwhTotal = sumKwh(publicSessions);
	const rate = homeKwhTotal > 0 ? homeCostTotal / homeKwhTotal : 0;

	// --- Home charging table ---
	let row = 7;
	titleRow(sheet, 6, `Home Charging — ${period.label}`);
	tableHeaderRow(sheet, row);
	row += 1;
	const homeDataStart = row;
	if (homeSessions.length === 0) {
		emptyRow(sheet, row, 'No home charging sessions in this period.');
		row += 1;
	} else {
		for (const s of homeSessions) {
			dataRow(sheet, row, s);
			row += 1;
		}
	}
	const homeDataEnd = row - 1;
	const homeTotalRow = row;
	totalRow(
		sheet,
		homeTotalRow,
		'Total kWh Used (Home):',
		homeSessions.length > 0 ? `SUM(D${homeDataStart}:D${homeDataEnd})` : '0'
	);
	row += 1;
	const costRow = row;
	sheet.getCell(`A${costRow}`).value = 'Cost (Total × Rate):';
	safeMerge(sheet, costRow, 1, 3);
	sheet.getCell(`A${costRow}`).font = { bold: true };
	sheet.getCell(`A${costRow}`).alignment = { horizontal: 'right' };
	const costCell = sheet.getCell(`D${costRow}`);
	costCell.value = homeCostTotal;
	costCell.numFmt = '$#,##0.00';
	costCell.font = { bold: true };
	costCell.border = THIN_BORDER;
	row += 2;

	// --- Public / commercial charging table ---
	titleRow(sheet, row, 'Public / Commercial Charging (already claimed through portal)');
	row += 1;
	tableHeaderRow(sheet, row);
	row += 1;
	const publicDataStart = row;
	if (publicSessions.length === 0) {
		emptyRow(sheet, row, 'No public charging sessions in this period.');
		row += 1;
	} else {
		for (const s of publicSessions) {
			dataRow(sheet, row, s);
			row += 1;
		}
	}
	const publicDataEnd = row - 1;
	const publicTotalRow = row;
	totalRow(
		sheet,
		publicTotalRow,
		'Total kWh Claimed (Public):',
		publicSessions.length > 0 ? `SUM(D${publicDataStart}:D${publicDataEnd})` : '0'
	);
	row += 2;

	// --- Rate + claiming kWh (header block, filled after totals are known) ---
	sheet.getCell('B4').value = homeKwhTotal;
	sheet.getCell('B4').numFmt = '#,##0.00';
	sheet.getCell('E4').value = rate;
	sheet.getCell('E4').numFmt = '$#,##0.000';

	// --- Summary: percentage of home charging ---
	const pctRow = row;
	safeMerge(sheet, pctRow, 1, 3);
	const pctLabel = sheet.getCell(`A${pctRow}`);
	pctLabel.value = 'Percentage of Home Charging:';
	pctLabel.font = { bold: true };
	pctLabel.alignment = { horizontal: 'right' };
	const pctValue = sheet.getCell(`D${pctRow}`);
	const denom = homeKwhTotal + publicKwhTotal;
	pctValue.value = denom > 0 ? homeKwhTotal / denom : 0;
	pctValue.numFmt = '0.0%';
	pctValue.font = { bold: true };
	pctValue.border = THIN_BORDER;

	const buffer = await workbook.xlsx.writeBuffer();
	return Buffer.from(buffer);
}
