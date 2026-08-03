// Generates a SANITIZED xlsx export template with placeholder data, matching the
// layout of the original "Record of Home Charging" spreadsheet described in
// PLAN.md §2. This script never reads the real (gitignored) spreadsheet — it
// builds the shape from scratch with fake values, purely so the report export
// feature (src/lib/server/report.ts) has a real template to load/fill via
// exceljs, and so the checked-in .xlsx contains no personal data.
//
// Run via `node scripts/generate-template.mjs` (one-off; not part of the app runtime).
import ExcelJS from 'exceljs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outPath = join(root, 'static/templates/home-charging-template.xlsx');

const TEAL = 'FF0F766E';
const TEAL_LIGHT = 'FFE0F2F1';
const WHITE = 'FFFFFFFF';
const BORDER_THIN = { style: 'thin', color: { argb: 'FFCBD5E1' } };
const THIN_BORDER = {
	top: BORDER_THIN,
	left: BORDER_THIN,
	bottom: BORDER_THIN,
	right: BORDER_THIN
};

const workbook = new ExcelJS.Workbook();
workbook.creator = 'EV Charging Log';
workbook.created = new Date();

const sheet = workbook.addWorksheet('Report', {
	views: [{ state: 'normal' }]
});

sheet.columns = [
	{ key: 'A', width: 22 },
	{ key: 'B', width: 16 },
	{ key: 'C', width: 14 },
	{ key: 'D', width: 16 },
	{ key: 'E', width: 26 }
];

function labelCell(cell, value) {
	cell.value = value;
	cell.font = { bold: true, color: { argb: 'FF334155' } };
}

function valueCell(cell, value, numFmt) {
	cell.value = value;
	if (numFmt) cell.numFmt = numFmt;
}

function titleRow(rowNumber, text) {
	const row = sheet.getRow(rowNumber);
	sheet.mergeCells(rowNumber, 1, rowNumber, 5);
	const cell = row.getCell(1);
	cell.value = text;
	cell.font = { bold: true, color: { argb: WHITE }, size: 12 };
	cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
	cell.alignment = { vertical: 'middle' };
	row.height = 22;
}

function tableHeaderRow(rowNumber) {
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

function dataRow(rowNumber, time, date, odometer, kwh, location) {
	const row = sheet.getRow(rowNumber);
	const values = [time, date, odometer, kwh, location];
	values.forEach((v, i) => {
		const cell = row.getCell(i + 1);
		cell.value = v;
		cell.border = THIN_BORDER;
		if (i === 1) cell.numFmt = 'yyyy-mm-dd';
		if (i === 2) cell.numFmt = '#,##0.0';
		if (i === 3) cell.numFmt = '0.00';
	});
}

function totalRow(rowNumber, label, formula, numFmt) {
	const row = sheet.getRow(rowNumber);
	sheet.mergeCells(rowNumber, 1, rowNumber, 3);
	const labelC = row.getCell(1);
	labelC.value = label;
	labelC.font = { bold: true };
	labelC.alignment = { horizontal: 'right' };
	const valueC = row.getCell(4);
	valueC.value = { formula };
	valueC.font = { bold: true };
	valueC.numFmt = numFmt ?? '#,##0.00';
	valueC.border = THIN_BORDER;
}

// --- Header block (rows 1-4) ---
labelCell(sheet.getCell('A1'), 'Full Name:');
valueCell(sheet.getCell('B1'), '[Your Name]');

labelCell(sheet.getCell('A2'), 'Vehicle (Rego/VIN):');
valueCell(sheet.getCell('B2'), '[Rego/VIN]');

labelCell(sheet.getCell('A3'), 'Starting Date:');
valueCell(sheet.getCell('B3'), new Date('2026-07-01'), 'yyyy-mm-dd');
labelCell(sheet.getCell('D3'), 'Closing Date:');
valueCell(sheet.getCell('E3'), new Date('2026-07-31'), 'yyyy-mm-dd');

labelCell(sheet.getCell('A4'), 'Claiming kW/h:');
sheet.getCell('B4').value = { formula: 'D11' };
sheet.getCell('B4').numFmt = '#,##0.00';
labelCell(sheet.getCell('D4'), 'Rate kW/h:');
valueCell(sheet.getCell('E4'), 0.3, '$#,##0.00000');

// --- Home charging table ---
titleRow(6, 'Home Charging');
tableHeaderRow(7);
dataRow(8, '07:30', new Date('2026-07-02'), 15234.5, 8.2, 'Home garage');
dataRow(9, '19:15', new Date('2026-07-08'), 15310.1, 7.9, 'Home garage');
dataRow(10, '06:45', new Date('2026-07-19'), 15489.6, 9.1, 'Home garage');
totalRow(11, 'Total kWh Used (Home):', 'SUM(D8:D10)');
totalRow(12, 'Cost (Total × Rate):', 'D11*E4', '$#,##0.00');

// --- Public / commercial charging table ---
titleRow(14, 'Public / Commercial Charging (already claimed through portal)');
tableHeaderRow(15);
dataRow(16, '12:10', new Date('2026-07-05'), 15267.3, 12.4, 'Public fast charger');
dataRow(17, '17:40', new Date('2026-07-21'), 15422.0, 10.8, 'Shopping centre charger');
totalRow(18, 'Total kWh Claimed (Public):', 'SUM(D16:D17)');

// --- Summary ---
const pctRow = sheet.getRow(20);
sheet.mergeCells(20, 1, 20, 3);
const pctLabel = pctRow.getCell(1);
pctLabel.value = 'Percentage of Home Charging:';
pctLabel.font = { bold: true };
pctLabel.alignment = { horizontal: 'right' };
const pctValue = pctRow.getCell(4);
pctValue.value = { formula: 'D11/(D11+D18)' };
pctValue.numFmt = '0.0%';
pctValue.font = { bold: true };
pctValue.border = THIN_BORDER;

sheet.getRow(1).height = 18;
sheet.getRow(2).height = 18;

await mkdir(dirname(outPath), { recursive: true });
await workbook.xlsx.writeFile(outPath);
console.log(`wrote ${outPath}`);
