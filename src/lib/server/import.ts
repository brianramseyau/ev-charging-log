// Historical import parser: reads a legacy monthly "Record of Home Charging"
// spreadsheet (see PLAN.md §2 / §5.4) and extracts the header fields plus the
// home and public charging session tables.
//
// Section locations vary between files (blank rows differ month to month), so
// this scans every cell for the label/header text it's looking for rather than
// assuming fixed row numbers. Anything it can't confidently parse is collected
// into `issues` and skipped rather than thrown, so the review screen can show
// the user what needs a manual fix.

import ExcelJS from 'exceljs';

export type SessionKind = 'home' | 'public';

export interface ParsedSession {
	kind: SessionKind;
	/** 1-based row number in the source sheet, for surfacing issues to the user. */
	row: number;
	time: string | null;
	date: string | null;
	odometerKm: number | null;
	kwhUsed: number | null;
	location: string | null;
}

export interface ParsedHeader {
	fullName: string | null;
	vehicleLabel: string | null;
	startDate: string | null;
	endDate: string | null;
	claimingKwh: number | null;
	rateKwh: number | null;
}

export interface ImportIssue {
	section: 'header' | 'home' | 'public' | 'structure';
	message: string;
	row?: number;
}

export interface ParseResult {
	header: ParsedHeader;
	homeSessions: ParsedSession[];
	publicSessions: ParsedSession[];
	issues: ImportIssue[];
}

const HEADER_LABELS: { key: keyof ParsedHeader; pattern: RegExp }[] = [
	{ key: 'fullName', pattern: /^full name/i },
	{ key: 'vehicleLabel', pattern: /^vin or vehicle registration/i },
	{ key: 'startDate', pattern: /^starting date/i },
	{ key: 'endDate', pattern: /^closing date/i },
	{ key: 'claimingKwh', pattern: /^claiming\s*kw\/?h/i },
	{ key: 'rateKwh', pattern: /^rate\s*kw\/?h/i }
];

const TABLE_HEADER_COLUMNS = ['time', 'date', 'odometer', 'kwh used', 'location'];

const PUBLIC_TABLE_LABEL = /commercial charging.*already claimed/i;

/**
 * Formula cells come back from ExcelJS as `{ formula, result }` rather than a
 * bare value, even when the cached result is itself a Date or number (e.g. a
 * session date/time filled by dragging a formula down from the row above).
 * Unwrap to the cached result so the rest of the parsing logic doesn't need
 * to special-case formula cells.
 */
function unwrapFormula(value: ExcelJS.CellValue): ExcelJS.CellValue {
	if (
		value !== null &&
		typeof value === 'object' &&
		!(value instanceof Date) &&
		!('richText' in value) &&
		'result' in value
	) {
		return (value as { result: ExcelJS.CellValue }).result;
	}
	return value;
}

function cellText(value: ExcelJS.CellValue): string {
	value = unwrapFormula(value);
	if (value === null || value === undefined) return '';
	if (value instanceof Date) {
		return value.toISOString().slice(0, 10);
	}
	if (typeof value === 'object') {
		// Rich text objects
		if ('text' in value && typeof (value as { text?: unknown }).text === 'string') {
			return (value as { text: string }).text;
		}
		if ('richText' in value) {
			const rich = (value as { richText: { text: string }[] }).richText;
			return rich.map((r) => r.text).join('');
		}
		return '';
	}
	return String(value).trim();
}

function toDateString(value: ExcelJS.CellValue): string | null {
	value = unwrapFormula(value);
	if (value === null || value === undefined || value === '') return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	const text = cellText(value);
	if (!text) return null;
	const parsed = new Date(text);
	if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
	// Unparseable text (not a recognizable date and not already YYYY-MM-DD)
	// must not pass through as-is — `<input type="date">` silently blanks it
	// with no visible error, so treat it as missing instead so it's flagged.
	return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

const TIME_12H_PATTERN = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])$/;
const TIME_24H_PATTERN = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

/**
 * Some legacy files enter times as 12-hour text ("8:30 AM") rather than an
 * Excel time value, which `<input type="time">` can't accept (it requires
 * 24-hour HH:MM) — convert here so it round-trips instead of silently
 * failing validation on the review page.
 */
function normalizeTimeText(text: string): string | null {
	const ampm = TIME_12H_PATTERN.exec(text);
	if (ampm) {
		let hh = Number(ampm[1]);
		const mm = ampm[2];
		const isPm = ampm[3].toLowerCase() === 'pm';
		if (hh === 12) hh = 0;
		if (isPm) hh += 12;
		return `${String(hh).padStart(2, '0')}:${mm}`;
	}
	const plain = TIME_24H_PATTERN.exec(text);
	if (plain) {
		const hh = Number(plain[1]);
		const mm = plain[2];
		if (hh > 23) return null;
		return `${String(hh).padStart(2, '0')}:${mm}`;
	}
	return null;
}

