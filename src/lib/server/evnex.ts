// Pure logic for the Evnex integration: import-window arithmetic, UTC → local
// date/time conversion, payload → draft-session mapping, and the poll-planning
// decision table. Kept dependency-free (no fetch, no db import) so it's cheap
// to unit test — `evnex-client.ts` talks to the network, `+page.server.ts`
// wires this to Drizzle. See foundational/EVNEX-INTEGRATION-PLAN.md §6.

/**
 * The [from, to] instants for a poll. `from` is `now - lookbackDays`, computed
 * as an instant (fixed milliseconds) rather than a local midnight — "the last
 * N days" is both simpler to reason about and immune to DST edges, since it
 * never looks at a calendar/timezone at all.
 */
export function importWindow(now: Date, lookbackDays: number): { from: string; to: string } {
	const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
	return { from: from.toISOString(), to: now.toISOString() };
}

export type EvnexSessionStatus =
	'Pending' | 'Authorized' | 'Active' | 'Closed' | 'Completed' | 'Invalid';

/**
 * The flat shape `evnex-client.ts` normalises the wire response into, before
 * this file ever sees it — no `{ id, attributes: { transaction: … } }`
 * nesting, and no watt-hours arithmetic (that's `evnex-client.ts`'s job:
 * `energyKwh = (transaction.meterStop - transaction.meterStart) / 1000`,
 * plan §4.6/§4.7 — this file must not reimplement it).
 *
 * `startDate` and `sessionStatus` are optional/nullable here, unlike the
 * plan's own §6.4 pseudocode which types them as always-present. The
 * consumer Cloud API's session schema (unlike the Enterprise one) genuinely
 * doesn't guarantee either field (plan §4.6), and modelling them as required
 * would make "session with no startDate" and "session with no
 * sessionStatus" — both explicit test cases in the plan — untypeable without
 * an `as any`. `energyKwh` was already nullable in the plan's own shape
 * (absent `meterStop` = still charging), so it's unchanged.
 */
export interface EvnexSessionPayload {
	id: string;
	/**
	 * ISO UTC timestamp of the session start (`attributes.startDate`).
	 * Missing (undefined or null) means the session cannot be placed on a
	 * date at all — see `planImport` rule 0.
	 */
	startDate?: string | null;
	/**
	 * ISO UTC timestamp of the session end (`attributes.endDate`). Absent while
	 * the session is still charging. Only carried through to the draft's
	 * `endedAt` for the car-odometer match (BYD-INTEGRATION-PLAN.md §5) —
	 * `energyKwh` is already null whenever this is, so no import rule reads it.
	 */
	endDate?: string | null;
	/**
	 * `attributes.sessionStatus`. Missing must be treated as "not Invalid" —
	 * `planImport` rule 1 tests `=== 'Invalid'`, never `!== 'Completed'`, so
	 * a status-less session is never wrongly tombstoned.
	 */
	sessionStatus?: EvnexSessionStatus | null;
	/**
	 * Already converted to kWh by `evnex-client.ts`. Null while the session
	 * is still charging — either `transaction.meterStop` is absent, or the
	 * session's `endDate` is still absent (a live session reports a growing
	 * `meterStop`, which is a partial figure, not a final one). `0` is a real,
	 * present reading — never treat it as falsy/absent (plan §6.5).
	 */
	energyKwh: number | null;
}

export interface DraftFromEvnex {
	externalId: string;
	kind: 'home';
	date: string; // local, "YYYY-MM-DD", from startDate
	time: string; // local, "HH:mm", from startDate
	startedAt: string; // ISO UTC instant, from startDate
	endedAt: string | null; // ISO UTC instant, from endDate
	odometerKm: null;
	kwhUsed: number | null; // null while charging is still in progress
	location: string;
	notes: null;
}

