// Composing the Pull-from-charger feedback shown on /sessions.
//
// The Evnex poll and the follow-up odometer read are two separate requests by
// design — Home Assistant must never delay or fail an Evnex import (§7.2 of
// foundational/BYD-INTEGRATION-PLAN.md) — so whether a freshly imported charge
// is actually *complete* (the car proved its odometer during the charge) is
// only known once both have answered. This is that composition: it matches the
// car-fill endpoint's filled rows against the poll action's inserted ids and
// words the outcome. Pure, so the exact sentences are unit-testable — this
// screen has produced counting bugs before ("skipped N" once grew every poll by
// counting sessions outside the lookback window).
//
// The import statuses it reports:
// - "auto-completed" — imported by this poll AND the car produced a proven
//   odometer for it in the same click: a whole, completed charge with nothing
//   typed (a fill is proven per car-odometer.ts's planOdometerFill; a mere
//   suggestion never counts — the user still has to confirm those).
// - "draft" — imported but still missing its odometer, for the user to add.
// - "updated" — an older draft whose kWh this poll filled in (its odometer, if
//   the car proved one now too, is reported by the filled-from-car line).
// - everything the car filled on drafts this poll didn't touch, plus its
//   suggestions and its "confirmed nothing" admission, stay their own lines.

import type { CarFillResult } from '$lib/car-reading';

/** The poll action's `pollSummary` — `src/routes/sessions/+page.server.ts` returns exactly this shape. */
export interface PollSummary {
	tombstoned: number;
	skipped: number;
	stillCharging: number;
	/**
	 * Sessions the charger has that belong to an already-submitted billing
	 * period, so they were not imported. Their own line, because the fix is
	 * actionable (unsubmit the period) rather than "nothing to do".
	 */
	periodSubmitted: number;
	invalidAfterImport: string[];
	/**
	 * charging_sessions.id of every row this poll inserted. Matched against the
	 * car-fill result to tell auto-completed charges from drafts — the counts
	 * alone can't do that.
	 */
	insertedIds: number[];
	/** How many existing drafts had their kWh filled in by this poll. */
	updated: number;
}

export interface PollFeedbackLine {
	tone: 'ok' | 'note' | 'warning';
	text: string;
}

export function composePollFeedback(
	summary: PollSummary,
	fill: CarFillResult | null
): PollFeedbackLine[] {
	const fillIds = fill?.ok ? new Set(fill.filledIds) : null;
	const autoCompleted = fillIds ? summary.insertedIds.filter((id) => fillIds.has(id)) : [];
	const drafts = fillIds
		? summary.insertedIds.filter((id) => !fillIds.has(id))
		: summary.insertedIds;
	// Fills on rows this poll didn't insert: drafts left open by earlier polls
	// (or a kWh update from this poll) that the car has now completed.
	const filledOlder = fillIds ? [...fillIds].filter((id) => !summary.insertedIds.includes(id)) : [];

	// "Imported 1 draft, updated 0, …" — zero counts are noise; every part is
	// shown only when it has something to say.
	const parts: string[] = [];
	if (summary.stillCharging > 0) {
		parts.push(
			`${summary.stillCharging} session${summary.stillCharging === 1 ? ' is' : 's are'} still charging — not eligible to import yet`
		);
	}
	if (autoCompleted.length > 0) {
		parts.push(
			`imported ${autoCompleted.length} auto-completed charge${autoCompleted.length === 1 ? '' : 's'}`
		);
	}
	if (drafts.length > 0) {
		parts.push(`imported ${drafts.length} draft${drafts.length === 1 ? '' : 's'}`);
	}
	if (summary.updated > 0) {
		parts.push(`updated ${summary.updated}`);
	}
	if (summary.skipped > 0) {
		parts.push(`skipped ${summary.skipped} already imported`);
	}

	const lines: PollFeedbackLine[] = [
		{ tone: 'ok', text: sentence(parts.length > 0 ? parts : ['nothing new to import']) }
	];
	if (summary.tombstoned > 0) {
		lines.push({
			tone: 'note',
			text: `${summary.tombstoned} invalid or zero-energy session${summary.tombstoned === 1 ? '' : 's'} dismissed.`
		});
	}
	if (summary.periodSubmitted > 0) {
		lines.push({
			tone: 'warning',
			text: `${summary.periodSubmitted} session${summary.periodSubmitted === 1 ? '' : 's'} not imported — the billing period is already submitted. Unsubmit it to import.`
		});
	}
	if (summary.invalidAfterImport.length > 0) {
		const n = summary.invalidAfterImport.length;
		lines.push({
			tone: 'warning',
			text: `${n} previously imported session${n === 1 ? '' : 's'} marked invalid or zero-energy by the charger — review: ${summary.invalidAfterImport.join(', ')}.`
		});
	}
	if (filledOlder.length > 0) {
		lines.push({
			tone: 'note',
			text: `${filledOlder.length} odometer${filledOlder.length === 1 ? '' : 's'} filled from car.`
		});
	}
	if (fill?.ok && fill.suggestions.length > 0) {
		const n = fill.suggestions.length;
		lines.push({
			tone: 'note',
			text: `${n} suggested from car — check ${n === 1 ? 'it' : 'them'} and tap Complete.`
		});
	}
	if (
		fill?.ok &&
		autoCompleted.length === 0 &&
		filledOlder.length === 0 &&
		fill.suggestions.length === 0 &&
		fill.skipped > 0
	) {
		lines.push({
			tone: 'note',
			text: "The car couldn't confirm any odometers — add them by hand."
		});
	}
	return lines;
}

/** Joins the parts into the app's summary sentence: capitalised, trailing period. */
function sentence(parts: string[]): string {
	const text = parts.join(', ');
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