function toTimeString(value: ExcelJS.CellValue): string | null {
	value = unwrapFormula(value);
	if (value === null || value === undefined || value === '') return null;
	if (value instanceof Date) {
		const hh = String(value.getUTCHours()).padStart(2, '0');
		const mm = String(value.getUTCMinutes()).padStart(2, '0');
		return `${hh}:${mm}`;
	}
	const text = cellText(value);
	if (!text) return null;
	return normalizeTimeText(text.trim());
}

function toNumber(value: ExcelJS.CellValue): number | null {
	value = unwrapFormula(value);
	if (value === null || value === undefined || value === '') return null;
	if (typeof value === 'number') return value;
	const text = cellText(value).replace(/[^0-9.-]/g, '');
	if (!text) return null;
	const n = Number(text);
	return Number.isNaN(n) ? null : n;
}

/** Finds the row/col of the first cell whose text matches `pattern`, scanning the whole sheet. */
function findLabelCell(
	sheet: ExcelJS.Worksheet,
	pattern: RegExp
): { row: number; col: number } | null {
	let found: { row: number; col: number } | null = null;
	sheet.eachRow((row, rowNumber) => {
		if (found) return;
		row.eachCell((cell, colNumber) => {
			if (found) return;
			const text = cellText(cell.value);
			if (pattern.test(text)) {
				found = { row: rowNumber, col: colNumber };
			}
		});
	});
	return found;
}

/**
 * Finds a session table's header row: a row containing all of
 * TABLE_HEADER_COLUMNS (in any column order), searching from `fromRow` onward.
 */
function findTableHeaderRow(
	sheet: ExcelJS.Worksheet,
	fromRow: number,
	toRow?: number
): { row: number; columns: Record<string, number> } | null {
	const maxRow = toRow !== undefined ? Math.min(toRow, sheet.rowCount) : sheet.rowCount;
	for (let r = fromRow; r <= maxRow; r++) {
		const row = sheet.getRow(r);
		const columns: Record<string, number> = {};
		row.eachCell((cell, colNumber) => {
			const text = cellText(cell.value).toLowerCase();
			for (const col of TABLE_HEADER_COLUMNS) {
				if (text === col || text.startsWith(col)) {
					columns[col] = colNumber;
				}
			}
		});
		if (TABLE_HEADER_COLUMNS.every((col) => columns[col] !== undefined)) {
			return { row: r, columns };
		}
	}
	return null;
}

/**
 * Flags any session whose parsed date falls outside the sheet's own claimed
 * `[startDate, endDate]` period range. Legacy files are occasionally copied
 * forward from an older month's template with a stale cell left behind (e.g.
 * a formula-filled date that never got dragged down/updated) — those rows
 * still have every field populated, so they'd otherwise sail through review
 * unflagged and get silently stamped with the wrong billing period at commit
 * time (unlike a manually-logged or Evnex-imported session, whose period is
 * derived from its own date — see `findBillingPeriodId` in sessions.ts).
 * Doesn't exclude the row: the date is still editable on the review screen,
 * and an out-of-range date isn't necessarily wrong (e.g. a charge just
 * before/after the claimed boundary), just worth a human look.
 */
function flagOutOfRangeDates(
	sessions: ParsedSession[],
	startDate: string | null,
	endDate: string | null,
	issues: ImportIssue[]
): void {
	if (!startDate || !endDate) return;
	for (const session of sessions) {
		if (session.date && (session.date < startDate || session.date > endDate)) {
			issues.push({
				section: session.kind,
				row: session.row,
				message: `Row ${session.row} (${session.kind}): date ${session.date} is outside the claimed period ${startDate} – ${endDate} — please review.`
			});
		}
	}
}

