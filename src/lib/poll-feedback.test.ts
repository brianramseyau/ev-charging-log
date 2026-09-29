import { describe, expect, it } from 'vitest';
import { composePollFeedback, type PollSummary } from './poll-feedback';
import type { CarFillResult } from '$lib/car-reading';

const baseSummary: PollSummary = {
	tombstoned: 0,
	skipped: 0,
	stillCharging: 0,
	periodSubmitted: 0,
	invalidAfterImport: [],
	insertedIds: [],
	updated: 0
};

/** A successful car fill; ids default to none. */
const fillResult = (
	overrides: Partial<Extract<CarFillResult, { ok: true }>> = {}
): CarFillResult => ({
	ok: true,
	filled: 0,
	filledIds: [],
	suggestions: [],
	skipped: 0,
	...overrides
});

describe('composePollFeedback', () => {
	it('a fill matched to a just-inserted row reports an auto-completed charge, not a draft', () => {
		const lines = composePollFeedback(
			{ ...baseSummary, insertedIds: [7] },
			fillResult({ filled: 1, filledIds: [7] })
		);
		expect(lines).toEqual([{ tone: 'ok', text: 'Imported 1 auto-completed charge.' }]);
	});

	it('plural auto-completed charges', () => {
		const lines = composePollFeedback(
			{ ...baseSummary, insertedIds: [7, 8, 9] },
			fillResult({ filled: 3, filledIds: [7, 8, 9] })
		);
		expect(lines[0].text).toBe('Imported 3 auto-completed charges.');
	});

	it('a match against only fills older drafts leaves the insert as a draft', () => {
		const lines = composePollFeedback(
			{ ...baseSummary, insertedIds: [7] },
			fillResult({ filled: 1, filledIds: [4] })
		);
		expect(lines[0].text).toBe('Imported 1 draft.');
		expect(lines).toContainEqual({ tone: 'note', text: '1 odometer filled from car.' });
	});

	it('without a fill result yet, an insert is still just a draft', () => {
		const lines = composePollFeedback({ ...baseSummary, insertedIds: [7] }, null);
		expect(lines[0].text).toBe('Imported 1 draft.');
	});

	it('a suggestion never upgrades to auto-completed — the user still confirms it', () => {
		const lines = composePollFeedback(
			{ ...baseSummary, insertedIds: [7] },
			fillResult({
				filled: 0,
				filledIds: [],
				suggestions: [{ id: 7, km: 12345, carReportedAt: '2026-09-29T08:00:00.000Z' }]
			})
		);
		expect(lines[0].text).toBe('Imported 1 draft.');
		expect(lines).toContainEqual({
			tone: 'note',
			text: '1 suggested from car — check it and tap Complete.'
		});
	});

	it('kWh updates, skips and still-charging are counted once, in their own words', () => {
		const lines = composePollFeedback(
			{ ...baseSummary, updated: 2, skipped: 3, stillCharging: 1 },
			fillResult()
		);
		expect(lines[0].text).toBe(
			'1 session is still charging — not eligible to import yet, updated 2, skipped 3 already imported.'
		);
	});

	it('a mix of auto-completed and drafts says both', () => {
		const lines = composePollFeedback(
			{ ...baseSummary, insertedIds: [7, 8] },
			fillResult({ filled: 1, filledIds: [7] })
		);
		expect(lines[0].text).toBe('Imported 1 auto-completed charge, imported 1 draft.');
	});

	it('dismissed and invalid-after-import keep their own lines with the right tones', () => {
		const lines = composePollFeedback(
			{
				...baseSummary,
				tombstoned: 1,
				invalidAfterImport: ['2026-09-20 18:18']
			},
			fillResult()
		);
		expect(lines[0].text).toBe('Nothing new to import.');
		expect(lines).toContainEqual({
			tone: 'note',
			text: '1 invalid or zero-energy session dismissed.'
		});
		expect(lines).toContainEqual({
			tone: 'warning',
			text: '1 previously imported session marked invalid or zero-energy by the charger — review: 2026-09-20 18:18.'
		});
	});

	it('reports a submitted-period session on its own actionable line, not as a skip', () => {
		const lines = composePollFeedback({ ...baseSummary, periodSubmitted: 2 }, fillResult());
		expect(lines[0].text).toBe('Nothing new to import.');
		expect(lines).toContainEqual({
			tone: 'warning',
			text: '2 sessions not imported — the billing period is already submitted. Unsubmit it to import.'
		});
	});

	it('when the car confirms nothing and nothing was inserted, it says so plainly', () => {
		const lines = composePollFeedback(baseSummary, fillResult({ skipped: 2 }));
		expect(lines[0].text).toBe('Nothing new to import.');
		expect(lines).toContainEqual({
			tone: 'note',
			text: "The car couldn't confirm any odometers — add them by hand."
		});
	});

	it('a failed car read still shows the import, without odometer lines', () => {
		const lines = composePollFeedback(
			{ ...baseSummary, insertedIds: [7, 8] },
			{ ok: false, status: 'unreachable', message: 'Home Assistant unreachable.' }
		);
		expect(lines[0].text).toBe('Imported 2 drafts.');
		expect(lines).toHaveLength(1);
	});
});