/**
 * Converts a UTC ISO timestamp into the app's local `date`/`time` storage
 * strings for a given IANA timezone.
 *
 * Built from `Intl.DateTimeFormat(...).formatToParts()`, never `.format()`
 * or `.toISOString().slice(0, 10)` — both are explicitly wrong (plan §6.3):
 * `en-AU`'s `.format()` is day-first (`07/08/2026`), and `.toISOString()`
 * reads the UTC day, which silently shifts an evening local session onto the
 * wrong calendar day (and therefore the wrong billing period / peak-offpeak
 * rate) whenever the timezone offset crosses a UTC day boundary.
 *
 * `hourCycle: 'h23'` is required: `en-AU` defaults to 12-hour, so without it
 * a 00:30 local session comes back as `hour: "12"` (plus a separate
 * `dayPeriod: "am"` part that this function doesn't read), which would store
 * as `12:30` — a midnight charge relocated to midday.
 */
function toLocalDateTime(isoUtc: string, timeZone: string): { date: string; time: string } {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-AU', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23'
		})
			.formatToParts(new Date(isoUtc))
			.map((p) => [p.type, p.value])
	) as Record<string, string>;

	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		time: `${parts.hour}:${parts.minute}`
	};
}

/**
 * Maps one Evnex session payload to a draft `charging_sessions` row.
 *
 * `payload.startDate` must be present — callers (`planImport`) are
 * responsible for routing startDate-less sessions to the `unmappable` skip
 * reason before ever reaching this function; it throws rather than silently
 * inventing a date (plan §4.6 explicitly calls out `new Date()` as wrong).
 *
 * `location` and `kind` are supplied/fixed by the caller, not derived here:
 * every Evnex session is `kind: 'home'` (the integration is for the user's
 * own charger), and resolving `settings.homeAddress` vs. the charge point's
 * name is the route's job, not this pure function's (plan §6.4).
 */
export function toDraftSession(
	payload: EvnexSessionPayload,
	opts: { timeZone: string; location: string }
): DraftFromEvnex {
	if (payload.startDate == null) {
		throw new Error(
			`toDraftSession: session ${payload.id} has no startDate — callers must filter these ` +
				`out (skip reason "unmappable") via planImport before calling toDraftSession`
		);
	}

	const { date, time } = toLocalDateTime(payload.startDate, opts.timeZone);

	return {
		externalId: payload.id,
		kind: 'home',
		date,
		time,
		startedAt: payload.startDate,
		endedAt: payload.endDate ?? null,
		odometerKm: null,
		kwhUsed: payload.energyKwh,
		location: opts.location,
		notes: null
	};
}

export type SkipReason =
	| 'invalid'
	| 'invalid_after_import'
	| 'zero_energy'
	| 'zero_energy_after_import'
	| 'unmappable'
	| 'outside_window'
	| 'dismissed'
	| 'already_complete'
	| 'still_charging'
	| 'period_submitted';

export interface ExistingSessionForImport {
	id: number;
	externalId: string | null;
	kwhUsed: number | null;
	billingPeriodId: number | null;
	odometerKm: number | null;
	startedAt: string | null;
	endedAt: string | null;
}

export interface PlanImportResult {
	insert: DraftFromEvnex[];
	update: { id: number; kwhUsed: number }[];
	backfill: { id: number; startedAt: string; endedAt: string | null }[];
	tombstone: string[];
	skipped: { externalId: string; reason: SkipReason }[];
}

/**
 * The counts behind the /sessions poll summary (§7.2), computed from
 * `planImport`'s output so the UI never has to re-derive them — a
 * `planResult.skipped` entry is not the same thing as "a session the user
 * could have imported", and conflating the two has produced counting bugs
 * here before.
 *
 * `skipped` is deliberately NOT `planResult.skipped.length`. It counts only
 * sessions that were genuinely already imported (`already_complete`,
 * `unmappable`) — see the per-reason reasoning on `summarizePoll`.
 */