/** Reads data rows below a table header until it hits a blank row run or the next label. */
function readSessionTable(
	sheet: ExcelJS.Worksheet,
	headerRow: number,
	columns: Record<string, number>,
	kind: SessionKind,
	issues: ImportIssue[]
): ParsedSession[] {
	const sessions: ParsedSession[] = [];
	const maxRow = sheet.rowCount;
	let blankStreak = 0;

	for (let r = headerRow + 1; r <= maxRow; r++) {
		const row = sheet.getRow(r);
		const timeVal = row.getCell(columns['time']).value;
		const dateVal = row.getCell(columns['date']).value;
		const odoVal = row.getCell(columns['odometer']).value;
		const kwhVal = row.getCell(columns['kwh used']).value;
		const locVal = row.getCell(columns['location']).value;

		const allBlank = [timeVal, dateVal, odoVal, kwhVal, locVal].every(
			(v) => v === null || v === undefined || v === ''
		);

		if (allBlank) {
			blankStreak++;
			// Two consecutive fully-blank rows: assume the table has ended.
			if (blankStreak >= 2) break;
			continue;
		}

		// A row of text that looks like the next section's label ends the table too.
		// Summary rows (e.g. "Total Kwh Used") don't consistently land in the
		// "time" column — check every mapped column, not just that one.
		const rowTexts = [timeVal, dateVal, odoVal, kwhVal, locVal].map((v) =>
			cellText(v).toLowerCase()
		);
		if (
			rowTexts.some(
				(text) =>
					text.startsWith('total') || text.startsWith('commercial') || text.startsWith('percentage')
			)
		) {
			break;
		}

		blankStreak = 0;

		const date = toDateString(dateVal);
		const time = toTimeString(timeVal);
		const odometerKm = toNumber(odoVal);
		const kwhUsed = toNumber(kwhVal);
		const location = cellText(locVal) || null;

		const missing: string[] = [];
		if (!date) missing.push('date');
		if (!time) missing.push('time');
		if (odometerKm === null) missing.push('odometer');
		if (kwhUsed === null) missing.push('kWh used');
		if (!location) missing.push('location');

		if (missing.length > 0) {
			issues.push({
				section: kind,
				row: r,
				message: `Row ${r} (${kind}): missing ${missing.join(', ')} — please review.`
			});
		}

		sessions.push({ kind, row: r, time, date, odometerKm, kwhUsed, location });
	}

	return sessions;
}

export async function parseImportWorkbook(buffer: Buffer | ArrayBuffer): Promise<ParseResult> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer as ExcelJS.Buffer);

	const sheet = workbook.worksheets[0];
	const issues: ImportIssue[] = [];

	if (!sheet) {
		issues.push({ section: 'structure', message: 'Workbook has no worksheets.' });
		return {
			header: {
				fullName: null,
				vehicleLabel: null,
				startDate: null,
				endDate: null,
				claimingKwh: null,
				rateKwh: null
			},
			homeSessions: [],
			publicSessions: [],
			issues
		};
	}

	// --- Header fields: scan for each label, read the adjacent cell(s) to the right ---
	const header: ParsedHeader = {
		fullName: null,
		vehicleLabel: null,
		startDate: null,
		endDate: null,
		claimingKwh: null,
		rateKwh: null
	};

	for (const { key, pattern } of HEADER_LABELS) {
		const cell = findLabelCell(sheet, pattern);
		if (!cell) {
			issues.push({ section: 'header', message: `Could not find "${key}" label in the sheet.` });
			continue;
		}
		// Value is usually in the next non-empty cell to the right on the same row.
		const row = sheet.getRow(cell.row);
		let value: ExcelJS.CellValue = null;
		for (let c = cell.col + 1; c <= row.cellCount + 1; c++) {
			const v = row.getCell(c).value;
			if (v !== null && v !== undefined && v !== '') {
				value = v;
				break;
			}
		}

		if (value === null || value === undefined || value === '') {
			issues.push({
				section: 'header',
				row: cell.row,
				message: `"${key}" label found at row ${cell.row} but no value in adjacent cells.`
			});
			continue;
		}

		if (key === 'startDate' || key === 'endDate') {
			header[key] = toDateString(value);
		} else if (key === 'claimingKwh' || key === 'rateKwh') {
			header[key] = toNumber(value);
		} else {
			header[key] = cellText(value) || null;
		}
	}

	// --- Home charging table: first table-header row matching the 5 columns ---
	const homeHeader = findTableHeaderRow(sheet, 1);
	let homeSessions: ParsedSession[] = [];
	let publicSessions: ParsedSession[] = [];

	if (!homeHeader) {
		issues.push({
			section: 'home',
			message: 'Could not locate the home charging table header row.'
		});
	} else {
		homeSessions = readSessionTable(sheet, homeHeader.row, homeHeader.columns, 'home', issues);

		// --- Public/commercial table: look for its label after the home table, then
		// find the next table-header row after that label. ---
		const publicLabelCell = findLabelCell(sheet, PUBLIC_TABLE_LABEL);
		if (!publicLabelCell) {
			issues.push({
				section: 'public',
				message: 'Could not locate the commercial/public charging section label.'
			});
		} else {
			// Some files never repeat the column header row for this table — data
			// rows start right after the label, reusing the home table's column
			// layout. Only look for an explicit header on the row immediately
			// after the label (allowing one blank spacer row), so we don't
			// accidentally pick up an unrelated header-shaped row further down.
			const publicHeader = findTableHeaderRow(
				sheet,
				publicLabelCell.row + 1,
				publicLabelCell.row + 2
			);
			publicSessions = readSessionTable(
				sheet,
				publicHeader ? publicHeader.row : publicLabelCell.row,
				publicHeader ? publicHeader.columns : homeHeader.columns,
				'public',
				issues
			);
		}
	}

	flagOutOfRangeDates(homeSessions, header.startDate, header.endDate, issues);
	flagOutOfRangeDates(publicSessions, header.startDate, header.endDate, issues);

	return { header, homeSessions, publicSessions, issues };
}
