import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { evnexIntegration, settings } from '$lib/server/db/schema';
import {
	EvnexMfaRequiredError,
	EvnexNetworkError as EvnexAuthNetworkError,
	EvnexSignInError,
	signIn as evnexSignIn
} from '$lib/server/evnex-auth';
import { fetchChargePoints, fetchOrgId, type EvnexChargePointInfo } from '$lib/server/evnex-client';
import {
	clearCachedChargePoints,
	setCachedChargePoints
} from '$lib/server/evnex-charge-points-cache';

type EvnexIntegrationRow = typeof evnexIntegration.$inferSelect;

async function getIntegration(): Promise<EvnexIntegrationRow | undefined> {
	const [row] = await db.select().from(evnexIntegration).limit(1);
	return row;
}

function eqId(id: number) {
	return eq(evnexIntegration.id, id);
}

// Deliberately does *not* fetch the Evnex charge-point list — that hits the Evnex
// API (token refresh + org lookup + charge-point list) and used to be awaited here,
// blocking the whole page behind a flaky, unofficial third-party API. The page now
// renders with only local DB reads, and the browser fetches
// `/settings/charge-points` itself once the page has mounted (see +page.svelte).
export const load: PageServerLoad = async () => {
	const [settingsRow, integration] = await Promise.all([
		db
			.select()
			.from(settings)
			.limit(1)
			.then((rows) => rows[0]),
		getIntegration()
	]);

	const cardState: 'signed_out' | 'connected' | 'auth_failed' =
		integration?.refreshToken == null
			? 'signed_out'
			: integration.lastPollStatus === 'auth_failed'
				? 'auth_failed'
				: 'connected';

	// Never return accessToken/refreshToken — both are password-equivalent
	// credentials and must never reach the browser (plan §7.1, §5.6).
	return {
		settings: settingsRow ?? null,
		evnex: integration
			? {
					cardState,
					email: integration.email,
					chargePointId: integration.chargePointId,
					chargePointName: integration.chargePointName,
					importLookbackDays: integration.importLookbackDays,
					enabled: integration.enabled,
					lastPolledAt: integration.lastPolledAt,
					lastPollStatus: integration.lastPollStatus,
					lastPollError: integration.lastPollError
				}
			: {
					cardState: 'signed_out' as const,
					email: null,
					chargePointId: null,
					chargePointName: null,
					importLookbackDays: 3,
					enabled: false,
					lastPolledAt: null,
					lastPollStatus: null,
					lastPollError: null
				}
	};
};