export interface PollSkipCounts {
	/** The count behind "skipped N already imported" — in-window, not otherwise reported. */
	skipped: number;
	/** Sessions still on the charger (never imported) — reported on their own line. */
	stillCharging: number;
	/**
	 * externalIds that should count as *newly* dismissed, but only if their
	 * tombstone insert actually added a row. `summarizePoll` can't know that
	 * (an already-tombstoned session re-plans on every poll), and `planImport`
	 * tombstones both genuinely-new and already-dismissed sessions — so the
	 * route counts the ids whose `onConflictDoNothing` insert changed a row.
	 */
	tombstoneCandidates: string[];
	/** Sessions whose billing period is already submitted — reported on their own line. */
	periodSubmitted: number;
	/** Previously imported rows the charger has since invalidated — date/time labels. */
	invalidAfterImport: string[];
}

/**
 * Splits `planImport`'s skips into the distinct counts the poll summary shows,
 * rather than lumping every skip into one "already imported" number.
 *
 * A skipped session is excluded from `skipped` (and therefore from the "N
 * already imported" wording) when it is already reported on its own line, or
 * when calling it "already imported" would simply be false:
 *
 * - `invalid` / `zero_energy` — tombstoned by `planImport` and reported via
 *   `tombstoneCandidates`, which gets its own "N invalid or zero-energy
 *   sessions dismissed" line. Counting them again here both double-counted a
 *   single session and mislabelled it as imported. These are also tombstoned
 *   by rules 1–2 *before* the window check, so an out-of-window blip would
 *   otherwise inflate the number even though it never appears in the log.
 * - `invalid_after_import` / `zero_energy_after_import` — reported (with the
 *   row's date/time) on the warning line; the row still exists, so "skipped"
 *   is not the right word for it.
 * - `dismissed` — previously tombstoned (invalid, zero energy, or deleted by
 *   the user). "Already imported" would be a lie: it may never have been
 *   imported at all, and the delete path tombstones the row on the way out.
 * - `outside_window` / `still_charging` — never imported, so not "already
 *   imported". `still_charging` is aggregated separately; the pile of
 *   out-of-window skips only grows every poll since the endpoint takes no
 *   date range (§4.4), and is pure noise.
 * - `period_submitted` — the session *is* imported, but the count is surfaced
 *   separately (via `periodSubmitted`) with an actionable "unsubmit it"
 *   message, rather than as an "already imported, nothing to do" skip.
 *
 * `unmappable` is the one judgement call: a session with no `startDate` may
 * have been imported on an earlier poll, so within the "already imported"
 * bucket it is the closest fit (the old count included it too).
 *
 * `tombstoneCandidates` excludes rows the charger invalidated *after* they
 * were imported — those are on the more important `invalidAfterImport`
 * warning line instead, so each session appears in exactly one line. Which of
 * these actually get counted as freshly dismissed is decided by the route from
 * the tombstone insert's affected-row count, not from a pre-transaction
 * snapshot (a concurrent poll can win the insert, in which case this poll's
 * `onConflictDoNothing` changes nothing and must not report a dismissal).
 */
export function summarizePoll(
	plan: PlanImportResult,
	existing: { externalId: string | null; date: string; time: string }[]
): PollSkipCounts {
	const count = (reason: SkipReason) => plan.skipped.filter((s) => s.reason === reason).length;

	const afterImport = plan.skipped.filter(
		(s) => s.reason === 'invalid_after_import' || s.reason === 'zero_energy_after_import'
	);
	const afterImportIds = new Set(afterImport.map((s) => s.externalId));
	const invalidAfterImport = afterImport.map((s) => {
		const row = existing.find((r) => r.externalId === s.externalId);
		return row ? `${row.date} ${row.time}` : s.externalId;
	});

	const ownLineReasons: SkipReason[] = [
		'invalid',
		'zero_energy',
		'invalid_after_import',
		'zero_energy_after_import',
		'dismissed',
		'outside_window',
		'still_charging',
		'period_submitted'
	];
	const skipped = plan.skipped.filter((s) => !ownLineReasons.includes(s.reason)).length;

	return {
		skipped,
		stillCharging: count('still_charging'),
		tombstoneCandidates: plan.tombstone.filter((id) => !afterImportIds.has(id)),
		periodSubmitted: count('period_submitted'),
		invalidAfterImport
	};
}