export const actions: Actions = {
	save: async ({ request }) => {
		const form = await request.formData();
		const fullName = form.get('fullName')?.toString().trim();
		const vehicleLabel = form.get('vehicleLabel')?.toString().trim();
		const homeAddress = form.get('homeAddress')?.toString().trim() || null;

		if (!fullName) return fail(400, { error: 'Full name is required.' });
		if (!vehicleLabel) return fail(400, { error: 'Vehicle rego/VIN is required.' });

		const [existing] = await db.select().from(settings).limit(1);

		if (existing) {
			await db.update(settings).set({ fullName, vehicleLabel, homeAddress });
		} else {
			await db.insert(settings).values({ fullName, vehicleLabel, homeAddress });
		}

		return { success: true };
	},

	connectEvnex: async ({ request }) => {
		const form = await request.formData();
		const email = form.get('email')?.toString().trim();
		const password = form.get('password')?.toString();

		if (!email || !password) {
			return fail(400, { connectError: 'Enter your Evnex email and password.' });
		}

		let tokenSet;
		try {
			tokenSet = await evnexSignIn(email, password);
		} catch (err) {
			if (err instanceof EvnexMfaRequiredError) {
				return fail(400, { connectError: err.message });
			}
			if (err instanceof EvnexSignInError) {
				return fail(400, {
					connectError: 'Sign-in failed — check the email and password and try again.'
				});
			}
			if (err instanceof EvnexAuthNetworkError) {
				return fail(502, { connectError: 'Could not reach Evnex. Try again in a moment.' });
			}
			return fail(500, { connectError: 'Something went wrong signing in to Evnex.' });
		}
		// Password is never referenced again past this point — nothing below persists it.

		const existing = await getIntegration();

		if (existing) {
			await db
				.update(evnexIntegration)
				.set({
					email,
					accessToken: tokenSet.accessToken,
					refreshToken: tokenSet.refreshToken,
					accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
					lastPollStatus: null,
					lastPollError: null
				})
				.where(eqId(existing.id));
		} else {
			await db.insert(evnexIntegration).values({
				email,
				accessToken: tokenSet.accessToken,
				refreshToken: tokenSet.refreshToken,
				accessTokenExpiresAt: tokenSet.accessTokenExpiresAt
			});
		}

		// Single-row table (like `settings`) — re-fetch to get a real id regardless of
		// whether the row above was just inserted or updated, rather than juggling
		// better-sqlite3's `.returning()` support through drizzle for one extra id.
		const integrationRow = await getIntegration();
		if (!integrationRow) {
			return fail(500, {
				connectError: 'Signed in, but the integration row could not be saved.'
			});
		}

		let chargePoints: EvnexChargePointInfo[];
		try {
			const orgId = await fetchOrgId(tokenSet.accessToken);
			await db.update(evnexIntegration).set({ orgId }).where(eqId(integrationRow.id));
			chargePoints = await fetchChargePoints(tokenSet.accessToken, orgId);
			// Populate the cache /settings/charge-points reads from, so the browser's
			// own fetch right after this action lands (once cardState flips to
			// 'connected') replays this result instead of hitting Evnex again.
			setCachedChargePoints({ chargePoints, chargePointsError: null });
		} catch (err) {
			// Sign-in itself succeeded and is already persisted above; the charge-point
			// list can be retried by the browser's own fetch to
			// /settings/charge-points once the page re-renders connected. Surface the
			// real error rather than a generic string — see the matching comment in
			// that endpoint's catch block for why.
			console.error('[evnex] connectEvnex charge-point list failed:', err);
			const detail = err instanceof Error ? err.message : String(err);
			return {
				connected: true,
				chargePoints: [],
				connectWarning: `Signed in, but could not list charge points yet: ${detail}`
			};
		}

		return { connected: true, chargePoints };
	},

	saveEvnex: async ({ request }) => {
		const form = await request.formData();
		const existing = await getIntegration();
		if (!existing || existing.refreshToken == null) {
			return fail(400, { saveError: 'Connect an Evnex account first.' });
		}

		const chargePointId = form.get('chargePointId')?.toString();
		const chargePointName = form.get('chargePointName')?.toString();
		const chargePointTimeZone = form.get('chargePointTimeZone')?.toString();
		const importLookbackDaysRaw = form.get('importLookbackDays')?.toString();
		const enabled = form.get('enabled') === 'true';

		if (!chargePointId || !chargePointName) {
			return fail(400, { saveError: 'Choose a charge point.' });
		}
		// Timezone is load-bearing (plan §6.3): a session imported without one can't be
		// converted to a local date/time correctly. Refuse to save rather than silently
		// storing an empty string that would corrupt every session date later.
		if (!chargePointTimeZone) {
			return fail(400, {
				saveError:
					"Evnex didn't report a timezone for this charge point, so it can't be used yet — this needs investigating before the integration is safe to enable."
			});
		}

		const importLookbackDays = importLookbackDaysRaw ? Number(importLookbackDaysRaw) : NaN;
		if (!Number.isInteger(importLookbackDays) || importLookbackDays < 1) {
			return fail(400, { saveError: 'Enter a whole number of days, 1 or more.' });
		}

		await db
			.update(evnexIntegration)
			.set({ chargePointId, chargePointName, chargePointTimeZone, importLookbackDays, enabled })
			.where(eqId(existing.id));

		return { savedEvnex: true };
	},

	disconnectEvnex: async () => {
		const existing = await getIntegration();
		if (!existing) return { disconnected: true };

		// Clears the credential (refresh token) and email, but leaves the charge point
		// selection and lookback setting intact so reconnecting doesn't mean
		// reconfiguring (plan §5.6).
		await db
			.update(evnexIntegration)
			.set({
				email: null,
				accessToken: null,
				refreshToken: null,
				accessTokenExpiresAt: null,
				lastPollStatus: null,
				lastPollError: null
			})
			.where(eqId(existing.id));

		// So a later reconnect (possibly a different Evnex account) doesn't briefly
		// show the previous account's cached charge points.
		clearCachedChargePoints();

		return { disconnected: true };
	}
};