/**
 * Decides what a poll should do with each remote session: insert a new
 * draft, update an existing draft's kWh, tombstone it (never import again),
 * or skip it (with a reason). Fully pure and total, so the whole decision
 * table is unit-testable without a database — see plan §6.5 for the rules,
 * applied here in the exact order given (0 through 8):
 *
 * 0. No `startDate` -> `unmappable`. A data gap, possibly transient — NOT
 *    tombstoned, unlike an Invalid session.
 * 1. `sessionStatus === 'Invalid'` -> tombstone always. `invalid` if there's
 *    no existing row, `invalid_after_import` if there is one (in which case
 *    the existing row is left untouched — never deleted/modified here).
 * 2. `energyKwh === 0` -> tombstone always, the same treatment as rule 1. A
 *    zero-energy session (`meterStop === meterStart`) is a charger blip —
 *    plugged in and immediately stopped, never actually delivered power —
 *    not a billable charge worth a draft row. `zero_energy`/
 *    `zero_energy_after_import` mirror rule 1's two reasons; the existing
 *    row (if any) is left untouched, same as rule 1. This intentionally
 *    fires before rule 6 even considers the existing row, so a zero reading
 *    can never fill in an existing draft's kWh either.
 * 3. Before the lookback window -> `outside_window`. This is the *only*
 *    client-side enforcement of `importLookbackDays`, since the real Evnex
 *    sessions endpoint takes no date range (plan §4.4).
 * 4. Already tombstoned -> `dismissed`.
 * 5. No existing row, no energy figure yet (still charging) -> `still_charging`,
 *    NOT inserted. Importing a live session as a draft would immediately hit
 *    rule 6 (`already_complete`) once it stops being null, since that rule
 *    only checks the *existing row's* kWh — so the final figure could never
 *    land. Wait for the session to finish instead.
 * 5b. No existing row, energy figure present -> insert as a draft.
 * 6. Existing row, kWh already set -> `already_complete` (never overwrite a
 *    user-corrected value).
 * 7. Existing row, kWh null, no energy figure yet -> `still_charging`.
 * 8. Existing row, kWh null, energy figure present -> update.
 * 9. The existing row's billing period is already submitted -> overrides the
 *    update from rule 8 with `period_submitted`. (A brand-new insert from
 *    rule 5 has no assigned billing period yet — that assignment happens
 *    downstream via `findBillingPeriodId`, after this function returns, per
 *    plan §6.6 step 8 — so this rule can only actually fire against an
 *    *existing* row's already-known `billingPeriodId`, which is the case
 *    this function has the data to check.)
 *
 * Separately from rules 6–9, an existing row that's still missing its
 * odometer and doesn't yet have the charge's `startedAt`/`endedAt` instants
 * gets them in `backfill` — imports from before those columns existed, and a
 * draft whose `endDate` only arrived on a later poll. The car-odometer match
 * (car-odometer.ts) needs both. Never for a submitted period's row.
 *
 * `kwhUsed === 0` on an *existing* row is still treated as a present value,
 * never as "still charging" (rule 7's presence check is `!= null`, never a
 * bare truthy check) — rule 2 only ever stops a *zero remote reading* from
 * being imported or applied, it never touches an already-stored 0.
 */
export function planImport(
	remote: EvnexSessionPayload[],
	existing: ExistingSessionForImport[],
	dismissed: string[],
	opts: { windowStart: string; timeZone: string; location: string; submittedPeriodIds: number[] }
): PlanImportResult {
	const insert: DraftFromEvnex[] = [];
	const update: { id: number; kwhUsed: number }[] = [];
	const backfill: { id: number; startedAt: string; endedAt: string | null }[] = [];
	const tombstone: string[] = [];
	const skipped: { externalId: string; reason: SkipReason }[] = [];

	const dismissedIds = new Set(dismissed);
	const submittedPeriodIds = new Set(opts.submittedPeriodIds);
	const existingByExternalId = new Map<string, ExistingSessionForImport>();
	for (const row of existing) {
		if (row.externalId != null) existingByExternalId.set(row.externalId, row);
	}

	for (const session of remote) {
		const existingRow = existingByExternalId.get(session.id);

		// Rule 0: unmappable — no startDate, not tombstoned (possibly transient).
		if (session.startDate == null) {
			skipped.push({ externalId: session.id, reason: 'unmappable' });
			continue;
		}

		// Rule 1: Invalid — tombstone always, regardless of anything else below.
		if (session.sessionStatus === 'Invalid') {
			tombstone.push(session.id);
			skipped.push({
				externalId: session.id,
				reason: existingRow ? 'invalid_after_import' : 'invalid'
			});
			continue;
		}

		// Rule 2: zero energy — tombstone always, same treatment as rule 1. A
		// charger blip with no actual power delivered isn't a billable session.
		if (session.energyKwh === 0) {
			tombstone.push(session.id);
			skipped.push({
				externalId: session.id,
				reason: existingRow ? 'zero_energy_after_import' : 'zero_energy'
			});
			continue;
		}

		// Rule 3: outside the lookback window (the real client-side enforcement).
		if (session.startDate < opts.windowStart) {
			skipped.push({ externalId: session.id, reason: 'outside_window' });
			continue;
		}

		// Rule 4: already tombstoned by an earlier poll.
		if (dismissedIds.has(session.id)) {
			skipped.push({ externalId: session.id, reason: 'dismissed' });
			continue;
		}

		// Rule 5: new draft — but not while the session is still charging
		// (no energy figure yet). Importing it now would create a draft that
		// then hits rule 6 (`already_complete`) once it stops being null,
		// since rule 6 only checks the *existing row's* kWh, not the remote
		// session's — so the final figure could never land. Wait for the
		// session to finish instead of importing a partial draft.
		if (!existingRow) {
			if (session.energyKwh == null) {
				skipped.push({ externalId: session.id, reason: 'still_charging' });
				continue;
			}
			insert.push(toDraftSession(session, { timeZone: opts.timeZone, location: opts.location }));
			continue;
		}

		const periodSubmitted =
			existingRow.billingPeriodId != null && submittedPeriodIds.has(existingRow.billingPeriodId);

		// Backfill the charge's instants onto a still-open draft, independent of
		// whether its kWh is settled (rules 6–9 below).
		const endedAt = session.endDate ?? null;
		if (
			existingRow.odometerKm == null &&
			!periodSubmitted &&
			(existingRow.startedAt == null || (existingRow.endedAt == null && endedAt != null))
		) {
			backfill.push({ id: existingRow.id, startedAt: session.startDate, endedAt });
		}

		// Rule 6: never overwrite a kWh value the user may have corrected.
		if (existingRow.kwhUsed != null) {
			skipped.push({ externalId: session.id, reason: 'already_complete' });
			continue;
		}

		// Rule 7: no energy figure yet — still charging (0 was already handled by rule 2).
		if (session.energyKwh == null) {
			skipped.push({ externalId: session.id, reason: 'still_charging' });
			continue;
		}

		// Rule 9: the existing row's billing period is already submitted.
		if (periodSubmitted) {
			skipped.push({ externalId: session.id, reason: 'period_submitted' });
			continue;
		}

		// Rule 8: fill in kWh.
		update.push({ id: existingRow.id, kwhUsed: session.energyKwh });
	}

	return { insert, update, backfill, tombstone, skipped };
}
